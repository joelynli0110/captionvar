"""Measure what the multi-agent design adds, against simpler set-ups on the same drafts.

    python agents/run_baselines.py --trace public/traces/foundry-demo.json --out public/traces/baselines.json

Every set-up starts from the SAME narrator drafts, read from the published
agent trace (including the red team's planted errors), so only the checking
differs:

  narrator_only  the draft airs as written.
  self_check     the same model gets its draft back with the facts and is
                 asked to check and fix it (one agent checking itself).
  llm_judge      a second LLM reads the draft and the facts and says whether
                 it is supported; an LLM editor rewrites it from the judge's
                 problems, at most twice; if the judge still objects, nothing
                 airs (two agents, no code referee).
  captionvar     the published trace: blind extractor + code referee + editor.

Every caption that would air is then measured the same way: a fresh claim
extraction and the code referee, against only the events observed so far.
That measure is the same code as the CaptionVAR referee, so the planted errors
(known ground truth) are reported separately from the referee's other findings.

Options: --rpm R (default 30), --fresh, --offline (scripted model, for tests).
Progress is saved to <out>.partial.jsonl; rerun the same command to resume.
"""
import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from agent_framework import Agent  # noqa: E402

from captionvar_agents import pipeline, prompts  # noqa: E402
from captionvar_agents.factbox import Factbox  # noqa: E402
from captionvar_agents.pipeline import KIND_DOCS, RateLimiter, Usage, ask, clean  # noqa: E402

MAX_EDITS = pipeline.MAX_EDITS
SETUPS = ("narrator_only", "self_check", "llm_judge", "captionvar")
PRICE_PER_M = {"gpt-4.1-mini": (0.40, 1.60)}


def facts_view(packet: dict) -> dict:
    """What the narrator was given, minus the red-team helper list."""
    return {k: packet[k] for k in ("minute", "moment_type", "facts", "recent_play", "home", "away")}


async def self_check(agent: Agent, usage: Usage, packet: dict, draft: str) -> dict:
    response = await ask(agent, usage, {"facts_of_the_moment": facts_view(packet), "your_caption": draft}, temperature=0)
    return {"text": clean(response.text), "steps": [{"by": "self_check", "text": clean(response.text)}]}


async def llm_judge(judge: Agent, editor: Agent, usage: Usage, packet: dict, draft: str) -> dict:
    text, steps = draft, []
    for attempt in range(MAX_EDITS + 1):
        response = await ask(judge, usage, {"facts_of_the_moment": facts_view(packet), "caption_to_check": text},
                             response_format=prompts.Judgement, temperature=0)
        verdict = response.value or prompts.Judgement.model_validate_json(response.text)
        steps.append({"by": "judge", "ok": verdict.ok, "problems": verdict.problems})
        if verdict.ok:
            return {"text": text, "steps": steps}
        if attempt == MAX_EDITS:
            break
        response = await ask(editor, usage, {"facts_of_the_moment": facts_view(packet), "caption": text,
                                             "problems": verdict.problems}, temperature=0.3)
        text = clean(response.text)
        steps.append({"by": "editor", "text": text})
    return {"text": None, "steps": steps}  # the judge never accepted a version: nothing airs


async def measure(extractor: Agent, usage: Usage, factbox: Factbox, index: int, text: str | None) -> dict:
    """Fresh extraction + the code referee. Only false or unchecked statements count against a caption."""
    if text is None:
        return {"aired": False, "false": [], "unchecked": [], "missed_moment": False}
    packet = await factbox.call("extractor_packet", index=index, text=text)
    response = await ask(extractor, usage, packet, response_format=prompts.Extraction, temperature=0)
    value = response.value or prompts.Extraction.model_validate_json(response.text)
    result = await factbox.call("verify", index=index, text=text, extracted=[c.model_dump() for c in value.claims])
    claims = result["verdict"]["claims"]
    pick = lambda status: [brief(c) for c in claims if c["status"] == status and c["kind"] != "moment_missing"]  # noqa: E731
    return {"aired": True, "false": pick("contradicted"), "unchecked": pick("unverifiable"),
            "missed_moment": any(c["kind"] == "moment_missing" for c in claims)}


def brief(claim: dict) -> dict:
    """What the summary needs to classify a failed claim: its kind, and for a build-up action who did what."""
    params = claim.get("params") or {}
    return {"kind": claim["kind"], "status": claim["status"], "span": claim.get("span"), "note": claim.get("note"),
            "action": params.get("action"), "actor": params.get("actor"), "side": params.get("side")}


def summarise(rows: list[dict]) -> dict:
    planted = [r for r in rows if r["planted"]]
    aired = [r for r in rows if r["m"]["aired"]]
    bad = lambda r: bool(r["m"]["false"] or r["m"]["unchecked"])  # noqa: E731
    return {
        "captions": len(rows),
        "aired": len(aired),
        "not_aired": len(rows) - len(aired),
        "planted_errors": len(planted),
        "planted_errors_on_air": sum(bad(r) for r in planted),
        "captions_with_false_fact": sum(bool(r["m"]["false"]) for r in rows),
        "captions_with_unchecked_claim": sum(bool(r["m"]["unchecked"]) for r in rows),
        "captions_missing_the_moment": sum(r["m"]["missed_moment"] for r in rows),
    }


async def main(args: argparse.Namespace) -> None:
    started = time.time()
    trace = json.loads(Path(args.trace).read_text(encoding="utf-8"))
    by_index = {int(d["id"].split("-")[1]) - 1: d for d in trace["decisions"]}

    async with Factbox(seed=trace["settings"]["match_seed"]) as factbox:
        packets = {p["index"]: p for p in await factbox.call("moments")}
        if args.offline:
            from captionvar_agents.scripted import ScriptedChatClient
            client, model = ScriptedChatClient(factbox), "scripted (no model)"
        else:
            from run_match import foundry_client
            import os
            client, model = foundry_client(), os.environ["FOUNDRY_MODEL"]
        kinds = "\n".join(f"- {k}: {v}" for k, v in KIND_DOCS.items())
        narrator = Agent(client, prompts.NARRATOR + "\n\n" + prompts.SELF_CHECK, name="self_check")
        judge = Agent(client, prompts.JUDGE, name="judge")
        judge_editor = Agent(client, prompts.JUDGE_EDITOR, name="judge_editor")
        extractor = Agent(client, prompts.EXTRACTOR.format(kinds=kinds), name="measure_extractor")
        pipeline.LIMITER = RateLimiter(None if args.offline else args.rpm)

        partial = Path(str(args.out) + ".partial.jsonl")
        partial.parent.mkdir(parents=True, exist_ok=True)
        done: dict[str, dict] = {}
        usage = Usage()
        if partial.exists() and not args.fresh:
            for line in partial.read_text(encoding="utf-8").splitlines():
                rec = json.loads(line)
                if rec["model"] == model and rec["trace_generated_at"] == trace["generated_at"]:
                    done[f"{rec['setup']}:{rec['index']}"] = rec["row"]
                    usage.merge(rec["usage"])
        elif partial.exists():
            partial.unlink()

        jobs = [(s, i) for s in SETUPS for i in sorted(by_index) if f"{s}:{i}" not in done]
        print(f"{len(by_index)} captions x {len(SETUPS)} set-ups; {len(done)} already done; model {model}")

        for setup, index in jobs:
            d, packet = by_index[index], packets[index]
            draft = d["attempts"][0]["text"]
            u = Usage()
            try:
                if setup == "narrator_only":
                    out = {"text": draft, "steps": []}
                elif setup == "self_check":
                    out = await self_check(narrator, u, packet, draft)
                elif setup == "llm_judge":
                    out = await llm_judge(judge, judge_editor, u, packet, draft)
                else:
                    out = {"text": d["aired"]["text"], "steps": [{"by": a["author"], "status": a["status"]} for a in d["attempts"]]}
                m = await measure(extractor, u, factbox, index, out["text"])
            except Exception as exc:  # noqa: BLE001 - keep going; a rerun resumes
                usage.merge(u)
                print(f"  {setup:<13} {d['display_minute']:>6} FAILED: {str(exc).splitlines()[0][:160]}", flush=True)
                continue
            usage.merge(u)
            row = {"id": d["id"], "minute": d["display_minute"], "type": d["type"],
                   "planted": d["planted_error"]["kind"] if d["planted_error"] else None,
                   "draft": draft, "aired": out["text"], "steps": out["steps"], "m": m,
                   # What the published run's referee found wrong in the draft, for summarise_baselines.py.
                   "draft_flags": [brief(c) for c in d["verdict"]["claims"] if c["status"] != "supported"]}
            done[f"{setup}:{index}"] = row
            with partial.open("a", encoding="utf-8") as f:
                f.write(json.dumps({"model": model, "trace_generated_at": trace["generated_at"], "setup": setup,
                                    "index": index, "row": row, "usage": u.as_dict()}, ensure_ascii=False) + "\n")
            flag = "FALSE" if m["false"] else ("unchecked" if m["unchecked"] else ("not aired" if not m["aired"] else "ok"))
            print(f"  {setup:<13} {d['display_minute']:>6} {row['planted'] or '':<24} {flag}", flush=True)

    missing = [j for j in ((s, i) for s in SETUPS for i in by_index) if f"{j[0]}:{j[1]}" not in done]
    if missing:
        print(f"\n{len(missing)} job(s) did not finish. Run the same command again to resume.")
        sys.exit(1)

    price = PRICE_PER_M.get(model)
    cost = round(usage.input_tokens / 1e6 * price[0] + usage.output_tokens / 1e6 * price[1], 4) if price else None
    setups = {}
    for s in SETUPS:
        rows = [done[f"{s}:{i}"] for i in sorted(by_index)]
        setups[s] = {"summary": summarise(rows), "captions": rows}
    report = {
        "version": "1.0",
        "match_id": trace["match_id"],
        "model": model,
        "drafts_from": {"trace": Path(args.trace).name, "generated_at": trace["generated_at"]},
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "usage": {"llm_calls": usage.calls, "input_tokens": usage.input_tokens, "output_tokens": usage.output_tokens,
                  "estimated_cost_usd": cost, "by_agent": usage.by_agent, "wall_seconds": round(time.time() - started, 1)},
        "setups": setups,
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    if partial.exists():
        partial.unlink()

    print(f"\n{'set-up':<14}{'planted on air':>16}{'false fact':>12}{'unchecked':>11}{'not aired':>11}")
    for s in SETUPS:
        x = setups[s]["summary"]
        print(f"{s:<14}{x['planted_errors_on_air']:>10}/{x['planted_errors']:<5}{x['captions_with_false_fact']:>12}"
              f"{x['captions_with_unchecked_claim']:>11}{x['not_aired']:>11}")
    print(f"LLM calls {usage.calls}, est. cost {cost if cost is not None else 'n/a'} USD; wrote {out}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--trace", default="public/traces/foundry-demo.json")
    ap.add_argument("--out", default="public/traces/baselines.json")
    ap.add_argument("--offline", action="store_true")
    ap.add_argument("--rpm", type=float, default=30)
    ap.add_argument("--fresh", action="store_true")
    asyncio.run(main(ap.parse_args()))
