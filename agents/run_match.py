"""Run the CaptionVAR agent pipeline over a synthetic match and write a trace.

Foundry (real agents):
    az login
    set FOUNDRY_PROJECT_ENDPOINT=https://<resource>.services.ai.azure.com/api/projects/<project>
    set FOUNDRY_MODEL=gpt-4.1-mini
    python agents/run_match.py --out public/traces/foundry-demo.json

Offline (no model; exercises the whole workflow with the test narrator):
    python agents/run_match.py --offline --out public/traces/offline-demo.json

Options:
    --limit N        only the first N moments (cheap smoke test)
    --from-minute M  only moments from minute M on
    --red-team R     share of captions told to plant one error (default 0.35)
    --rpm R          max model requests per minute (default 30); match your deployment's limit
    --concurrency C  moments processed in parallel (default 1)
    --fresh          ignore saved progress and start again
    --trace          send OpenTelemetry traces to the Application Insights resource
                     connected to the Foundry project (see docs/AGENTS.md); one trace per caption
    --trace-content  also record prompts and model replies in the traces
    --no-insights    skip the Analyst's "why it matters" lines
    --no-recaps      skip the half-time and full-time recaps

Progress is saved after every moment to <out>.partial.jsonl. If a run stops
(rate limits, network), run the same command again and it resumes.
"""
import argparse
import asyncio
import json
import math
import os
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import logging  # noqa: E402

from captionvar_agents.factbox import Factbox  # noqa: E402
from captionvar_agents import pipeline  # noqa: E402
from captionvar_agents import prompts  # noqa: E402
from captionvar_agents.pipeline import (  # noqa: E402
    MAX_EDITS, MAX_LINE_EDITS, RateLimiter, Usage, assemble_decision, assemble_recap, make_agents,
    plan_line_red_team, plan_red_team, run_moment, run_recap,
)

# Global Standard list prices, USD per 1M tokens (input, output). Check the Azure
# OpenAI pricing page for your region before quoting a cost; the key is the
# deployment's model name (FOUNDRY_MODEL).
PRICE_PER_M = {
    "gpt-4.1-mini": (0.40, 1.60),
    "gpt-4.1-nano": (0.10, 0.40),
    "gpt-4.1": (2.00, 8.00),
    "gpt-4o-mini": (0.15, 0.60),
    "gpt-4o": (2.50, 10.00),
}


def foundry_client():
    from agent_framework.foundry import FoundryChatClient
    from azure.identity.aio import AzureCliCredential

    missing = [v for v in ("FOUNDRY_PROJECT_ENDPOINT", "FOUNDRY_MODEL") if not os.environ.get(v)]
    if missing:
        sys.exit(f"Set {', '.join(missing)} (see the docstring at the top of this file), or use --offline.")
    return FoundryChatClient(credential=AzureCliCredential())


def flush_traces() -> None:
    """Send buffered spans before the process exits (the exporter batches them)."""
    from opentelemetry import trace
    flush = getattr(trace.get_tracer_provider(), "force_flush", None)
    if flush:
        flush()


def percentile(values: list[float], q: float) -> float:
    """Nearest-rank percentile."""
    ranked = sorted(values)
    return ranked[max(0, math.ceil(q * len(ranked)) - 1)]


def latency_summary(decisions: list[dict]) -> dict | None:
    times = [d["timing"]["time_to_air_s"] for d in decisions if d.get("timing")]
    lines = [d["insight"]["timing"]["time_to_air_s"] for d in decisions if d.get("insight", {}).get("timing")]
    if not times:
        return None
    by_rewrites: dict[str, list[float]] = {}
    for d in decisions:
        if d.get("timing"):
            by_rewrites.setdefault(str(len(d["attempts"]) - 1), []).append(d["timing"]["time_to_air_s"])
    referee = [d["timing"]["referee_ms"] for d in decisions if d.get("timing")]
    return {
        "captions_timed": len(times),
        "p50_s": percentile(times, 0.5),
        "p95_s": percentile(times, 0.95),
        "max_s": max(times),
        "median_by_rewrites_s": {k: percentile(v, 0.5) for k, v in sorted(by_rewrites.items())},
        "referee_p50_ms": percentile(referee, 0.5),
        **({"insight_p50_s": percentile(lines, 0.5), "insight_p95_s": percentile(lines, 0.95)} if lines else {}),
        "note": "Per caption, from the moment's events to the caption that airs (insight: to its line of context). "
                "Rate-limit waits are excluded.",
    }


def recap_caught(recap: dict) -> bool:
    """A planted recap is caught when the sentence carrying the error did not air as written.

    If the writer did not say which sentence it was, any flagged sentence counts.
    """
    i = recap["planted_error"].get("sentence")
    sentences = recap["sentences"]
    if i is not None and 0 <= i < len(sentences):
        return sentences[i]["verdict"]["status"] != "VERIFY"
    return any(s["verdict"]["status"] != "VERIFY" for s in sentences)


def line_summary(lines: list[dict]) -> dict:
    """Lines of context or recap sentences: how many aired, and the red-team score."""
    planted = [x for x in lines if x["planted_error"]]
    return {
        "lines": len(lines),
        "aired": sum(bool(x["aired"]) for x in lines),
        "aired_after_rewrite": sum(bool(x["aired"]) and len(x["attempts"]) > 1 for x in lines),
        "dropped": sum(not x["aired"] for x in lines),
        "planted_errors": len(planted),
        "caught": sum(x["verdict"]["status"] != "VERIFY" for x in planted),
        "flagged_without_plant": sum(x["verdict"]["status"] != "VERIFY" for x in lines if not x["planted_error"]),
    }


async def main(args: argparse.Namespace) -> None:
    started = time.time()
    async with Factbox(seed=args.match_seed) as factbox:
        info = await factbox.call("info")
        packets = await factbox.call("moments")
        if args.from_minute is not None:
            packets = [p for p in packets if int(p["minute"].split("+")[0].rstrip("'")) >= args.from_minute]
        if args.limit:
            packets = packets[: args.limit]

        if args.offline:
            logging.getLogger("agent_framework").setLevel(logging.ERROR)
            from captionvar_agents.scripted import ScriptedChatClient
            client = ScriptedChatClient(factbox)
            model = "scripted (no model)"
        else:
            client = foundry_client()
            model = os.environ["FOUNDRY_MODEL"]
            if args.trace:
                await client.configure_azure_monitor(enable_sensitive_data=args.trace_content)
                print("tracing to the Application Insights resource connected to the Foundry project")
        agents = make_agents(client)
        usage = Usage()
        if args.offline:
            # The scripted narrator plants its own errors; use those as ground truth.
            sims = [await factbox.call("simulated", index=p["index"]) for p in packets]
            plan = {p["index"]: sim["planted_error"]["kind"] for p, sim in zip(packets, sims) if sim["planted_error"]}
        else:
            plan = plan_red_team(packets, args.red_team, seed=f"{args.match_seed}:{args.red_team_seed}")
        wanted = {p["index"] for p in packets}
        insight_for = set() if getattr(args, "no_insights", False) else {i for i in await factbox.call("insight_moments") if i in wanted}
        insight_plan = plan_line_red_team(sorted(insight_for), prompts.RED_TEAM_INSIGHT, args.red_team,
                                          seed=f"{args.match_seed}:{args.red_team_seed}:insight")
        recap_keys = [] if getattr(args, "no_recaps", False) or args.limit or args.from_minute is not None else ["HT", "FT"]
        # One of the two recaps carries a planted error, so every run tests the recap check too.
        recap_plan = plan_line_red_team(recap_keys, prompts.RED_TEAM_RECAP, 1.0, seed=f"{args.match_seed}:{args.red_team_seed}:recap")
        if len(recap_plan) > 1:
            keep = random.Random(f"{args.match_seed}:{args.red_team_seed}:recap-pick").choice(sorted(recap_plan))
            recap_plan = {keep: recap_plan[keep]}
        pipeline.LIMITER = RateLimiter(None if args.offline else args.rpm)

        # Resume: moments finished in an earlier run are loaded, not re-run.
        partial = Path(str(args.out) + ".partial.jsonl")
        partial.parent.mkdir(parents=True, exist_ok=True)
        done: dict[int, dict] = {}
        recaps_done: dict[str, dict] = {}
        if partial.exists() and not args.fresh:
            for line in partial.read_text(encoding="utf-8").splitlines():
                rec = json.loads(line)
                if rec["match_id"] == info["match_id"] and rec["model"] == model:
                    if "recap" in rec:
                        recaps_done[rec["recap"]] = rec["result"]
                    else:
                        done[rec["index"]] = rec["decision"]
                    usage.merge(rec["usage"])
        elif partial.exists():
            partial.unlink()
        todo = [p for p in packets if p["index"] not in done]
        print(f"{info['home']} v {info['away']}: {len(packets)} moments ({len(done)} already done), "
              f"{len(plan)} with a red-team error; {len(insight_for)} lines of context ({len(insight_plan)} planted); "
              f"recaps {', '.join(recap_keys) or 'none'} ({len(recap_plan)} planted); model {model}")

        sem = asyncio.Semaphore(args.concurrency)
        write_lock = asyncio.Lock()
        failed: list[tuple[int, str]] = []

        def show(decision: dict) -> None:
            line = decision.get("insight")
            why = f" | why: {line['verdict']['status']:<8} {'aired' if line['aired'] else 'dropped'}" if line else ""
            print(f"  {decision['display_minute']:>6} {decision['type']:<9} {decision['verdict']['status']:<8} "
                  f"aired by {decision['aired']['by']:<8} {decision['planted_error']['kind'] if decision['planted_error'] else '':<16}{why}", flush=True)

        async def one(p: dict) -> None:
            async with sem:
                moment_usage = Usage()
                try:
                    out = await run_moment(p["index"], p, plan.get(p["index"]), agents, factbox, moment_usage,
                                           insight=p["index"] in insight_for, insight_plant=insight_plan.get(p["index"]))
                    decision = await assemble_decision(p["index"], out, factbox)
                except Exception as exc:  # noqa: BLE001 - report and keep going; the rerun resumes
                    failed.append((p["index"], str(exc).splitlines()[0][:160]))
                    print(f"  {p['minute']:>6} FAILED: {failed[-1][1]}", flush=True)
                    usage.merge(moment_usage)
                    return
                usage.merge(moment_usage)
                done[p["index"]] = decision
                async with write_lock:
                    with partial.open("a", encoding="utf-8") as f:
                        f.write(json.dumps({"match_id": info["match_id"], "model": model, "index": p["index"],
                                            "decision": decision, "usage": moment_usage.as_dict()}, ensure_ascii=False) + "\n")
                show(decision)

        await asyncio.gather(*(one(p) for p in todo))

        recaps: dict[str, dict] = dict(recaps_done)
        for key in recap_keys:
            if key in recaps:
                continue
            recap_usage = Usage()
            try:
                out = await run_recap(key, recap_plan.get(key), agents, factbox, recap_usage)
                recaps[key] = await assemble_recap(key, out, factbox)
            except Exception as exc:  # noqa: BLE001 - report and keep going; the rerun resumes
                failed.append((key, str(exc).splitlines()[0][:160]))
                print(f"  recap {key} FAILED: {failed[-1][1]}", flush=True)
                usage.merge(recap_usage)
                continue
            usage.merge(recap_usage)
            with partial.open("a", encoding="utf-8") as f:
                f.write(json.dumps({"match_id": info["match_id"], "model": model, "recap": key,
                                    "result": recaps[key], "usage": recap_usage.as_dict()}, ensure_ascii=False) + "\n")
            r = recaps[key]
            print(f"  recap {key}: {sum(bool(x['aired']) for x in r['sentences'])}/{len(r['sentences'])} sentences aired"
                  f"{' (planted: ' + r['planted_error']['kind'] + ')' if r['planted_error'] else ''}", flush=True)

    flush_traces()
    if failed:
        print(f"\n{len(failed)} moment(s) or recap(s) did not finish; {len(done)}/{len(packets)} moments are saved in {partial}.")
        print("Run the same command again to resume. If this keeps happening, lower --rpm or raise the deployment's rate limit.")
        sys.exit(1)
    decisions = [done[p["index"]] for p in packets]

    decisions.sort(key=lambda d: d["seq"])
    latency = latency_summary(decisions)
    insights = [d["insight"] for d in decisions if d.get("insight")]
    recap_list = [recaps[k] for k in recap_keys if k in recaps]
    recap_sentences = [s for r in recap_list for s in r["sentences"]]
    planted = [d for d in decisions if d["planted_error"]]
    unplanted_flagged = [d for d in decisions if not d["planted_error"] and d["verdict"]["status"] != "VERIFY"]
    price = PRICE_PER_M.get(model)
    cost = round(usage.input_tokens / 1e6 * price[0] + usage.output_tokens / 1e6 * price[1], 4) if price else None
    trace = {
        "version": "1.0",
        "match_id": info["match_id"],
        "source": "scripted-agents" if args.offline else "foundry-agents",
        "model": model,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "settings": {"red_team_rate": args.red_team, "max_edits": MAX_EDITS, "max_line_edits": MAX_LINE_EDITS,
                     "match_seed": args.match_seed, "factbox": os.environ.get("CAPTIONVAR_FACTBOX", "mcp")},
        "summary": {
            "captions": len(decisions),
            "verified": sum(d["verdict"]["status"] == "VERIFY" for d in decisions),
            "qualified": sum(d["verdict"]["status"] == "QUALIFY" for d in decisions),
            "withheld": sum(d["verdict"]["status"] == "WITHHOLD" for d in decisions),
            "planted_errors": len(planted),
            "caught": sum(d["verdict"]["status"] != "VERIFY" for d in planted),
            "flagged_without_plant": len(unplanted_flagged),
            "aired_by": {k: sum(d["aired"]["by"] == k for d in decisions) for k in ("narrator", "editor", "template")},
            "time_to_air": latency,
            **({"insights": line_summary(insights)} if insights else {}),
            **({"recaps": {**line_summary(recap_sentences), "recaps": len(recap_list),
                           "planted_recaps": sum(bool(r["planted_error"]) for r in recap_list),
                           "caught_recaps": sum(recap_caught(r) for r in recap_list if r["planted_error"])}} if recap_list else {}),
        },
        "usage": {"llm_calls": usage.calls, "input_tokens": usage.input_tokens, "output_tokens": usage.output_tokens,
                  "rate_limited_retries": usage.throttled,
                  "estimated_cost_usd": cost, "by_agent": usage.by_agent, "wall_seconds": round(time.time() - started, 1)},
        "decisions": decisions,
        **({"recaps": recap_list} if recap_list else {}),
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    # Always UTF-8: on Windows the default is cp1252, which browsers decode as garbage.
    out.write_text(json.dumps(trace, ensure_ascii=False, indent=1), encoding="utf-8")
    if partial.exists():
        partial.unlink()
    s = trace["summary"]
    print(f"\nplanted errors caught: {s['caught']}/{s['planted_errors']}; other captions flagged: {s['flagged_without_plant']}")
    print(f"aired by narrator {s['aired_by']['narrator']}, editor {s['aired_by']['editor']}, template {s['aired_by']['template']}")
    print(f"LLM calls {usage.calls}, tokens in/out {usage.input_tokens}/{usage.output_tokens}, est. cost {cost if cost is not None else 'n/a'} USD")
    if insights:
        i = trace["summary"]["insights"]
        print(f"lines of context: {i['aired']}/{i['lines']} aired; planted caught {i['caught']}/{i['planted_errors']}")
    if recap_list:
        r = trace["summary"]["recaps"]
        print(f"recaps: {r['aired']}/{r['lines']} sentences aired; planted recaps caught {r['caught_recaps']}/{r['planted_recaps']}")
    if latency:
        print(f"time to air: median {latency['p50_s']} s, p95 {latency['p95_s']} s, max {latency['max_s']} s "
              f"(rate-limit waits excluded)")
    print(f"wrote {out}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="public/traces/foundry-demo.json")
    ap.add_argument("--offline", action="store_true")
    ap.add_argument("--match-seed", default="captionvar-demo-6")
    ap.add_argument("--red-team", type=float, default=0.35)
    ap.add_argument("--red-team-seed", default="red-1")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--from-minute", type=int)
    ap.add_argument("--concurrency", type=int, default=1)
    ap.add_argument("--rpm", type=float, default=30)
    ap.add_argument("--fresh", action="store_true")
    ap.add_argument("--trace", action="store_true")
    ap.add_argument("--trace-content", action="store_true")
    ap.add_argument("--no-insights", action="store_true")
    ap.add_argument("--no-recaps", action="store_true")
    asyncio.run(main(ap.parse_args()))
