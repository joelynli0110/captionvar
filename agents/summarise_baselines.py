"""Combine baseline reports from several matches into one comparison.

    python agents/summarise_baselines.py public/traces/eval/*.baselines.json --out public/traces/baselines-summary.json

Two kinds of error are counted separately, because they behave differently:

  planted  the red team told the narrator to make it (wrong player, inflated
           number, wrong score, invented goal or cause, superlative). Known
           ground truth: the draft carries it by instruction.
  own      the narrator made it unasked: a false build-up detail by a named
           player ("under pressure from Sow"), or any false statement in a
           caption that had no planted error. Found by the published run's
           referee in the draft; every case is listed for manual review.

For each set-up it reports how many drafts carrying each kind of error still
aired with that kind of error, measured on the aired caption by a fresh
extraction and the code referee. The CaptionVAR rows of that measurement are
also a noise check: they aired only after passing the same referee, so any
flag there is a measurement disagreement, listed for review.
"""
import argparse
import json
import re
from pathlib import Path

SETUPS = ("narrator_only", "self_check", "llm_judge", "captionvar")

# Claim kinds through which each planted error shows up (after binding in extracted.js).
PLANT_KINDS = {
    "wrong_player": {"goal_scorer", "shot_player", "card_player", "substitution", "top_speed"},
    "inflated_number": {"top_speed", "distance", "window_count", "possession", "pass_accuracy"},
    "wrong_score": {"score"},
    "invented_goal": {"shot_outcome", "goal_scorer", "score"},
    "invented_cause": {"goal_from_press"},
    # Only the superlative itself: a rewrite's harmless "a big chance" is other_fact, not the plant.
    "unverifiable_superlative": {"opinion"},
}


def is_own(flag: dict, caption: dict) -> bool:
    """A false statement the narrator made unasked."""
    if flag["status"] != "contradicted" or flag["kind"] == "moment_missing":
        return False
    if not caption["planted"]:
        # Team-level "pressure" with no named player is colour ("keeping them under pressure"), not counted.
        return not (flag["kind"] == "recent_action" and not flag.get("actor"))
    # In a planted caption, only a named build-up action can be the narrator's own error;
    # the foul behind a wrongly named booking is part of the planted error.
    return (flag["kind"] == "recent_action" and bool(flag.get("actor"))
            and not (caption["type"] == "card" and flag.get("action") == "foul"))


def carries_plant(flags: list[dict], plant: str) -> bool:
    kinds = PLANT_KINDS.get(plant, set())
    return any(f["kind"] in kinds and f["status"] in ("contradicted", "unverifiable") for f in flags)


def verbatim(span: str | None, text: str | None) -> bool:
    """The failed words still appear, word for word, in what aired (needs no second extraction)."""
    if not span or not text or "..." in span:
        return False
    norm = lambda t: re.sub(r"[\u2018\u2019'`]", "'", t.lower())  # noqa: E731
    return norm(span) in norm(text)


def aired_flags(row: dict) -> list[dict]:
    m = row["m"]
    return [{**f, "status": "contradicted"} for f in m["false"]] + [{**f, "status": "unverifiable"} for f in m["unchecked"]]


def main(args: argparse.Namespace) -> None:
    # Expand patterns here: PowerShell passes "*.json" through unexpanded.
    paths = sorted({str(q) for p in args.reports for q in (Path().glob(p) if any(c in p for c in "*?[") else [Path(p)])})
    if not paths:
        raise SystemExit("no baseline reports matched")
    reports = [json.loads(Path(p).read_text(encoding="utf-8")) for p in paths]
    totals = {s: {"planted_in_drafts": 0, "planted_on_air": 0, "own_in_drafts": 0, "own_on_air": 0, "own_on_air_verbatim": 0,
                  "unchecked_on_air": 0, "not_aired": 0, "captions": 0} for s in SETUPS}
    own_cases, noise = [], []
    for rep in reports:
        match = rep["match_id"]
        rows = {s: rep["setups"][s]["captions"] for s in SETUPS}
        for i, base in enumerate(rows["narrator_only"]):
            if "draft_flags" not in base:
                raise SystemExit(f"{match}: report predates draft_flags; rerun run_baselines.py with --fresh")
            planted = bool(base["planted"]) and carries_plant(base["draft_flags"], base["planted"])
            own = [f for f in base["draft_flags"] if is_own(f, base)]
            case = {"match": match, "id": base["id"], "minute": base["minute"], "draft": base["draft"],
                    "own_errors": [f["span"] for f in own], "aired": {}}
            for s in SETUPS:
                row, t = rows[s][i], totals[s]
                flags = aired_flags(row)
                t["captions"] += 1
                t["not_aired"] += not row["m"]["aired"]
                t["unchecked_on_air"] += bool(row["m"]["unchecked"])
                if planted:
                    t["planted_in_drafts"] += 1
                    t["planted_on_air"] += carries_plant(flags, base["planted"])
                if own:
                    t["own_in_drafts"] += 1
                    still = [f["span"] for f in flags if is_own(f, base)]
                    word_for_word = [f["span"] for f in own if verbatim(f["span"], row["aired"])]
                    t["own_on_air"] += bool(still)
                    t["own_on_air_verbatim"] += bool(word_for_word)
                    case["aired"][s] = {"text": row["aired"], "still_false": still, "word_for_word": word_for_word}
                if s == "captionvar" and (row["m"]["false"] or row["m"]["unchecked"]):
                    noise.append({"match": match, "id": row["id"], "aired": row["aired"],
                                  "flags": [f"{f['span']}: {f['note']}" for f in flags]})
            if own:
                own_cases.append(case)

    out = {"matches": [r["match_id"] for r in reports], "model": reports[0]["model"],
           "cost_usd": round(sum(r["usage"].get("estimated_cost_usd") or 0 for r in reports), 4),
           "totals": totals, "own_error_cases": own_cases, "captionvar_measurement_flags": noise}
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"{len(reports)} match(es), {totals['narrator_only']['captions']} captions\n")
    print(f"{'set-up':<14}{'planted on air':>16}{'own on air':>14}{'(word for word)':>17}{'unchecked on air':>18}{'not aired':>11}")
    for s in SETUPS:
        t = totals[s]
        print(f"{s:<14}{t['planted_on_air']:>10}/{t['planted_in_drafts']:<5}{t['own_on_air']:>8}/{t['own_in_drafts']:<5}"
              f"{t['own_on_air_verbatim']:>11}/{t['own_in_drafts']:<5}{t['unchecked_on_air']:>18}{t['not_aired']:>11}")
    print(f"\n{len(noise)} CaptionVAR caption(s) flagged by the re-measurement (review: these passed the referee once already).")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("reports", nargs="+")
    ap.add_argument("--out", default="public/traces/baselines-summary.json")
    main(ap.parse_args())
