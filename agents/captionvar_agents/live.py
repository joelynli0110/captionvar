"""A short live run of the workflow, one decision at a time (for agents/live_server.py).

`live_moments` runs the same workflow as agents/run_match.py over a few moments
of the demo match and yields each decision as soon as it is assembled, in the
trace's decision shape. Every model call is counted against a hard cap: when
the cap is reached the next call raises CallCapReached and the run stops.
"""
from __future__ import annotations

import logging
import time
from typing import Any, AsyncIterator, Callable

from . import pipeline, prompts
from .factbox import Factbox
from .pipeline import RateLimiter, Usage, assemble_decision, make_agents, plan_line_red_team, plan_red_team, run_moment


class CallCapReached(RuntimeError):
    pass


class CappedLimiter(RateLimiter):
    """The workflow's rate limiter, plus a hard cap on model calls (retries included)."""

    def __init__(self, rpm: float | None, max_calls: int, on_call: Callable[[], None] | None = None) -> None:
        super().__init__(rpm)
        self.max_calls = max_calls
        self.calls = 0
        self.on_call = on_call

    async def wait(self) -> None:
        if self.calls >= self.max_calls:
            raise CallCapReached(f"call cap reached ({self.max_calls} model calls)")
        self.calls += 1
        if self.on_call:
            self.on_call()
        await super().wait()


def minute_of(packet: dict) -> int:
    return int(packet["minute"].split("+")[0].rstrip("'"))


async def live_moments(
    *,
    client_factory: Callable[[Factbox], Any],
    model: str,
    offline: bool,
    match_seed: str = "captionvar-demo-6",
    from_minute: int = 24,
    limit: int = 4,
    red_team: float = 0.5,
    red_team_seed: str = "live-1",
    rpm: float | None = 30,
    max_calls: int = 60,
    insights: bool = True,
    on_call: Callable[[], None] | None = None,
) -> AsyncIterator[dict]:
    """Yield {"type": "start"}, then one {"type": "decision"} per moment, then {"type": "end"}.

    `client_factory(factbox)` returns the chat client (Foundry, or the scripted
    one for offline runs). A moment that fails ends the run with the reason.
    """
    started = time.time()
    async with Factbox(seed=match_seed) as factbox:
        info = await factbox.call("info")
        packets = [p for p in await factbox.call("moments") if minute_of(p) >= from_minute][:limit]
        headers = [await factbox.call("decision_header", index=p["index"]) for p in packets]
        if offline:
            logging.getLogger("agent_framework").setLevel(logging.ERROR)
        client = client_factory(factbox)
        agents = make_agents(client)
        if offline:
            # As in run_match.py: the scripted narrator plants its own errors.
            sims = [await factbox.call("simulated", index=p["index"]) for p in packets]
            plan = {p["index"]: s["planted_error"]["kind"] for p, s in zip(packets, sims) if s["planted_error"]}
        else:
            plan = plan_red_team(packets, red_team, seed=f"{match_seed}:{red_team_seed}")
        wanted = {p["index"] for p in packets}
        insight_for = {i for i in await factbox.call("insight_moments") if i in wanted} if insights else set()
        insight_plan = plan_line_red_team(sorted(insight_for), prompts.RED_TEAM_INSIGHT, red_team,
                                          seed=f"{match_seed}:{red_team_seed}:insight")
        limiter = CappedLimiter(None if offline else rpm, max_calls, on_call)
        pipeline.LIMITER = limiter
        usage = Usage()
        yield {
            "type": "start",
            "match_id": info["match_id"],
            "model": model,
            "source": "scripted-agents" if offline else "foundry-agents",
            "max_calls": max_calls,
            "moments": [{k: h[k] for k in ("seq", "period", "t", "display_minute", "type")} | {"index": p["index"]}
                        for p, h in zip(packets, headers)],
        }
        reason = "done"
        sent = 0
        try:
            for p in packets:
                moment_usage = Usage()
                try:
                    out = await run_moment(p["index"], p, plan.get(p["index"]), agents, factbox, moment_usage,
                                           insight=p["index"] in insight_for, insight_plant=insight_plan.get(p["index"]))
                    decision = await assemble_decision(p["index"], out, factbox)
                finally:
                    usage.merge(moment_usage)
                sent += 1
                yield {"type": "decision", "decision": decision, "calls": usage.calls}
        except CallCapReached as exc:
            reason = str(exc)
        except Exception as exc:  # noqa: BLE001 - report to the viewer and stop
            reason = f"stopped: {str(exc).splitlines()[0][:160] if str(exc) else type(exc).__name__}"
        finally:
            pipeline.LIMITER = RateLimiter(None)
        yield {
            "type": "end",
            "reason": reason,
            "decisions": sent,
            "moments": len(packets),
            "usage": {"llm_calls": usage.calls, "input_tokens": usage.input_tokens, "output_tokens": usage.output_tokens,
                      "rate_limited_retries": usage.throttled, "wall_seconds": round(time.time() - started, 1)},
        }
