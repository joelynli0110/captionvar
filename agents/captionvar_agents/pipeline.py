"""CaptionVAR multi-agent workflow (Microsoft Agent Framework).

One workflow run per captioned moment:

    Narrator ──► Extractor ──► Referee ──┬─(passes, or out of retries)──► Publisher ──► Analyst ─┐
       (LLM)       (LLM)      (code)     │                                              (LLM)    │
                     ▲  ▲                └─(fails)──► Editor (LLM) ─┐                            │
                     │  └───────────────────────────────────────────┘                            │
                     └───────────── the Analyst's "why it matters" line takes the same path ─────┘
                                    (Line editor on a fail, Line publisher at the end)

and one per recap (half-time, full time), where each sentence of the Recap
writer goes through Extractor and Referee on its own:

    Recap writer ──► Extractor ──► Referee ──┬──► Line publisher
       (LLM)           (LLM)       (code)    └──► Line editor (LLM) ──► Extractor

* Narrator   writes the caption from the moment's facts (optionally told by
             the red team to plant one specific error).
* Extractor  turns the caption into structured claims. It never sees the
             facts, so it reports what was said, not what is true.
* Referee    deterministic VAR check, called as the `check_caption` tool of
             the referee MCP server (scripts/referee-mcp.mjs): each claim
             against only the events observed so far. Not a model.
* Editor     rewrites a failed caption from the verdict and the true facts;
             the rewrite goes back through Extractor and Referee.
* Publisher  airs the first version that passes. If none does within the
             retry budget, it airs a template rendered from the true facts.
             For key moments it then hands the aired caption to the Analyst.
* Analyst    writes one line on why the moment matters, from running numbers
             (totals, xG, minutes since the last shot on target, recent possession).
* Recap writer  writes the half-time and full-time recaps as separate sentences.
* Line editor   rewrites a failed line or recap sentence once.
* Line publisher  airs a line or sentence only if it passed; otherwise it is
             dropped. A caption always airs; context is optional.
"""
import asyncio
import json
import random
import time
from dataclasses import dataclass, field
from typing import Any

from agent_framework import Agent, Executor, WorkflowBuilder, WorkflowContext, handler
from opentelemetry import trace
from typing_extensions import Never

from . import prompts
from .factbox import Factbox

MAX_EDITS = 2
# Lines of context and recap sentences get one rewrite, then are dropped.
MAX_LINE_EDITS = 1

# OpenTelemetry. A no-op unless run_match.py --trace sets up an exporter, in
# which case each caption becomes one trace in Foundry: the caption span holds
# the workflow, its executors and every model call, and the referee's verdict
# is recorded on its executor span.
TRACER = trace.get_tracer("captionvar")


# ------------------------------------------------------------------ messages


@dataclass
class MomentTask:
    index: int
    packet: dict
    plant: str | None
    # A line of context follows the caption for key moments.
    insight: bool = False
    insight_plant: str | None = None


@dataclass
class AnalystTask:
    index: int
    caption: str
    plant: str | None


@dataclass
class RecapTask:
    recap: str  # "HT" or "FT"
    plant: str | None


@dataclass
class Draft:
    index: int | None
    text: str
    attempt: int
    author: str
    plant: str | None
    history: list = field(default_factory=list)
    # What is being written: a caption, a "why it matters" line, or a recap sentence.
    scope: str = "caption"
    recap: str | None = None
    part: int = 0
    followup: AnalystTask | None = None

    def where(self) -> dict:
        """Arguments that tell the referee what this draft is checked against."""
        where = {"scope": self.scope}
        if self.index is not None:
            where["index"] = self.index
        if self.recap:
            where["recap"] = self.recap
        return where


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
    # Replies that did not parse as the required structured output (retried).
    invalid_outputs: int = 0
    by_agent: dict = field(default_factory=dict)
    # Seconds spent in model calls, in the referee, and waiting on our own rate
    # limiter or a 429 back-off. The last is an artefact of a small deployment
    # quota, so time-to-air leaves it out.
    model_s: float = 0.0
    referee_s: float = 0.0
    throttle_s: float = 0.0

    def merge(self, other: "Usage | dict") -> None:
        o = other if isinstance(other, dict) else other.as_dict()
        self.calls += o["calls"]
        self.input_tokens += o["input_tokens"]
        self.output_tokens += o["output_tokens"]
        self.throttled += o.get("throttled", 0)
        self.invalid_outputs += o.get("invalid_outputs", 0)
        self.model_s += o.get("model_s", 0.0)
        self.referee_s += o.get("referee_s", 0.0)
        self.throttle_s += o.get("throttle_s", 0.0)
        for name, a in o.get("by_agent", {}).items():
            mine = self.by_agent.setdefault(name, {"calls": 0, "input_tokens": 0, "output_tokens": 0})
            for k in mine:
                mine[k] += a[k]

    def as_dict(self) -> dict:
        return {"calls": self.calls, "input_tokens": self.input_tokens, "output_tokens": self.output_tokens,
                "throttled": self.throttled, "invalid_outputs": self.invalid_outputs, "by_agent": self.by_agent,
                "model_s": round(self.model_s, 3), "referee_s": round(self.referee_s, 4), "throttle_s": round(self.throttle_s, 3)}

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
        waited = time.perf_counter()
        await LIMITER.wait()
        usage.throttle_s += time.perf_counter() - waited
        started = time.perf_counter()
        try:
            response = await agent.run(prompt, options=options or None)
            usage.model_s += time.perf_counter() - started
            break
        except Exception as exc:  # noqa: BLE001 - only rate limits are retried
            if not is_rate_limited(exc) or attempt == MAX_RETRIES:
                raise
            wait = retry_after_seconds(exc) or min(60.0, RETRY_BASE_S * 2 ** attempt)
            usage.throttled += 1
            print(f"    rate limited ({agent.name}); waiting {wait:.0f}s, retry {attempt + 1}/{MAX_RETRIES}", flush=True)
            # The failed call's own time counts as throttling too.
            usage.throttle_s += time.perf_counter() - started + wait
            await asyncio.sleep(wait)
    usage.add(agent.name, response)
    return response


STRUCTURED_RETRIES = 2


def is_invalid_output(exc: BaseException) -> bool:
    text = str(exc)
    return "validation error" in text or "Invalid JSON" in text or "json_invalid" in text


async def ask_structured(agent: Agent, usage: Usage, payload: Any, model: type, **options: Any) -> Any | None:
    """A structured reply, retried when the model returns JSON that does not parse
    (seen with gpt-4.1-nano). Returns None if every try fails, so the caller can
    fail closed instead of stopping the run."""
    for attempt in range(STRUCTURED_RETRIES + 1):
        try:
            response = await ask(agent, usage, payload, response_format=model, **options)
            return response.value or model.model_validate_json(response.text)
        except Exception as exc:  # noqa: BLE001 - only unparseable replies are retried
            if not is_invalid_output(exc):
                raise
            usage.invalid_outputs += 1
            print(f"    {agent.name} returned output that does not parse; "
                  f"{'retrying' if attempt < STRUCTURED_RETRIES else 'giving up'} ({attempt + 1}/{STRUCTURED_RETRIES + 1})", flush=True)
    return None


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
        followup = AnalystTask(task.index, "", task.insight_plant) if task.insight else None
        await ctx.send_message(Draft(task.index, clean(response.text), 0, "narrator", task.plant, followup=followup))


def red_team_line(menu: dict, plant: str | None) -> dict:
    if not plant or plant not in menu:
        return {}
    return {"red_team_instruction": "For this text only, include exactly one plausible but FALSE detail: "
            + menu[plant] + " Keep everything else accurate."}


class AnalystExecutor(Executor):
    """Writes why a moment matters, after its caption has aired."""

    def __init__(self, agent: Agent, factbox: Factbox, usage: Usage) -> None:
        super().__init__(id="analyst")
        self.agent, self.factbox, self.usage = agent, factbox, usage

    @handler
    async def write(self, task: AnalystTask, ctx: WorkflowContext[Draft]) -> None:
        packet = await self.factbox.call("analyst_packet", index=task.index, caption=task.caption)
        payload = {**packet, **red_team_line(prompts.RED_TEAM_INSIGHT, task.plant)}
        response = await ask(self.agent, self.usage, payload, temperature=0.7)
        await ctx.send_message(Draft(task.index, clean(response.text), 0, "analyst", task.plant, scope="insight"))


class RecapWriterExecutor(Executor):
    """Writes a recap as separate sentences; each is checked on its own."""

    def __init__(self, agent: Agent, factbox: Factbox, usage: Usage) -> None:
        super().__init__(id="recap_writer")
        self.agent, self.factbox, self.usage = agent, factbox, usage

    @handler
    async def write(self, task: RecapTask, ctx: WorkflowContext[Draft, dict]) -> None:
        packet = await self.factbox.call("recap_packet", recap=task.recap)
        payload = {**packet, **red_team_line(prompts.RED_TEAM_RECAP, task.plant)}
        value = await ask_structured(self.agent, self.usage, payload, prompts.Recap, temperature=0.6)
        if value is None:
            raise RuntimeError(f"recap {task.recap}: the recap writer's reply never parsed")
        sentences = [clean(t) for t in value.sentences if clean(t)]
        # Which sentence carries the plant is ground truth for scoring only; the checkers never see it.
        await ctx.yield_output({"kind": "recap_plan", "recap": task.recap, "sentences": sentences,
                                "planted_sentence": value.planted_sentence if task.plant else None})
        for i, text in enumerate(sentences):
            await ctx.send_message(Draft(None, text, 0, "recap_writer", task.plant, scope="recap", recap=task.recap, part=i))


class ExtractorExecutor(Executor):
    def __init__(self, agent: Agent, factbox: Factbox, usage: Usage) -> None:
        super().__init__(id="extractor")
        self.agent, self.factbox, self.usage = agent, factbox, usage

    @handler
    async def extract(self, draft: Draft, ctx: WorkflowContext[Extracted]) -> None:
        packet = await self.factbox.call("extractor_packet", text=draft.text, **draft.where())
        value = await ask_structured(self.agent, self.usage, packet, prompts.Extraction, temperature=0)
        # No parseable extraction = no checkable claim, and the referee fails
        # closed on that: the caption is rewritten or airs from the data.
        claims = [c.model_dump() for c in value.claims] if value else []
        await ctx.send_message(Extracted(draft, claims))


class RefereeExecutor(Executor):
    """The VAR check. Deterministic code, not a model."""

    def __init__(self, factbox: Factbox, usage: Usage) -> None:
        super().__init__(id="referee")
        self.factbox, self.usage = factbox, usage

    @handler
    async def check(self, item: Extracted, ctx: WorkflowContext[Checked]) -> None:
        started = time.perf_counter()
        result = await self.factbox.call("verify", text=item.draft.text, extracted=item.claims, **item.draft.where())
        self.usage.referee_s += time.perf_counter() - started
        claims = result["verdict"]["claims"]
        trace.get_current_span().set_attributes({
            "captionvar.scope": item.draft.scope,
            "captionvar.attempt": item.draft.attempt,
            "captionvar.author": item.draft.author,
            "captionvar.verdict": result["verdict"]["status"],
            "captionvar.claims": len(claims),
            "captionvar.claims_false": sum(c["status"] == "contradicted" for c in claims),
            "captionvar.claims_unchecked": sum(c["status"] == "unverifiable" for c in claims),
            "captionvar.evidence": ",".join(result["verdict"].get("evidence", [])),
        })
        item.draft.history.append({
            "attempt": item.draft.attempt,
            "author": item.draft.author,
            "text": item.draft.text,
            "status": result["verdict"]["status"],
            "extracted": item.claims,
            # Why this version did not pass, so a reviewer can see what each rewrite fixed.
            "flags": [
                {"span": c.get("span"), "status": c["status"], "note": c.get("note")}
                for c in result["verdict"]["claims"] if c["status"] != "supported" and not c.get("framing")
            ],
            "verdict": result["verdict"],
            "segments": result["segments"],
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
        await ctx.send_message(Draft(d.index, clean(response.text), d.attempt + 1, "editor", d.plant, d.history, followup=d.followup))


class LineEditorExecutor(Executor):
    """Rewrites a failed line of context or recap sentence, once."""

    def __init__(self, agent: Agent, factbox: Factbox, usage: Usage) -> None:
        super().__init__(id="line_editor")
        self.agent, self.factbox, self.usage = agent, factbox, usage

    @handler
    async def rewrite(self, checked: Checked, ctx: WorkflowContext[Draft]) -> None:
        d = checked.draft
        packet = await self.factbox.call("line_editor_packet", text=d.text, verdict=checked.result["verdict"], **d.where())
        response = await ask(self.agent, self.usage, packet, temperature=0.3)
        await ctx.send_message(Draft(d.index, clean(response.text), d.attempt + 1, "line_editor", d.plant, d.history,
                                     scope=d.scope, recap=d.recap, part=d.part))


def clock(usage: Usage) -> dict:
    """When an output aired, and the time spent so far, for time-to-air."""
    return {"at": time.perf_counter(), "throttle_s": usage.throttle_s, "model_s": usage.model_s,
            "referee_s": usage.referee_s, "calls": usage.calls}


class PublisherExecutor(Executor):
    def __init__(self, factbox: Factbox, usage: Usage) -> None:
        super().__init__(id="publisher")
        self.factbox, self.usage = factbox, usage

    @handler
    async def publish(self, checked: Checked, ctx: WorkflowContext[AnalystTask, dict]) -> None:
        d = checked.draft
        if checked.status == "VERIFY":
            aired = {"text": d.text, "by": d.author, "verified": True}
        else:
            fallback = await self.factbox.call("template", index=d.index, verdict=checked.result["verdict"])
            aired = {"text": fallback["text"], "by": "template", "verified": True}
        await ctx.yield_output({"kind": "caption", "history": d.history, "aired": aired, "plant": d.plant, "clock": clock(self.usage)})
        # Hand-off: the Analyst explains the moment the viewer has just seen.
        if d.followup:
            await ctx.send_message(AnalystTask(d.index, aired["text"], d.followup.plant))


class LinePublisherExecutor(Executor):
    """Airs a line of context or a recap sentence only if it passed."""

    def __init__(self, usage: Usage) -> None:
        super().__init__(id="line_publisher")
        self.usage = usage

    @handler
    async def publish(self, checked: Checked, ctx: WorkflowContext[Never, dict]) -> None:
        d = checked.draft
        aired = {"text": d.text, "by": d.author, "verified": True} if checked.status == "VERIFY" else None
        await ctx.yield_output({"kind": d.scope, "recap": d.recap, "part": d.part, "history": d.history,
                                "aired": aired, "plant": d.plant, "clock": clock(self.usage)})


def max_edits(draft: Draft) -> int:
    return MAX_EDITS if draft.scope == "caption" else MAX_LINE_EDITS


def needs_edit(msg: Any) -> bool:
    return isinstance(msg, Checked) and msg.status != "VERIFY" and msg.draft.attempt < max_edits(msg.draft)


def ready_to_air(msg: Any) -> bool:
    return isinstance(msg, Checked) and not needs_edit(msg)


def is_caption(msg: Any) -> bool:
    return msg.draft.scope == "caption"


def caption_needs_edit(msg: Any) -> bool:
    return needs_edit(msg) and is_caption(msg)


def line_needs_edit(msg: Any) -> bool:
    return needs_edit(msg) and not is_caption(msg)


def caption_ready(msg: Any) -> bool:
    return ready_to_air(msg) and is_caption(msg)


def line_ready(msg: Any) -> bool:
    return ready_to_air(msg) and not is_caption(msg)


@dataclass
class Agents:
    narrator: Agent
    extractor: Agent
    editor: Agent
    analyst: Agent
    recap_writer: Agent
    line_editor: Agent


def build_workflow(agents: Agents, factbox: Factbox, usage: Usage):
    """Caption, then (for key moments) a checked line on why it matters."""
    n = NarratorExecutor(agents.narrator, usage)
    x = ExtractorExecutor(agents.extractor, factbox, usage)
    r = RefereeExecutor(factbox, usage)
    e = EditorExecutor(agents.editor, factbox, usage)
    p = PublisherExecutor(factbox, usage)
    a = AnalystExecutor(agents.analyst, factbox, usage)
    le = LineEditorExecutor(agents.line_editor, factbox, usage)
    lp = LinePublisherExecutor(usage)
    return (
        WorkflowBuilder(start_executor=n, name="captionvar", description="Narrate, extract, VAR check, edit, publish, explain")
        .add_edge(n, x)
        .add_edge(x, r)
        .add_edge(r, e, condition=caption_needs_edit)
        .add_edge(r, p, condition=caption_ready)
        .add_edge(e, x)
        .add_edge(p, a)
        .add_edge(a, x)
        .add_edge(r, le, condition=line_needs_edit)
        .add_edge(r, lp, condition=line_ready)
        .add_edge(le, x)
        .build()
    )


def build_recap_workflow(agents: Agents, factbox: Factbox, usage: Usage):
    """A recap, every sentence checked on its own."""
    w = RecapWriterExecutor(agents.recap_writer, factbox, usage)
    x = ExtractorExecutor(agents.extractor, factbox, usage)
    r = RefereeExecutor(factbox, usage)
    le = LineEditorExecutor(agents.line_editor, factbox, usage)
    lp = LinePublisherExecutor(usage)
    return (
        WorkflowBuilder(start_executor=w, name="captionvar-recap", description="Write a recap, check each sentence, edit, publish")
        .add_edge(w, x)
        .add_edge(x, r)
        .add_edge(r, le, condition=line_needs_edit)
        .add_edge(r, lp, condition=line_ready)
        .add_edge(le, x)
        .build()
    )


def make_agents(client: Any) -> Agents:
    from .prompts import ANALYST, EDITOR, EXTRACTOR, LINE_EDITOR, NARRATOR, RECAP_WRITER
    kinds = "\n".join(f"- {k}: {v}" for k, v in KIND_DOCS.items())
    return Agents(
        narrator=Agent(client, NARRATOR, name="narrator", description="Writes live captions from moment facts"),
        extractor=Agent(client, EXTRACTOR.format(kinds=kinds), name="extractor", description="Extracts checkable claims; blind to the facts"),
        editor=Agent(client, EDITOR, name="editor", description="Repairs captions that failed the VAR check"),
        analyst=Agent(client, ANALYST, name="analyst", description="Explains why a moment matters from running numbers"),
        recap_writer=Agent(client, RECAP_WRITER, name="recap_writer", description="Writes half-time and full-time recaps"),
        line_editor=Agent(client, LINE_EDITOR, name="line_editor", description="Repairs a line of context or recap sentence once"),
    )


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
    "team_total": "A team's running total so far in the match (metric: goals, shots, shots_on_target, xg, corners, fouls, yellow_cards, final_third_recoveries).",
    "player_total": "A player's running total so far in the match (metric: goals, assists, shots, recoveries, pressures, passes_completed).",
    "minutes_since": "How many minutes since the team's previous shot, shot_on_target or goal (metric), e.g. 'their first shot on target in 20 minutes'.",
    "recent_possession": "A team's share of possession in percent over the last 10 minutes.",
    "goal_event": "A goal scored earlier: who scored (player_id), who assisted (other_player_id) and at which minute (number), as far as stated.",
    "card_event": "A player booked earlier in the match.",
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


def plan_line_red_team(keys: list, menu: dict, rate: float, seed: str) -> dict:
    """The same for lines of context (keyed by moment index) or recaps (keyed by "HT"/"FT")."""
    rng = random.Random(seed)
    options = sorted(menu)
    return {k: rng.choice(options) for k in keys if rng.random() < rate}


# -------------------------------------------------------------------- run


def timing_since(start: dict, end: dict) -> dict:
    """Time from a run's start to an output airing, without rate-limit waits.

    Moments are captioned one at a time, so nothing else competes for the time
    measured here: it is the model calls, the referee and the workflow itself.
    """
    throttle = end["throttle_s"] - start["throttle_s"]
    return {
        "time_to_air_s": round(max(0.0, end["at"] - start["at"] - throttle), 2),
        "model_s": round(end["model_s"] - start["model_s"], 2),
        "referee_ms": round((end["referee_s"] - start["referee_s"]) * 1000, 1),
        "model_calls": end["calls"] - start["calls"],
        "throttle_s": round(throttle, 2),
    }


async def run_moment(index: int, packet: dict, plant: str | None, agents: Agents, factbox: Factbox, usage: Usage,
                     insight: bool = False, insight_plant: str | None = None) -> dict:
    """Caption one moment (and, for key moments, explain it). Returns the caption and the line of context."""
    with TRACER.start_as_current_span(f"caption {packet['minute']} {packet['moment_type']}") as span:
        span.set_attributes({
            "captionvar.moment_index": index,
            "captionvar.minute": packet["minute"],
            "captionvar.moment_type": packet["moment_type"],
            "captionvar.red_team": plant or "none",
            "captionvar.insight_red_team": (insight_plant or "none") if insight else "n/a",
        })
        start = clock(usage)
        workflow = build_workflow(agents, factbox, usage)
        events = await workflow.run(MomentTask(index, packet, plant, insight, insight_plant))
        outputs = events.get_outputs()
        caption = next((o for o in outputs if o.get("kind") == "caption"), None)
        if not caption:
            raise RuntimeError(f"moment {index}: workflow produced no caption")
        line = next((o for o in outputs if o.get("kind") == "insight"), None)
        if insight and not line:
            raise RuntimeError(f"moment {index}: the analyst produced no line")
        caption["timing"] = timing_since(start, caption["clock"])
        if line:
            line["timing"] = timing_since(start, line["clock"])
        span.set_attributes({
            "captionvar.first_draft_verdict": caption["history"][0]["status"],
            "captionvar.rewrites": len(caption["history"]) - 1,
            "captionvar.aired_by": caption["aired"]["by"],
            "captionvar.aired_text": caption["aired"]["text"],
            "captionvar.time_to_air_s": caption["timing"]["time_to_air_s"],
            **({"captionvar.insight_verdict": line["history"][-1]["status"],
                "captionvar.insight_aired": bool(line["aired"])} if line else {}),
        })
        return {"caption": caption, "insight": line}


async def run_recap(recap: str, plant: str | None, agents: Agents, factbox: Factbox, usage: Usage) -> dict:
    """Write and check one recap. Returns its sentences in order with what aired."""
    with TRACER.start_as_current_span(f"recap {recap}") as span:
        span.set_attribute("captionvar.red_team", plant or "none")
        start = clock(usage)
        events = await build_recap_workflow(agents, factbox, usage).run(RecapTask(recap, plant))
        outputs = events.get_outputs()
        plan = next((o for o in outputs if o.get("kind") == "recap_plan"), None)
        parts = sorted((o for o in outputs if o.get("kind") == "recap"), key=lambda o: o["part"])
        if not plan or len(parts) != len(plan["sentences"]):
            raise RuntimeError(f"recap {recap}: {len(parts)} of {len(plan['sentences']) if plan else '?'} sentences finished")
        last = max((p["clock"] for p in parts), key=lambda c: c["at"], default=start)
        aired = sum(bool(p["aired"]) for p in parts)
        span.set_attributes({"captionvar.sentences": len(parts), "captionvar.sentences_aired": aired})
        return {"plan": plan, "parts": parts, "timing": timing_since(start, last)}


def attempts_of(history: list) -> list:
    return [{k: h.get(k) for k in ("attempt", "author", "text", "status", "flags")} for h in history]


async def assemble_decision(index: int, out: dict, factbox: Factbox) -> dict:
    """Shape a workflow result into the trace format the UI consumes."""
    cap = out["caption"]
    first = cap["history"][0]
    header = await factbox.call("decision_header", index=index)
    checked = await factbox.call("verify", index=index, text=first["text"], extracted=first["extracted"])
    decision = {
        "id": f"CAP-{index + 1:03d}",
        **header,
        "segments": checked["segments"],
        "claims": checked["claims"],
        "verdict": checked["verdict"],
        "planted_error": {"kind": cap["plant"]} if cap["plant"] else None,
        "aired": cap["aired"],
        "attempts": attempts_of(cap["history"]),
        "timing": cap["timing"],
    }
    if out.get("insight"):
        decision["insight"] = assemble_line(out["insight"])
    return decision


def assemble_line(line: dict) -> dict:
    """A line of context or recap sentence: its first draft as checked, every attempt, and what aired."""
    first = line["history"][0]
    return {
        "text": first["text"],
        "segments": first["segments"],
        "verdict": first["verdict"],
        "planted_error": {"kind": line["plant"]} if line["plant"] else None,
        "aired": line["aired"],
        "attempts": attempts_of(line["history"]),
        **({"timing": line["timing"]} if "timing" in line else {}),
    }


async def assemble_recap(recap: str, out: dict, factbox: Factbox) -> dict:
    header = next(r for r in await factbox.call("recaps") if r["recap"] == recap)
    plan = out["plan"]
    sentences = [assemble_line(p) for p in out["parts"]]
    planted = plan["planted_sentence"]
    for i, s in enumerate(sentences):
        # The writer names the sentence it planted the error in; the others are not counted as planted.
        if s["planted_error"] and i != planted:
            s["planted_error"] = None
    return {
        "id": f"RECAP-{recap}",
        **header,
        "sentences": sentences,
        "aired_text": " ".join(s["aired"]["text"] for s in sentences if s["aired"]),
        "planted_error": {"kind": out["parts"][0]["plant"], "sentence": planted} if out["parts"] and out["parts"][0]["plant"] else None,
        "timing": out["timing"],
    }
