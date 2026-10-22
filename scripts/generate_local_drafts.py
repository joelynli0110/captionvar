r"""Generate UNVERIFIED model-written football commentary from synthetic *events*.

Does NOT use an existing (possibly erroneous) claim as the model's source.
The browser's structured claim checker is independent; it DOES NOT certify
arbitrary newly generated prose. See README for this important limitation.

Windows, in the project directory:
  py -3.11 -m venv .venv
  .\.venv\Scripts\python.exe -m pip install foundry-local-sdk-winml
  .\.venv\Scripts\python.exe scripts\generate_local_drafts.py
"""
from __future__ import annotations

import json
import os
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCENARIOS = ROOT / "src" / "data" / "scenarios.json"
OUTPUT = ROOT / "src" / "data" / "model_drafts.json"
MODEL_ALIAS = os.getenv("CAPTIONVAR_MODEL", "qwen2.5-1.5b")


def build_observed_facts(scenario: dict) -> dict:
    """Compute facts only from event fields; never trust original claim_text."""
    events = scenario["events"]
    at = scenario["minute"] * 60 + scenario["second"]
    start = at - 90

    passes = [e for e in events if e["type"] == "pass"]
    recoveries = [e for e in events if e["type"] == "recovery"
                  and start <= (e["minute"] * 60 + e["second"]) <= at]
    shots = [e for e in events if e["type"] == "shot"]

    by_team = Counter((e["team"], e.get("zone", "unknown")) for e in recoveries)
    facts = {
        "fixture": "Northbridge FC vs Riverside United (fictional)",
        "observed_at": f"{scenario['minute']:02d}:{scenario['second']:02d}",
        "measurement_window_seconds": 90,
        "all_event_ids": [e["id"] for e in events],
        "recorded_passes": [
            {"id": e["id"], "team": e["team"], "completed": bool(e.get("successful", False))}
            for e in passes
        ],
        "attacking_third_recoveries_by_team": {
            team: count
            for (team, zone), count in by_team.items() if zone == "attacking_third"
        },
        "recorded_shots": [
            {"id": e["id"], "team": e["team"], "on_target": e.get("on_target"),
             "xg": e.get("xg", "UNAVAILABLE")}
            for e in shots
        ],
        "pressing_actions_recorded": any(e["type"] == "pressing_action" for e in events),
        "goals_recorded": len([e for e in events if e["type"] == "goal"]),
    }
    return facts


def make_prompt(facts: dict) -> str:
    return (
        "You are drafting an UNVERIFIED caption for a fictional football match. "
        "Write ONE concise factual sentence (maximum 35 words) based ONLY on the JSON observations. "
        "Do not invent goals, score, players, match outcome, or shot-quality numbers. "
        "Do not infer causal pressing, tactical dominance or momentum from ball-recovery counts alone. "
        "If sample is tiny, do not overstate what it proves. "
        "If only a shot is recorded without xG, you may say a shot occurred but MUST NOT assign xG. "
        "Return just the sentence, without quotes or Markdown.\n"
        "OBSERVATIONS:\n" + json.dumps(facts, ensure_ascii=False, sort_keys=True)
    )


def main() -> None:
    # Import only when actually generating; fact-build tests need no GPU, SDK or internet.
    from foundry_local_sdk import Configuration, FoundryLocalManager

    scenarios = json.loads(SCENARIOS.read_text(encoding="utf-8"))
    config = Configuration(app_name="captionvar_live")
    FoundryLocalManager.initialize(config)
    manager = FoundryLocalManager.instance
    print("Registering supported execution providers ...")
    manager.download_and_register_eps()
    model = manager.catalog.get_model(MODEL_ALIAS)
    if model is None:
        raise RuntimeError(f"Model {MODEL_ALIAS!r} not found; run 'foundry model list'.")
    model.download()
    model.load()
    drafts = {}
    try:
        client = model.get_chat_client()
        for scenario in scenarios:
            if scenario.get("origin") == "locally_generated_replayed_output":
                print(f"Skipping {scenario['id']} (preserved observed, manually copied replay)")
                continue
            facts = build_observed_facts(scenario)
            prompt = make_prompt(facts)
            response = client.complete_chat([{"role": "user", "content": prompt}])
            content = response.choices[0].message.content
            caption = (content or "").strip()
            if not caption:
                raise RuntimeError(f"Empty model output for {scenario['id']}")
            drafts[scenario["id"]] = {
                "caption": caption,
                "provider": "Microsoft Foundry Local",
                "model": MODEL_ALIAS,
                "generated_at_utc": datetime.now(timezone.utc).isoformat(),
                "disclosure": "Unverified model prose; VAR checks a separate typed claim, not all words in this caption.",
            }
            print(f"{scenario['id']}: {caption}")
    finally:
        model.unload()
    # Don't destroy the current drafts on a partially failed run.
    temp = OUTPUT.with_suffix(".json.tmp")
    temp.write_text(json.dumps(drafts, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(OUTPUT)
    print(f"Saved {len(drafts)} actual local-model captions to {OUTPUT}.")
    print("Run npm.cmd run dev; this step connects generation to display, NOT full prose verification.")


if __name__ == "__main__":
    main()
