"""Combine baseline reports from several matches into one comparison.

    python agents/summarise_baselines.py public/traces/eval/*.baselines.json --out public/traces/baselines-summary.json

With --adjudication (default docs/eval-adjudication.json), the summary also
reports the hand-checked numbers the README and docs/EVALUATION.md quote,
next to the automatic ones, so every published number can be recomputed:

  planted_present  instructions whose error is really in the draft: the
                   automatic count plus the ones it missed (hand-checked);
                   an instruction the narrator ignored is not an error
  own_real         own errors confirmed by hand (the rest are false alarms:
                   true details the extractor bound to the wrong player)

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


def match_seed(match_id: str) -> str:
    """'SYN-NBR-RVU-eval-3' -> 'eval-3', the key the hand checks use."""
    return match_id.split("-", 3)[-1]


def load_adjudication(path: str | None) -> dict | None:
    if not path or not Path(path).exists():
        return None
    return json.loads(Path(path).read_text(encoding="utf-8"))


def main(args: argparse.Namespace) -> None:
    # Expand patterns here: PowerShell passes "*.json" through unexpanded.
    paths = sorted({str(q) for p in args.reports for q in (Path().glob(p) if any(c in p for c in "*?[") else [Path(p)])})
    if not paths:
        raise SystemExit("no baseline reports matched")
    reports = [json.loads(Path(p).read_text(encoding="utf-8")) for p in paths]
    totals = {s: {"planted_in_drafts": 0, "planted_on_air": 0, "own_in_drafts": 0, "own_on_air": 0, "own_on_air_verbatim": 0,
                  "unchecked_on_air": 0, "not_aired": 0, "captions": 0} for s in SETUPS}
    own_cases, noise = [], []
    adj = load_adjudication(args.adjudication)
    rep_t = {st: {"planted_present": 0, "planted_on_air": 0, "own_real": 0, "own_real_on_air": 0} for st in SETUPS}
    not_followed, hand_planted = [], []
    for rep in reports:
        match = rep["match_id"]
        rows = {s: rep["setups"][s]["captions"] for s in SETUPS}
        for i, base in enumerate(rows["narrator_only"]):
            if "draft_flags" not in base:
                raise SystemExit(f"{match}: report predates draft_flags; rerun run_baselines.py with --fresh")
            planted = bool(base["planted"]) and carries_plant(base["draft_flags"], base["planted"])
            own = [f for f in base["draft_flags"] if is_own(f, base)]
            key = f"{match_seed(match)} {base['id']}"
            hand = (adj or {}).get("planted_present", {}).get("cases", {}).get(key) if base["planted"] and not planted else None
            if hand and hand["verdict"] == "not followed":
                not_followed.append({"case": key, "note": hand["note"]})
            elif hand:
                hand_planted.append({"case": key, "note": hand["note"], "on_air": hand["on_air"]})
            real = adj is not None and (adj["own_errors"]["cases"].get(key) or [None])[0] == "real"
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
                    rep_t[s]["planted_present"] += 1
                    rep_t[s]["planted_on_air"] += carries_plant(flags, base["planted"])
                elif hand and hand["verdict"] == "present":
                    rep_t[s]["planted_present"] += 1
                    rep_t[s]["planted_on_air"] += bool(hand["on_air"][s])
                if own:
                    t["own_in_drafts"] += 1
                    still = [f["span"] for f in flags if is_own(f, base)]
                    word_for_word = [f["span"] for f in own if verbatim(f["span"], row["aired"])]
                    t["own_on_air"] += bool(still)
                    t["own_on_air_verbatim"] += bool(word_for_word)
                    case["aired"][s] = {"text": row["aired"], "still_false": still, "word_for_word": word_for_word}
                    if real:
                        override = adj.get("on_air_hand_check", {}).get("cases", {}).get(f"{key} {s}")
                        on_air = override["on_air"] if override else bool(still or word_for_word)
                        case["aired"][s]["on_air_hand_checked"] = on_air
                        rep_t[s]["own_real"] += 1
                        rep_t[s]["own_real_on_air"] += on_air
                if s == "captionvar" and (row["m"]["false"] or row["m"]["unchecked"]):
                    noise.append({"match": match, "id": row["id"], "aired": row["aired"],
                                  "flags": [f"{f['span']}: {f['note']}" for f in flags]})
            if own:
                if adj is not None:
                    v = adj["own_errors"]["cases"].get(key)
                    case["hand_check"] = {"verdict": v[0], "note": v[1]} if v else None
                own_cases.append(case)

    out = {"matches": [r["match_id"] for r in reports], "model": reports[0]["model"],
           "cost_usd": round(sum(r["usage"].get("estimated_cost_usd") or 0 for r in reports), 4),
           "totals": totals, "own_error_cases": own_cases, "captionvar_measurement_flags": noise}
    if adj is not None:
        instructions = sum(1 for r in reports for c in r["setups"]["narrator_only"]["captions"] if c["planted"])
        out = {
            "reported": {
                "about": ("The numbers quoted in README.md and docs/EVALUATION.md. planted_present: red-team instructions "
                          "whose error is in the draft, hand-checked where the automatic count missed it. own_real: the "
                          "narrator's own errors confirmed by hand (the other flags are false alarms). Cases and reasons: "
                          f"{args.adjudication}."),
                "red_team_instructions": instructions,
                "not_followed": not_followed,
                "planted_found_by_hand": hand_planted,
                "own_flagged": totals["narrator_only"]["own_in_drafts"],
                **rep_t,
            },
            "automatic": {
                "about": ("Counted by code only: planted errors the referee's draft flags show, and every own-error flag "
                          "(false alarms included), each re-checked in what aired by a fresh extraction and the referee."),
                **totals,
            },
            **{k: v for k, v in out.items() if k != "totals"},
        }
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"{len(reports)} match(es), {totals['narrator_only']['captions']} captions\n")
    print(f"{'set-up':<14}{'planted on air':>16}{'own on air':>14}{'(word for word)':>17}{'unchecked on air':>18}{'not aired':>11}")
    for s in SETUPS:
        t = totals[s]
        print(f"{s:<14}{t['planted_on_air']:>10}/{t['planted_in_drafts']:<5}{t['own_on_air']:>8}/{t['own_in_drafts']:<5}"
              f"{t['own_on_air_verbatim']:>11}/{t['own_in_drafts']:<5}{t['unchecked_on_air']:>18}{t['not_aired']:>11}")
    if adj is not None:
        r = out["reported"]
        print(f"\nhand-checked ({args.adjudication}): {r['red_team_instructions']} instructions, "
              f"{len(r['not_followed'])} not followed")
        print(f"{'set-up':<14}{'planted on air':>16}{'own (real) on air':>20}")
        for st in SETUPS:
            print(f"{st:<14}{r[st]['planted_on_air']:>10}/{r[st]['planted_present']:<5}{r[st]['own_real_on_air']:>13}/{r[st]['own_real']:<5}")
    print(f"\n{len(noise)} CaptionVAR caption(s) flagged by the re-measurement (review: these passed the referee once already).")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("reports", nargs="+")
    ap.add_argument("--out", default="public/traces/baselines-summary.json")
    ap.add_argument("--adjudication", default="docs/eval-adjudication.json", help="hand checks; pass '' to skip")
    main(ap.parse_args())
