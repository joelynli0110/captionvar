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
    --concurrency C  moments processed in parallel (default 4)
"""
import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import logging  # noqa: E402

from captionvar_agents.factbox import Factbox  # noqa: E402
from captionvar_agents.pipeline import (  # noqa: E402
    MAX_EDITS, Usage, assemble_decision, make_agents, plan_red_team, run_moment,
)

# Published Global Standard price for gpt-4.1-mini, USD per 1M tokens (input, output).
PRICE_PER_M = {"gpt-4.1-mini": (0.40, 1.60)}


def foundry_client():
    from agent_framework.foundry import FoundryChatClient
    from azure.identity.aio import AzureCliCredential

    missing = [v for v in ("FOUNDRY_PROJECT_ENDPOINT", "FOUNDRY_MODEL") if not os.environ.get(v)]
    if missing:
        sys.exit(f"Set {', '.join(missing)} (see the docstring at the top of this file), or use --offline.")
    return FoundryChatClient(credential=AzureCliCredential())


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
        agents = make_agents(client)
        usage = Usage()
        if args.offline:
            # The scripted narrator plants its own errors; use those as ground truth.
            sims = [await factbox.call("simulated", index=p["index"]) for p in packets]
            plan = {p["index"]: sim["planted_error"]["kind"] for p, sim in zip(packets, sims) if sim["planted_error"]}
        else:
            plan = plan_red_team(packets, args.red_team, seed=f"{args.match_seed}:{args.red_team_seed}")
        print(f"{info['home']} v {info['away']}: {len(packets)} moments, {len(plan)} with a red-team error, model {model}")

        sem = asyncio.Semaphore(args.concurrency)

        async def one(p: dict) -> dict:
            async with sem:
                out = await run_moment(p["index"], p, plan.get(p["index"]), agents, factbox, usage)
                decision = await assemble_decision(p["index"], out, factbox)
                print(f"  {decision['display_minute']:>6} {decision['type']:<9} {decision['verdict']['status']:<8} "
                      f"aired by {decision['aired']['by']:<8} {decision['planted_error']['kind'] if decision['planted_error'] else ''}")
                return decision

        decisions = await asyncio.gather(*(one(p) for p in packets))

    decisions.sort(key=lambda d: d["seq"])
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
        "settings": {"red_team_rate": args.red_team, "max_edits": MAX_EDITS, "match_seed": args.match_seed},
        "summary": {
            "captions": len(decisions),
            "verified": sum(d["verdict"]["status"] == "VERIFY" for d in decisions),
            "qualified": sum(d["verdict"]["status"] == "QUALIFY" for d in decisions),
            "withheld": sum(d["verdict"]["status"] == "WITHHOLD" for d in decisions),
            "planted_errors": len(planted),
            "caught": sum(d["verdict"]["status"] != "VERIFY" for d in planted),
            "flagged_without_plant": len(unplanted_flagged),
            "aired_by": {k: sum(d["aired"]["by"] == k for d in decisions) for k in ("narrator", "editor", "template")},
        },
        "usage": {"llm_calls": usage.calls, "input_tokens": usage.input_tokens, "output_tokens": usage.output_tokens,
                  "estimated_cost_usd": cost, "by_agent": usage.by_agent, "wall_seconds": round(time.time() - started, 1)},
        "decisions": decisions,
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(trace, ensure_ascii=False, indent=1))
    s = trace["summary"]
    print(f"\nplanted errors caught: {s['caught']}/{s['planted_errors']}; other captions flagged: {s['flagged_without_plant']}")
    print(f"aired by narrator {s['aired_by']['narrator']}, editor {s['aired_by']['editor']}, template {s['aired_by']['template']}")
    print(f"LLM calls {usage.calls}, tokens in/out {usage.input_tokens}/{usage.output_tokens}, est. cost {cost if cost is not None else 'n/a'} USD")
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
    ap.add_argument("--concurrency", type=int, default=4)
    asyncio.run(main(ap.parse_args()))
