"""The live server end to end, offline: a real HTTP server, the scripted model, the referee over MCP.

Checks the SSE stream carries the same decisions as run_match.py for the same
moments, and the cost guards: one run at a time, the kill switch, the call cap.
"""
import asyncio
import json
import socket
import sys
import threading
import time
from pathlib import Path

import httpx
import uvicorn

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import live_server  # noqa: E402
from captionvar_agents.live import live_moments  # noqa: E402
from captionvar_agents.scripted import ScriptedChatClient  # noqa: E402
from test_workflow_offline import run, untimed  # noqa: E402

TRACE = json.loads((ROOT.parent / "public" / "traces" / "foundry-demo.json").read_text(encoding="utf-8"))
DECISION_KEYS = set(TRACE["decisions"][0]) - {"insight"}


def serve(tmp_path, monkeypatch, **env):
    for k, v in {"LIVE_OFFLINE_DELAY": "0", **env}.items():
        monkeypatch.setenv(k, v)
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<!doctype html><html><head><title>t</title></head><body></body></html>", encoding="utf-8")
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(live_server.create_app(live_server.Settings(offline=True), dist=dist),
                                           host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    for _ in range(100):
        if server.started:
            break
        time.sleep(0.05)
    return server, f"http://127.0.0.1:{port}"


def read_stream(base: str) -> list[dict]:
    events = []
    with httpx.stream("GET", f"{base}/captionvar/api/live/stream", timeout=120) as r:
        assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
        for line in r.iter_lines():
            if line.startswith("data: "):
                events.append(json.loads(line[6:]))
    return events


def test_live_run_streams_trace_decisions(tmp_path, monkeypatch):
    server, base = serve(tmp_path, monkeypatch)
    try:
        assert httpx.get(f"{base}/healthz").json()["ok"] is True
        assert 'name="captionvar-live"' in httpx.get(f"{base}/captionvar/").text
        status = httpx.get(f"{base}/captionvar/api/live/status").json()
        assert status["available"] and status["offline"] and status["state"] == "idle"
        started = httpx.post(f"{base}/captionvar/api/live/start").json()
        assert started["state"] == "running" and started["runs_today"] == 1
        # A second viewer joins the same run instead of starting another.
        assert httpx.post(f"{base}/captionvar/api/live/start").json()["runs_today"] == 1
        events = read_stream(base)
        # Once finished, the run is offered again from the cache, without a new run.
        cached = read_stream(base)
    finally:
        server.should_exit = True

    assert [e["type"] for e in events] == ["start"] + ["decision"] * 4 + ["end"]
    start, end = events[0], events[-1]
    assert start["match_id"] == TRACE["match_id"] and len(start["moments"]) == 4
    assert start["moments"][0]["display_minute"] == "24'"
    assert end["reason"] == "done" and end["usage"]["llm_calls"] <= start["max_calls"]
    decisions = [e["decision"] for e in events[1:-1]]
    for d in decisions:
        assert DECISION_KEYS <= set(d), DECISION_KEYS - set(d)
        assert d["aired"]["verified"] is True
    assert [d["seq"] for d in decisions] == [m["seq"] for m in start["moments"]]
    assert any(d.get("insight") for d in decisions)
    assert cached[0]["cached"] is True and [e["type"] for e in cached] == [e["type"] for e in events]

    # The same moments through run_match.py give the same captions (the live
    # run plans its own red team for the lines of context, so those may differ).
    recorded = run(tmp_path, from_minute=24, limit=4)
    no_line = lambda ds: [{k: v for k, v in untimed(d).items() if k != "insight"} for d in ds]  # noqa: E731
    assert no_line(decisions) == no_line(recorded["decisions"])
    assert [bool(d.get("insight")) for d in decisions] == [bool(d.get("insight")) for d in recorded["decisions"]]


def test_kill_switch_and_daily_cap_keep_the_replay(tmp_path, monkeypatch):
    server, base = serve(tmp_path, monkeypatch, LIVE_ENABLED="0")
    try:
        status = httpx.get(f"{base}/captionvar/api/live/status").json()
        assert status["enabled"] is False and status["available"] is False and "switched off" in status["reason"]
        r = httpx.post(f"{base}/captionvar/api/live/start")
        assert r.status_code == 503 and r.json()["runs_today"] == 0
        assert [e["type"] for e in read_stream(base)] == ["unavailable"]
    finally:
        server.should_exit = True

    monkeypatch.setenv("LIVE_ENABLED", "1")
    monkeypatch.setenv("LIVE_DAILY_RUNS", "0")
    hub = live_server.LiveHub(live_server.Settings(offline=True))
    assert "used up" in hub.blocked()


def test_a_run_stops_at_its_call_cap():
    async def go():
        return [e async for e in live_moments(client_factory=ScriptedChatClient, model="m", offline=True, max_calls=8)]
    events = asyncio.run(go())
    end = events[-1]
    assert end["type"] == "end" and end["reason"].startswith("call cap reached")
    assert end["usage"]["llm_calls"] <= 8 and end["decisions"] < end["moments"]
