"""Compare runs of the same match with different models behind the agents.

Every run uses the same match and the same seeded red-team plan, so the
planted errors are the same; only the model writing (and extracting) changes.
The referee is code, so a cheaper model should change cost, speed and how
often the editor has to step in, but not what reaches air.

    python agents/run_match.py --fresh --out public/traces/models/gpt-4.1-nano.json      (FOUNDRY_MODEL=gpt-4.1-nano)
    python agents/compare_models.py public/traces/foundry-demo.json public/traces/models/*.json --out public/traces/models/summary.json

Prints a Markdown table and writes the numbers as JSON.
"""
import argparse
import glob
import json
from pathlib import Path


def planted_on_air(decisions: list[dict]) -> int:
    """Captions with a planted error whose draft was not stopped (so the error could air)."""
    return sum(1 for d in decisions if d["planted_error"] and d["verdict"]["status"] == "VERIFY")


def row(trace: dict, path: str) -> dict:
    s, u, decisions = trace["summary"], trace["usage"], trace["decisions"]
    lines = s.get("insights") or {}
    recaps = s.get("recaps") or {}
    t = s.get("time_to_air") or {}
    first_pass = sum(d["attempts"][0]["status"] == "VERIFY" for d in decisions)
    return {
        "model": trace["model"],
        "trace": path,
        "generated_at": trace["generated_at"],
        "captions": s["captions"],
        "planted": s["planted_errors"],
        "planted_caught": s["caught"],
        "planted_not_stopped": planted_on_air(decisions),
        "first_draft_passed": first_pass,
        "aired_by": s["aired_by"],
        "flagged_without_plant": s["flagged_without_plant"],
        "lines": lines.get("lines"),
        "lines_aired": lines.get("aired"),
        "lines_planted": lines.get("planted_errors"),
        "lines_caught": lines.get("caught"),
        "recap_sentences": recaps.get("lines"),
        "recap_sentences_aired": recaps.get("aired"),
        "recaps_planted": recaps.get("planted_recaps"),
        "recaps_caught": recaps.get("caught_recaps"),
        "time_to_air_p50_s": t.get("p50_s"),
        "time_to_air_p95_s": t.get("p95_s"),
        "llm_calls": u["llm_calls"],
        "cost_usd": u.get("estimated_cost_usd"),
    }


def fmt(x, unit: str = "") -> str:
    return "–" if x is None else f"{x}{unit}"


def table(rows: list[dict]) -> str:
    head = ("| Model | Planted errors caught (captions) | Planted errors not stopped | First drafts that passed "
            "| Aired by narrator / editor / data | Lines aired | Line plants caught / instructed | Recap sentences aired "
            "| Time to air p50 / p95 | Model calls | Cost per match |")
    sep = "|" + "---|" * 10
    out = [head, sep]
    for r in rows:
        a = r["aired_by"]
        cost = "–" if r["cost_usd"] is None else f"${r['cost_usd']:.3f}"
        out.append(
            f"| {r['model']} | {r['planted_caught']} / {r['planted']} | {r['planted_not_stopped']} "
            f"| {r['first_draft_passed']} / {r['captions']} | {a.get('narrator', 0)} / {a.get('editor', 0)} / {a.get('template', 0)} "
            f"| {fmt(r['lines_aired'])} / {fmt(r['lines'])} | {fmt(r['lines_caught'])} / {fmt(r['lines_planted'])} "
            f"| {fmt(r['recap_sentences_aired'])} / {fmt(r['recap_sentences'])} "
            f"| {fmt(r['time_to_air_p50_s'], ' s')} / {fmt(r['time_to_air_p95_s'], ' s')} | {r['llm_calls']} "
            f"| {cost} |"
        )
    return "\n".join(out)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("traces", nargs="+", help="trace files (globs are expanded, also on Windows)")
    ap.add_argument("--out")
    args = ap.parse_args()
    paths = sorted({p for pattern in args.traces for p in (glob.glob(pattern) or [pattern])})
    traces = [(p, json.loads(Path(p).read_text(encoding="utf-8"))) for p in paths]
    seeds = {t["settings"].get("match_seed") for _, t in traces}
    plans = {(t["settings"].get("red_team_rate"), t["summary"]["planted_errors"]) for _, t in traces}
    if len(seeds) > 1:
        raise SystemExit(f"traces are from different matches: {sorted(seeds)}")
    rows = sorted((row(t, p) for p, t in traces), key=lambda r: (r["cost_usd"] is None, r["cost_usd"] or 0))
    print(table(rows))
    if len(plans) > 1:
        print("\nNote: the red-team plans differ between runs (rate or count), so planted totals are not identical.")
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(json.dumps({"match_seed": seeds.pop(), "runs": rows}, indent=1), encoding="utf-8")
        print(f"\nwrote {args.out}")


if __name__ == "__main__":
    main()
