"""End-to-end test of the agent workflow without a model.

Runs the real Agent Framework workflow (agents, executors, conditional edges,
edit loop, publisher) with the scripted chat client and checks the trace.
Requires Node.js on PATH (the factbox runs the JavaScript checks).
"""
import argparse
import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from captionvar_agents import pipeline  # noqa: E402
from captionvar_agents.factbox import Factbox  # noqa: E402
import run_match  # noqa: E402


def run(tmp_path: Path, **kw) -> dict:
    out = tmp_path / "trace.json"
    args = argparse.Namespace(out=str(out), offline=True, match_seed="captionvar-demo-6", red_team=0.35, rpm=None, fresh=True,
                              red_team_seed="red-1", limit=kw.get("limit"), from_minute=kw.get("from_minute"), concurrency=4)
    asyncio.run(run_match.main(args))
    return json.loads(out.read_text())


def test_full_match_catches_every_planted_error(tmp_path):
    trace = run(tmp_path)
    s = trace["summary"]
    assert s["captions"] == 40
    assert s["planted_errors"] > 10
    assert s["caught"] == s["planted_errors"]
    assert s["flagged_without_plant"] == 0


def test_every_decision_airs_a_verified_caption_and_keeps_its_history(tmp_path):
    trace = run(tmp_path, from_minute=70)
    for d in trace["decisions"]:
        assert d["aired"]["verified"] is True
        assert d["attempts"][0]["author"] == "narrator"
        if d["verdict"]["status"] == "VERIFY":
            assert d["aired"]["by"] == "narrator" and len(d["attempts"]) == 1
        else:
            # A failed caption goes through the editor loop before falling back.
            assert len(d["attempts"]) == pipeline.MAX_EDITS + 1
            assert d["aired"]["by"] == "template"
        joined = "".join(seg["text"] for seg in d["segments"])
        assert joined == d["attempts"][0]["text"]


def test_red_team_plan_is_reproducible_and_respects_moment_types():
    packets = [{"index": i, "moment_type": t, "facts": {"move_started_with_press": True}} for i, t in enumerate(["goal", "chance", "card", "stat"] * 10)]
    a = pipeline.plan_red_team(packets, 0.5, "s")
    b = pipeline.plan_red_team(packets, 0.5, "s")
    assert a == b and a
    for i, kind in a.items():
        assert kind in pipeline.prompts.RED_TEAM_BY_TYPE[packets[i]["moment_type"]]
        assert kind != "invented_cause"  # the goal already came from the press


def test_referee_rejects_a_caption_with_no_checkable_claim():
    async def go():
        async with Factbox() as fb:
            return await fb.call("verify", index=0, text="What an atmosphere!", extracted=[])
    result = asyncio.run(go())
    assert result["verdict"]["status"] == "WITHHOLD"


def test_extractor_kinds_match_the_javascript_vocabulary():
    js = (ROOT.parent / "src" / "broadcast" / "extracted.js").read_text()
    for kind in pipeline.KIND_DOCS:
        assert f"  {kind}:" in js, kind


def test_rate_limited_calls_are_retried(tmp_path, monkeypatch):
    from captionvar_agents.scripted import ScriptedChatClient
    monkeypatch.setattr(pipeline, "RETRY_BASE_S", 0.01)
    monkeypatch.setattr(ScriptedChatClient, "rate_limit_first_calls", 3)
    trace = run(tmp_path, limit=3)
    assert trace["summary"]["captions"] == 3
    assert trace["usage"]["rate_limited_retries"] == 3


def test_a_failed_run_resumes_without_redoing_finished_moments(tmp_path, monkeypatch):
    from captionvar_agents.scripted import ScriptedChatClient
    import pytest
    monkeypatch.setattr(ScriptedChatClient, "fail_moments_once", {2})
    out = tmp_path / "trace.json"
    base = dict(out=str(out), offline=True, match_seed="captionvar-demo-6", red_team=0.35, rpm=None,
                red_team_seed="red-1", limit=5, from_minute=None, concurrency=1)
    with pytest.raises(SystemExit):
        asyncio.run(run_match.main(argparse.Namespace(**base, fresh=True)))
    partial = Path(str(out) + ".partial.jsonl")
    assert len(partial.read_text().splitlines()) == 4 and not out.exists()
    asyncio.run(run_match.main(argparse.Namespace(**base, fresh=False)))
    trace = json.loads(out.read_text())
    assert [d["id"] for d in trace["decisions"]] == [f"CAP-{i:03d}" for i in range(1, 6)]
    assert not partial.exists()
