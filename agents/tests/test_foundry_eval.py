"""Offline tests for agents/foundry_eval.py: the inputs it builds, and the scoring path without Azure.

The input tests need only Node.js (the factbox rebuilds the facts). Tests that
touch the evaluation SDK are skipped when azure-ai-evaluation is not installed
(it is in agents/requirements-eval.txt, not in the CI install); they use fake
evaluators or a local stand-in for Azure OpenAI, never the network.
"""
import argparse
import asyncio
import json
import math
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

AGENTS = Path(__file__).resolve().parents[1]
REPO = AGENTS.parent
sys.path.insert(0, str(AGENTS))

import foundry_eval as fe  # noqa: E402

DEMO = REPO / "public" / "traces" / "foundry-demo.json"
ADJ = REPO / "docs" / "demo-adjudication.json"


@pytest.fixture(scope="module")
def demo():
    trace = json.loads(DEMO.read_text(encoding="utf-8"))
    items, mismatches = asyncio.run(fe.build_from_trace(trace, str(ADJ)))
    return trace, items, mismatches


def by_id(items):
    return {i["item_id"]: i for i in items}


def test_every_aired_text_and_every_stopped_draft_becomes_one_input(demo):
    trace, items, mismatches = demo
    assert mismatches == []
    decisions = trace["decisions"]
    lines = [d["insight"] for d in decisions if d.get("insight")]
    sentences = [s for r in trace["recaps"] for s in r["sentences"]]
    aired = [i for i in items if i["set"] == "aired"]
    drafts = [i for i in items if i["set"] == "first_draft"]
    assert sum(i["kind"] == "caption" for i in aired) == len(decisions)
    assert sum(i["kind"] == "why_it_matters" for i in aired) == sum(bool(x["aired"]) for x in lines)
    assert sum(i["kind"] == "recap_sentence" for i in aired) == sum(bool(x["aired"]) for x in sentences)
    stopped = [x for x in decisions + lines + sentences if x["verdict"]["status"] != "VERIFY"]
    assert len(drafts) == len(stopped)
    assert len({i["item_id"] for i in items}) == len(items)
    for i in items:
        assert i["response"].strip() and i["query"].strip()
        assert "team_players" not in i["context"]
    # What aired is what the trace says aired; a stopped draft is the narrator's (or writer's) first attempt.
    ids = by_id(items)
    first = decisions[0]
    assert ids[f"{first['id']}:caption:aired"]["response"] == first["aired"]["text"]
    if first["verdict"]["status"] != "VERIFY":
        assert ids[f"{first['id']}:caption:first_draft"]["response"] == first["attempts"][0]["text"]


def test_context_is_the_facts_the_writer_was_given(demo):
    trace, items, _ = demo
    ids = by_id(items)
    cap = json.loads(ids["CAP-001:caption:aired"]["context"])
    assert set(cap) == {"minute", "moment_type", "facts", "recent_play", "home", "away"}
    assert cap["facts"]["player"] == "Faris Haddad" and cap["facts"]["top_speed_kmh"] == 35
    line = next(i for i in items if i["kind"] == "why_it_matters")
    d = next(x for x in trace["decisions"] if x["id"] == line["decision_id"])
    ctx = json.loads(line["context"])
    assert ctx["caption_on_air"] == d["aired"]["text"] and "context" in ctx
    recap = json.loads(next(i for i in items if i["kind"] == "recap_sentence")["context"])
    assert recap["recap_facts"]["recap"] == "half-time"


def test_buckets_and_what_is_known_about_each_stopped_draft(demo):
    trace, items, _ = demo
    ids = by_id(items)
    for d in trace["decisions"]:
        bucket = ids[f"{d['id']}:caption:aired"]["bucket"]
        assert bucket in fe.CAPTION_BUCKETS
        if d["verdict"]["status"] == "VERIFY":
            assert bucket == "verified"
    # Hand checks in docs/demo-adjudication.json.
    assert ids["CAP-030:caption:first_draft"]["truth"] == "own_error"
    assert ids["CAP-013:caption:first_draft"]["truth"] == "true_detail_flagged"
    assert ids["CAP-009:why_it_matters:first_draft"]["truth"] == "true_detail_flagged"
    assert ids["CAP-001:caption:first_draft"]["truth"] == "planted_error"
    planted_recap = next(i for i in items if i["kind"] == "recap_sentence" and i["set"] == "first_draft")
    assert planted_recap["truth"] == "planted_error"
    assert all(i["truth"] in fe.TRUTHS for i in items if i["set"] == "first_draft")


def test_hand_checks_of_another_run_are_not_used(demo):
    trace, _, _ = demo
    other = {**trace, "generated_at": "2000-01-01T00:00:00Z"}
    assert fe.load_adjudication(str(ADJ), other) == {}
    assert fe.draft_truth("caption", "CAP-030", False, {}) == ("unreviewed", None)


def test_small_trace_template_and_dropped_line():
    ctx = {"minute": "1'", "moment_type": "goal", "facts": {}, "recent_play": [], "home": "A", "away": "B"}
    attempt = lambda t, s: {"attempt": 0, "author": "narrator", "text": t, "status": s,  # noqa: E731
                            "flags": [{"span": "x", "status": "contradicted", "note": "No."}]}
    trace = {"decisions": [{
        "id": "CAP-001", "display_minute": "1'", "type": "goal", "planted_error": None,
        "verdict": {"status": "WITHHOLD"}, "aired": {"text": "Goal for A.", "by": "template"},
        "attempts": [attempt("Goal for B.", "WITHHOLD")],
        "insight": {"verdict": {"status": "QUALIFY"}, "aired": None, "planted_error": {"kind": "inflated_number"},
                    "attempts": [attempt("A have 9 shots.", "QUALIFY")]},
    }]}
    items = fe.build_items(trace, {"caption": {"CAP-001": ctx}, "why_it_matters": {"CAP-001": ctx}, "recap": {}})
    ids = by_id(items)
    assert ids["CAP-001:caption:aired"]["bucket"] == "built_from_data"
    assert ids["CAP-001:caption:first_draft"]["referee_flags"] == "x: No."
    assert "CAP-001:why_it_matters:aired" not in ids
    assert ids["CAP-001:why_it_matters:first_draft"]["truth"] == "planted_error"


def test_dry_run_writes_jsonl_without_touching_azure(tmp_path):
    inputs = tmp_path / "inputs.jsonl"
    code = (
        "import sys, argparse; sys.path.insert(0, 'agents'); import foundry_eval as fe\n"
        f"ns = argparse.Namespace(trace={str(DEMO)!r}, out={str(tmp_path / 'r.json')!r}, inputs={str(inputs)!r},\n"
        f"    adjudication={str(ADJ)!r}, evaluators='groundedness,coherence,fluency', limit=5, workers=1,\n"
        "    dry_run=True, log_to_foundry=False)\n"
        "assert fe.main(ns) == 0\n"
        "assert not [m for m in sys.modules if m.startswith(('azure.ai.evaluation', 'azure.identity'))]\n"
    )
    env = {k: v for k, v in __import__("os").environ.items() if not k.startswith(("FOUNDRY_", "AZURE_"))}
    done = subprocess.run([sys.executable, "-c", code], cwd=REPO, env=env, capture_output=True, text=True, timeout=300)
    assert done.returncode == 0, done.stderr + done.stdout
    rows = [json.loads(line) for line in inputs.read_text(encoding="utf-8").splitlines()]
    assert len(rows) == 5
    assert all(set(fe.EVALUATORS["groundedness"][1]) <= set(r) for r in rows)
    assert not (tmp_path / "r.json").exists()  # a dry run writes no results


def test_model_config_from_the_project_endpoint(monkeypatch):
    env = {"FOUNDRY_PROJECT_ENDPOINT": "https://my-res.services.ai.azure.com/api/projects/p1", "FOUNDRY_MODEL": "gpt-4.1-mini"}
    config = fe.model_config(env)
    assert config == {"type": "azure_openai", "azure_endpoint": "https://my-res.openai.azure.com/", "azure_deployment": "gpt-4.1-mini"}
    config = fe.model_config({**env, "AZURE_OPENAI_ENDPOINT": "https://x.cognitiveservices.azure.com/",
                              "AZURE_OPENAI_DEPLOYMENT": "judge", "AZURE_OPENAI_API_VERSION": "2024-10-21"})
    assert config["azure_endpoint"] == "https://x.cognitiveservices.azure.com/" and config["azure_deployment"] == "judge"
    assert config["api_version"] == "2024-10-21"
    with pytest.raises(SystemExit):
        fe.model_config({"FOUNDRY_MODEL": "m"})
    with pytest.raises(SystemExit):
        fe.model_config({"FOUNDRY_PROJECT_ENDPOINT": env["FOUNDRY_PROJECT_ENDPOINT"]})


def test_credential_always_asks_for_the_azure_openai_audience():
    class Inner:
        def get_token(self, *scopes, **kw):
            self.scopes = scopes
            return "token"
    inner = Inner()
    assert fe.AzureOpenAICredential(inner).get_token("https://ai.azure.com/.default") == "token"
    assert inner.scopes == (fe.AOAI_SCOPE,)


def test_scores_and_summary_from_rows():
    items = [
        {"item_id": "a", "set": "aired", "kind": "caption", "bucket": "verified", "truth": "", "decision_id": "CAP-001",
         "planted": "", "referee_flags": "", "hand_check": "", "response": "r1"},
        {"item_id": "b", "set": "first_draft", "kind": "caption", "bucket": "withhold", "truth": "own_error",
         "decision_id": "CAP-001", "planted": "", "referee_flags": "f", "hand_check": "h", "response": "r0"},
    ]
    rows = [
        {"inputs.item_id": "a", "outputs.groundedness.groundedness": 5.0, "outputs.groundedness.groundedness_result": "pass",
         "outputs.groundedness.groundedness_reason": "ok"},
        {"inputs.item_id": "b", "outputs.groundedness.groundedness": math.nan, "outputs.groundedness.groundedness_result": math.nan},
    ]
    scores = fe.scores_from_rows(rows, ["groundedness"])
    assert scores["a"]["groundedness"] == {"score": 5.0, "result": "pass", "reason": "ok"}
    assert scores["b"]["groundedness"]["result"] == "error"
    s = fe.summarise(items, scores, ["groundedness"])
    assert s["aired"]["by_kind_and_bucket"]["caption"]["verified"]["groundedness"]["pass"] == 1
    assert s["first_drafts"]["by_truth"]["own_error"]["groundedness"]["errors"] == 1
    pair = s["first_drafts"]["pairs"][0]
    assert pair["first_draft"] == "r0" and pair["aired"] == "r1" and pair["aired_groundedness"]["score"] == 5.0


# --------------------------------------------- with the SDK installed (skipped in CI)


def test_sdk_evaluate_rows_map_back_to_items(demo, tmp_path):
    pytest.importorskip("azure.ai.evaluation")
    _, items, _ = demo
    items = items[:6]
    data = tmp_path / "in.jsonl"
    fe.write_jsonl(items, data)

    class FakeGroundedness:
        def __call__(self, *, response, context):
            assert context.startswith("{")
            return {"groundedness": float(len(response) % 5 + 1), "groundedness_reason": response[:10]}

    class FakeFluency:
        def __call__(self, *, response):
            return {"fluency": 4.0, "fluency_result": "pass"}

    evs = {"groundedness": FakeGroundedness(), "fluency": FakeFluency()}
    result = fe.run_evaluate(data, evs, workers=2)
    scores = fe.scores_from_rows(result["rows"], ["groundedness", "fluency"])
    assert set(scores) == {i["item_id"] for i in items}
    for i in items:
        assert scores[i["item_id"]]["groundedness"]["score"] == float(len(i["response"]) % 5 + 1)
        assert scores[i["item_id"]]["fluency"]["result"] == "pass"


class FakeAzureOpenAI(BaseHTTPRequestHandler):
    """Answers chat completions the way an Azure OpenAI deployment would, and records the requests."""
    seen: list = []

    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        FakeAzureOpenAI.seen.append({"path": self.path, "auth": self.headers.get("Authorization"), "body": body})
        reply = {"id": "x", "object": "chat.completion", "created": 0, "model": "gpt-4.1-mini",
                 "choices": [{"index": 0, "finish_reason": "stop", "message": {
                     "role": "assistant", "content": "<S0>Let's think step by step: fine.</S0><S1>Backed by the facts.</S1><S2>4</S2>"}}],
                 "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}}
        out = json.dumps(reply).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *a):
        pass


def test_real_evaluators_against_a_local_stand_in_for_azure_openai(demo, tmp_path):
    pytest.importorskip("azure.ai.evaluation")
    server = HTTPServer(("127.0.0.1", 0), FakeAzureOpenAI)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        class Token:
            token, expires_on = "fake-token", 4102444800

        class Cred:
            def get_token(self, *scopes, **kw):
                assert scopes == (fe.AOAI_SCOPE,)
                return Token()

        env = {"AZURE_OPENAI_ENDPOINT": f"http://127.0.0.1:{server.server_port}/", "FOUNDRY_MODEL": "gpt-4.1-mini"}
        evs = fe.make_evaluators(["groundedness", "fluency"], fe.model_config(env), fe.AzureOpenAICredential(Cred()))
        _, items, _ = demo
        data = tmp_path / "in.jsonl"
        fe.write_jsonl(items[:2], data)
        FakeAzureOpenAI.seen = []
        result = fe.run_evaluate(data, evs, workers=1)
        scores = fe.scores_from_rows(result["rows"], ["groundedness", "fluency"])
    finally:
        server.shutdown()
    assert len(FakeAzureOpenAI.seen) == 4
    for req in FakeAzureOpenAI.seen:
        assert req["path"].startswith("/openai/deployments/gpt-4.1-mini/chat/completions")
        assert req["auth"] == "Bearer fake-token"
    grounded = [r for r in FakeAzureOpenAI.seen if "CONTEXT" in json.dumps(r["body"])]
    assert len(grounded) == 2 and items[0]["response"] in json.dumps(grounded[0]["body"]) + json.dumps(grounded[1]["body"])
    for i in items[:2]:
        assert scores[i["item_id"]]["groundedness"] == {"score": 4.0, "result": "pass", "reason": "Backed by the facts."}


def test_upload_to_foundry_uses_the_sdk_helper(monkeypatch):
    pytest.importorskip("azure.ai.evaluation")
    import azure.ai.evaluation._common as common

    calls = []

    class FakeClient:
        def __init__(self, endpoint, credential, **kw):
            calls.append(("init", endpoint))

        def create_evaluation_result(self, name, path, metrics):
            files = sorted(p.name for p in Path(path).iterdir())
            calls.append(("result", files, metrics))
            return argparse.Namespace(id="res-1")

        def start_evaluation_run(self, evaluation):
            calls.append(("start", evaluation.display_name))
            return argparse.Namespace(name="run-1")

        def update_evaluation_run(self, name, evaluation):
            calls.append(("update", name, evaluation.status))
            return argparse.Namespace(properties={"AiStudioEvaluationUri": "https://ai.azure.com/x"})

    monkeypatch.setattr(common, "EvaluationServiceOneDPClient", FakeClient)
    from azure.ai.evaluation import GroundednessEvaluator
    ev = GroundednessEvaluator({"azure_endpoint": "https://x.openai.azure.com/", "azure_deployment": "d"})
    result = {"rows": [{"inputs.item_id": "a", "outputs.groundedness.groundedness": 4.0}],
              "metrics": {"groundedness.groundedness": 4.0}}
    url = fe.log_to_foundry(result, {"groundedness": ev}, "https://r.services.ai.azure.com/api/projects/p", "CaptionVAR t", None)
    assert url == "https://ai.azure.com/x"
    assert calls[0] == ("init", "https://r.services.ai.azure.com/api/projects/p")
    assert calls[1][1] == ["instance_results.jsonl"] and calls[2] == ("start", "CaptionVAR t")
    assert calls[3] == ("update", "run-1", "Completed")
