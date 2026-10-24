"""CaptionVAR multi-agent workflow (Microsoft Agent Framework).

One workflow run per captioned moment:

    Narrator ──► Extractor ──► Referee ──┬─(passes, or out of retries)──► Publisher
       (LLM)       (LLM)      (code)     │
                     ▲                   └─(fails)──► Editor (LLM) ─┐
                     └──────────────────────────────────────────────┘

* Narrator   writes the caption from the moment's facts (optionally told by
             the red team to plant one specific error).
* Extractor  turns the caption into structured claims. It never sees the
             facts, so it reports what was said, not what is true.
* Referee    deterministic VAR check in the factbox: each claim against only
             the events observed so far. Not a model.
* Editor     rewrites a failed caption from the verdict and the true facts;
             the rewrite goes back through Extractor and Referee.
* Publisher  airs the first version that passes. If none does within the
             retry budget, it airs a template rendered from the true facts.
"""
import asyncio
import json
import random
from dataclasses import dataclass, field
from typing import Any

from agent_framework import Agent, Executor, WorkflowBuilder, WorkflowContext, handler
from typing_extensions import Never

from . import prompts
from .factbox import Factbox

MAX_EDITS = 2


# ------------------------------------------------------------------ messages


@dataclass
class MomentTask:
    index: int
    packet: dict
    plant: str | None


@dataclass
class Draft:
    index: int
    text: str
    attempt: int
    author: str
    plant: str | None
    history: list = field(default_factory=list)


@dataclass
class Extracted:
    draft: Draft
    claims: list


@dataclass
class Checked:
    draft: Draft
    result: dict  # {claims, segments, verdict}

    @property
    def status(self) -> str:
        return self.result["verdict"]["status"]


# --------------------------------------------------------------------- usage


@dataclass
class Usage:
    calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    throttled: int = 0
    by_agent: dict = field(default_factory=dict)

    def merge(self, other: "Usage | dict") -> None:
        o = other if isinstance(other, dict) else other.as_dict()
        self.calls += o["calls"]
        self.input_tokens += o["input_tokens"]
        self.output_tokens += o["output_tokens"]
        self.throttled += o.get("throttled", 0)
        for name, a in o.get("by_agent", {}).items():
            mine = self.by_agent.setdefault(name, {"calls": 0, "input_tokens": 0, "output_tokens": 0})
            for k in mine:
                mine[k] += a[k]

    def as_dict(self) -> dict:
        return {"calls": self.calls, "input_tokens": self.input_tokens, "output_tokens": self.output_tokens,
                "throttled": self.throttled, "by_agent": self.by_agent}

    def add(self, agent: str, response: Any) -> None:
        u = getattr(response, "usage_details", None) or {}
        i, o = u.get("input_token_count") or 0, u.get("output_token_count") or 0
        self.calls += 1
        self.input_tokens += i
        self.output_tokens += o
        a = self.by_agent.setdefault(agent, {"calls": 0, "input_tokens": 0, "output_tokens": 0})
        a["calls"] += 1
        a["input_tokens"] += i
        a["output_tokens"] += o


# ------------------------------------------------------- rate limits & retry


class RateLimiter:
    """Spaces model calls evenly so a run stays under the deployment's requests-per-minute."""

    def __init__(self, rpm: float | None) -> None:
        self.interval = 60.0 / rpm if rpm else 0.0
        self._next = 0.0
        self._lock = asyncio.Lock()

    async def wait(self) -> None:
        if not self.interval:
            return
        async with self._lock:
            loop = asyncio.get_running_loop()
            now = loop.time()
            delay = max(0.0, self._next - now)
            self._next = max(now, self._next) + self.interval
        if delay:
            await asyncio.sleep(delay)


LIMITER = RateLimiter(None)
MAX_RETRIES = 8
RETRY_BASE_S = 2.0


def is_rate_limited(exc: BaseException) -> bool:
    text = repr(exc)
    return "429" in text or "rate_limit" in text.lower() or "RateLimitError" in text


def retry_after_seconds(exc: BaseException) -> float | None:
    """Read Retry-After from the underlying HTTP response, if the SDK kept it."""
    seen = set()
    e: BaseException | None = exc
    while e is not None and id(e) not in seen:
        seen.add(id(e))
        response = getattr(e, "response", None)
        headers = getattr(response, "headers", None)
        if headers:
            for key, scale in (("retry-after-ms", 0.001), ("retry-after", 1.0)):
                value = headers.get(key)
                if value:
                    try:
                        return float(value) * scale
                    except ValueError:
                        pass
        e = e.__cause__ or e.__context__
    return None


async def ask(agent: Agent, usage: Usage, payload: Any, **options: Any) -> Any:
    prompt = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False, indent=1)
    for attempt in range(MAX_RETRIES + 1):
        await LIMITER.wait()
        try:
            response = await agent.run(prompt, options=options or None)
            break
        except Exception as exc:  # noqa: BLE001 - only rate limits are retried
            if not is_rate_limited(exc) or attempt == MAX_RETRIES:
                raise
            wait = retry_after_seconds(exc) or min(60.0, RETRY_BASE_S * 2 ** attempt)
            usage.throttled += 1
            print(f"    rate limited ({agent.name}); waiting {wait:.0f}s, retry {attempt + 1}/{MAX_RETRIES}", flush=True)
            await asyncio.sleep(wait)
    usage.add(agent.name, response)
    return response


def clean(text: str) -> str:
    return text.strip().strip('"').strip("“”").strip()


# ----------------------------------------------------------------- executors


class NarratorExecutor(Executor):
    def __init__(self, agent: Agent, usage: Usage) -> None:
        super().__init__(id="narrator")
        self.agent, self.usage = agent, usage

    @handler
    async def write(self, task: MomentTask, ctx: WorkflowContext[Draft]) -> None:
        payload: Any = {"moment": task.packet}
        if task.plant and task.plant in prompts.RED_TEAM:
            payload["red_team_instruction"] = (
                "For this caption only, include exactly one plausible but FALSE detail: "
                + prompts.RED_TEAM[task.plant]
                + " Keep everything else accurate."
            )
        response = await ask(self.agent, self.usage, payload, temperature=0.8)
        await ctx.send_message(Draft(task.index, clean(response.text), 0, "narrator", task.plant))


class ExtractorExecutor(Executor):
    def __init__(self, agent: Agent, factbox: Factbox, usage: Usage) -> None:
        super().__init__(id="extractor")
        self.agent, self.factbox, self.usage = agent, factbox, usage

    @handler
    async def extract(self, draft: Draft, ctx: WorkflowContext[Extracted]) -> None:
        packet = await self.factbox.call("extractor_packet", index=draft.index, text=draft.text)
        response = await ask(self.agent, self.usage, packet, response_format=prompts.Extraction, temperature=0)
        value = response.value or prompts.Extraction.model_validate_json(response.text)
        claims = [c.model_dump() for c in value.claims]
        await ctx.send_message(Extracted(draft, claims))


class RefereeExecutor(Executor):
    """The VAR check. Deterministic code, not a model."""

    def __init__(self, factbox: Factbox) -> None:
        super().__init__(id="referee")
        self.factbox = factbox

    @handler
    async def check(self, item: Extracted, ctx: WorkflowContext[Checked]) -> None:
        result = await self.factbox.call("verify", index=item.draft.index, text=item.draft.text, extracted=item.claims)
        item.draft.history.append({
            "attempt": item.draft.attempt,
            "author": item.draft.author,
            "text": item.draft.text,
            "status": result["verdict"]["status"],
            "extracted": item.claims,
            # Why this version did not pass, so a reviewer can see what each rewrite fixed.
            "flags": [
                {"span": c.get("span"), "status": c["status"], "note": c.get("note")}
                for c in result["verdict"]["claims"] if c["status"] != "supported"
            ],
        })
        await ctx.send_message(Checked(item.draft, result))


class EditorExecutor(Executor):
    def __init__(self, agent: Agent, factbox: Factbox, usage: Usage) -> None:
        super().__init__(id="editor")
        self.agent, self.factbox, self.usage = agent, factbox, usage

    @handler
    async def rewrite(self, checked: Checked, ctx: WorkflowContext[Draft]) -> None:
        d = checked.draft
        packet = await self.factbox.call("editor_packet", index=d.index, text=d.text, verdict=checked.result["verdict"])
        response = await ask(self.agent, self.usage, packet, temperature=0.3)
        await ctx.send_message(Draft(d.index, clean(response.text), d.attempt + 1, "editor", d.plant, d.history))


class PublisherExecutor(Executor):
    def __init__(self, factbox: Factbox) -> None:
        super().__init__(id="publisher")
        self.factbox = factbox

    @handler
    async def publish(self, checked: Checked, ctx: WorkflowContext[Never, dict]) -> None:
        d = checked.draft
        if checked.status == "VERIFY":
            aired = {"text": d.text, "by": d.author, "verified": True}
        else:
            fallback = await self.factbox.call("template", index=d.index, verdict=checked.result["verdict"])
            aired = {"text": fallback["text"], "by": "template", "verified": True}
        await ctx.yield_output({"history": d.history, "aired": aired, "plant": d.plant})


def needs_edit(msg: Any) -> bool:
    return isinstance(msg, Checked) and msg.status != "VERIFY" and msg.draft.attempt < MAX_EDITS


def ready_to_air(msg: Any) -> bool:
    return isinstance(msg, Checked) and not needs_edit(msg)


def build_workflow(narrator: Agent, extractor: Agent, editor: Agent, factbox: Factbox, usage: Usage):
    n = NarratorExecutor(narrator, usage)
    x = ExtractorExecutor(extractor, factbox, usage)
    r = RefereeExecutor(factbox)
    e = EditorExecutor(editor, factbox, usage)
    p = PublisherExecutor(factbox)
    return (
        WorkflowBuilder(start_executor=n, name="captionvar", description="Narrate, extract, VAR check, edit, publish")
        .add_edge(n, x)
        .add_edge(x, r)
        .add_edge(r, e, condition=needs_edit)
        .add_edge(r, p, condition=ready_to_air)
        .add_edge(e, x)
        .build()
    )


def make_agents(client: Any) -> tuple[Agent, Agent, Agent]:
    from .prompts import EXTRACTOR, EDITOR, NARRATOR
    kinds = "\n".join(f"- {k}: {v}" for k, v in KIND_DOCS.items())
    narrator = Agent(client, NARRATOR, name="narrator", description="Writes live captions from moment facts")
    extractor = Agent(client, EXTRACTOR.format(kinds=kinds), name="extractor", description="Extracts checkable claims; blind to the facts")
    editor = Agent(client, EDITOR, name="editor", description="Repairs captions that failed the VAR check")
    return narrator, extractor, editor


# Kept in sync with src/broadcast/extracted.js (EXTRACTABLE_KINDS).
KIND_DOCS = {
    "goal_scorer": "A named player scored a goal.",
    "goal_assist": "A named player assisted / set up the goal.",
    "score": "The scoreline (home and away goals).",
    "goal_from_press": "The goal came from pressing / winning the ball back high up.",
    "scorer_tally": "How many goals the scorer has now (e.g. 'his second').",
    "shot_player": "A named player took the shot / had the chance.",
    "shot_outcome": "What happened to the shot: goal, saved, off_target, blocked, woodwork.",
    "shot_xg": "The expected-goals (xG) value of the chance.",
    "card_player": "A named player was booked.",
    "substitution": "A named player came on and another went off.",
    "top_speed": "A player reached a speed in km/h.",
    "distance": "A player has covered a distance in km.",
    "final_third_recoveries": "How many times a team won the ball back in the final third in the recent window.",
    "recoveries_after_press": "How many of those recoveries came straight after pressing.",
    "possession": "A team's share of possession in percent.",
    "pass_accuracy": "A team's pass completion in percent.",
    "recent_action": "Something a named player (or a team) did in the build-up: a foul, winning the ball, pressing, a pass, a run with the ball, losing the ball, a shot, a save, a block or a tackle.",
    "opinion": "A judgement, comparison or superlative that match data cannot confirm.",
    "other_fact": "Any other factual assertion not covered above.",
}


# ---------------------------------------------------------------- red team


def plan_red_team(packets: list[dict], rate: float, seed: str) -> dict[int, str]:
    """Pick which moments get a planted error and of which kind (reproducible)."""
    rng = random.Random(seed)
    plan = {}
    for p in packets:
        options = list(prompts.RED_TEAM_BY_TYPE.get(p["moment_type"], []))
        if p["moment_type"] == "goal" and p["facts"].get("move_started_with_press"):
            options.remove("invented_cause")
        if options and rng.random() < rate:
            plan[p["index"]] = rng.choice(options)
    return plan


# -------------------------------------------------------------------- run


async def run_moment(index: int, packet: dict, plant: str | None, agents: tuple, factbox: Factbox, usage: Usage) -> dict:
    workflow = build_workflow(*agents, factbox, usage)
    events = await workflow.run(MomentTask(index, packet, plant))
    outputs = events.get_outputs()
    if not outputs:
        raise RuntimeError(f"moment {index}: workflow produced no output")
    return outputs[-1]


async def assemble_decision(index: int, out: dict, factbox: Factbox) -> dict:
    """Shape a workflow result into the trace format the UI consumes."""
    first = out["history"][0]
    header = await factbox.call("decision_header", index=index)
    checked = await factbox.call("verify", index=index, text=first["text"], extracted=first["extracted"])
    return {
        "id": f"CAP-{index + 1:03d}",
        **header,
        "segments": checked["segments"],
        "claims": checked["claims"],
        "verdict": checked["verdict"],
        "planted_error": {"kind": out["plant"]} if out["plant"] else None,
        "aired": out["aired"],
        "attempts": [{k: h.get(k) for k in ("attempt", "author", "text", "status", "flags")} for h in out["history"]],
    }
