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
    return json.loads(out.read_text(encoding="utf-8"))


def untimed(value):
    """The same data without timings, which differ from run to run."""
    if isinstance(value, dict):
        return {k: untimed(v) for k, v in value.items() if k != "timing"}
    if isinstance(value, list):
        return [untimed(v) for v in value]
    return value


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
    js = (ROOT.parent / "src" / "broadcast" / "extracted.js").read_text(encoding="utf-8")
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
    assert len(partial.read_text(encoding="utf-8").splitlines()) == 4 and not out.exists()
    asyncio.run(run_match.main(argparse.Namespace(**base, fresh=False)))
    trace = json.loads(out.read_text(encoding="utf-8"))
    assert [d["id"] for d in trace["decisions"]] == [f"CAP-{i:03d}" for i in range(1, 6)]
    assert not partial.exists()


def test_baselines_measure_every_setup_on_the_same_drafts(tmp_path):
    import run_baselines
    trace_path = tmp_path / "trace.json"
    run(tmp_path, from_minute=70)
    out = tmp_path / "baselines.json"
    asyncio.run(run_baselines.main(argparse.Namespace(trace=str(trace_path), out=str(out), offline=True, rpm=None, fresh=True)))
    report = json.loads(out.read_text(encoding="utf-8"))
    setups = report["setups"]
    assert set(setups) == set(run_baselines.SETUPS)
    drafts = {s: [r["draft"] for r in v["captions"]] for s, v in setups.items()}
    assert len({tuple(d) for d in drafts.values()}) == 1  # identical starting drafts
    # The scripted baselines change nothing, so every planted error the drafts carry still airs ...
    raw = setups["narrator_only"]["summary"]
    assert raw["planted_errors"] > 0 and raw["planted_errors_on_air"] == raw["planted_errors"]
    assert setups["llm_judge"]["summary"]["planted_errors_on_air"] == raw["planted_errors"]
    # ... while what CaptionVAR aired measures clean.
    ours = setups["captionvar"]["summary"]
    assert ours["planted_errors_on_air"] == 0 and ours["captions_with_false_fact"] == 0


def test_own_errors_are_told_apart_from_planted_ones():
    import summarise_baselines as sb
    card = {"planted": "wrong_player", "type": "card"}
    foul = {"kind": "recent_action", "status": "contradicted", "action": "foul", "actor": "RVU-10"}
    press = {"kind": "recent_action", "status": "contradicted", "action": "pressure", "actor": "RVU-05"}
    assert not sb.is_own(foul, card)  # the foul behind a wrong booking is part of the plant
    assert sb.is_own(press, card)
    colour = {"kind": "recent_action", "status": "contradicted", "action": "pressure", "actor": None}
    assert not sb.is_own(colour, {"planted": None, "type": "press"})
    assert sb.is_own({"kind": "possession", "status": "contradicted"}, {"planted": None, "type": "stat"})
    assert sb.carries_plant([{"kind": "card_player", "status": "contradicted"}], "wrong_player")
    assert not sb.carries_plant([{"kind": "named_player", "status": "unverifiable"}], "wrong_player")


def test_each_caption_is_one_trace_with_the_verdict_on_the_referee_span(tmp_path):
    from opentelemetry import trace
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
    from agent_framework.observability import enable_instrumentation

    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    trace.set_tracer_provider(provider)
    enable_instrumentation(enable_sensitive_data=False)
    run(tmp_path, limit=3)

    spans = [s for s in exporter.get_finished_spans()]
    captions = [s for s in spans if s.name.startswith("caption ")]
    assert len(captions) == 3
    for cap in captions:
        inside = [s for s in spans if s.context.trace_id == cap.context.trace_id]
        names = {s.name for s in inside}
        assert {"workflow.run", "executor.process referee"} <= names
        assert any(n.startswith("invoke_agent") for n in names)
        referee = [s for s in inside if s.name == "executor.process referee"]
        assert all(s.attributes["captionvar.verdict"] in {"VERIFY", "QUALIFY", "WITHHOLD"} for s in referee)
        assert cap.attributes["captionvar.aired_by"] in {"narrator", "editor", "template"}


def test_each_caption_records_its_time_to_air(tmp_path):
    trace = run(tmp_path, limit=6)
    for d in trace["decisions"]:
        t = d["timing"]
        assert t["time_to_air_s"] >= 0 and t["model_calls"] >= 2 and t["referee_ms"] > 0
    lat = trace["summary"]["time_to_air"]
    assert lat["captions_timed"] == 6 and lat["p50_s"] <= lat["p95_s"] <= lat["max_s"]


def test_percentile_is_nearest_rank():
    assert run_match.percentile([5, 1, 4, 2, 3], 0.5) == 3
    assert run_match.percentile(list(range(1, 41)), 0.95) == 38
    assert run_match.percentile([7], 0.95) == 7


def test_referee_is_served_over_mcp_and_matches_the_jsonl_fallback(tmp_path, monkeypatch):
    from captionvar_agents.factbox import OP_TO_TOOL

    async def tools() -> set:
        async with Factbox() as fb:
            assert fb.transport == "mcp"
            return {t.name for t in (await fb._session.list_tools()).tools}

    assert set(OP_TO_TOOL.values()) <= asyncio.run(tools())
    over_mcp = run(tmp_path / "mcp", limit=8)
    monkeypatch.setenv("CAPTIONVAR_FACTBOX", "jsonl")
    over_jsonl = run(tmp_path / "jsonl", limit=8)
    assert untimed(over_mcp["decisions"]) == untimed(over_jsonl["decisions"])


def test_key_moments_get_a_checked_line_on_why_they_matter(tmp_path):
    trace = run(tmp_path)
    lines = [d for d in trace["decisions"] if d.get("insight")]
    assert {d["type"] for d in lines} <= {"goal", "chance", "press", "stat"} and len(lines) >= 10
    s = trace["summary"]["insights"]
    assert s["planted_errors"] > 0 and s["caught"] == s["planted_errors"] and s["flagged_without_plant"] == 0
    for d in lines:
        ins = d["insight"]
        if ins["aired"]:
            assert ins["attempts"][-1]["status"] == "VERIFY"
        else:
            # One rewrite by the line editor, then dropped: a line of context never airs unchecked.
            assert [a["author"] for a in ins["attempts"]] == ["analyst", "line_editor"]
            assert all(a["status"] != "VERIFY" for a in ins["attempts"])
        assert ins["timing"]["time_to_air_s"] >= d["timing"]["time_to_air_s"]


def test_recaps_check_every_sentence_and_cut_the_planted_one(tmp_path):
    trace = run(tmp_path)
    recaps = {r["recap"]: r for r in trace["recaps"]}
    assert set(recaps) == {"HT", "FT"}
    planted = [r for r in recaps.values() if r["planted_error"]]
    assert len(planted) == 1
    bad = planted[0]["sentences"][planted[0]["planted_error"]["sentence"]]
    assert bad["verdict"]["status"] != "VERIFY" and not bad["aired"]
    for r in recaps.values():
        assert r["aired_text"] == " ".join(s["aired"]["text"] for s in r["sentences"] if s["aired"])
    assert trace["summary"]["recaps"]["caught_recaps"] == 1


def test_short_runs_skip_the_recaps(tmp_path):
    assert "recaps" not in run(tmp_path, limit=4)


def test_model_comparison_reads_runs_of_the_same_match(tmp_path, capfd):
    import compare_models
    run(tmp_path / "a", limit=6)
    run(tmp_path / "b", limit=6)
    out = tmp_path / "summary.json"
    import sys as _sys
    argv, _sys.argv = _sys.argv, ["compare_models.py", str(tmp_path / "*" / "trace.json"), "--out", str(out)]
    try:
        compare_models.main()
    finally:
        _sys.argv = argv
    summary = json.loads(out.read_text(encoding="utf-8"))
    assert len(summary["runs"]) == 2 and all(r["planted_not_stopped"] == 0 for r in summary["runs"])
    assert "| Model |" in capfd.readouterr().out
