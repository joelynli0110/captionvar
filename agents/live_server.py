"""CaptionVAR live server: the built site plus a short live run of the agents, streamed.

    npm run build
    python agents/live_server.py --offline          # scripted model, no Azure
    python agents/live_server.py                    # Foundry: FOUNDRY_PROJECT_ENDPOINT, FOUNDRY_MODEL

Serves dist/ at /captionvar/ (the same build as GitHub Pages) and:

    GET  /healthz                    liveness
    GET  /captionvar/api/live/status what the live mode can do right now
    POST /captionvar/api/live/start  start a live run, or join the one in progress
    GET  /captionvar/api/live/stream the run as Server-Sent Events (start, decision..., end)

Cost guards: one run at a time (others watch the same run), a hard cap on
model calls per run, a daily cap on runs and on calls, a cached run reused for
LIVE_CACHE_MINUTES, and LIVE_ENABLED=0 switches live runs off (the replay
still works). The daily counters live in memory; keep max replicas at 1.

Environment (defaults in brackets):
    LIVE_ENABLED [1]  LIVE_OFFLINE [0]  LIVE_FROM_MINUTE [24]  LIVE_MOMENTS [4]
    LIVE_MAX_CALLS [60]  LIVE_DAILY_RUNS [20]  LIVE_DAILY_CALLS [800]
    LIVE_CACHE_MINUTES [10]  LIVE_RPM [30]  LIVE_RED_TEAM [0.5]  LIVE_RED_TEAM_SEED [live-8]
    LIVE_OFFLINE_DELAY [3]
    LIVE_TRACE [0]  APPLICATIONINSIGHTS_CONNECTION_STRING (optional)
    FOUNDRY_PROJECT_ENDPOINT, FOUNDRY_MODEL (unless offline)
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from starlette.applications import Starlette  # noqa: E402
from starlette.requests import Request  # noqa: E402
from starlette.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response, StreamingResponse  # noqa: E402
from starlette.routing import Mount, Route  # noqa: E402
from starlette.staticfiles import StaticFiles  # noqa: E402

from captionvar_agents.live import live_moments  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[1]
BASE = "/captionvar"
LOG = logging.getLogger("captionvar.live")


def env_flag(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    return default if value is None else value.strip().lower() in ("1", "true", "yes", "on")


def env_num(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


class Settings:
    def __init__(self, offline: bool | None = None) -> None:
        self.enabled = env_flag("LIVE_ENABLED", True)
        self.offline = env_flag("LIVE_OFFLINE", False) if offline is None else offline
        self.model = "scripted (no model)" if self.offline else os.environ.get("FOUNDRY_MODEL", "")
        self.endpoint = os.environ.get("FOUNDRY_PROJECT_ENDPOINT", "")
        self.from_minute = int(env_num("LIVE_FROM_MINUTE", 24))
        self.moments = int(env_num("LIVE_MOMENTS", 4))
        self.max_calls = int(env_num("LIVE_MAX_CALLS", 60))
        self.daily_runs = int(env_num("LIVE_DAILY_RUNS", 20))
        self.daily_calls = int(env_num("LIVE_DAILY_CALLS", 800))
        self.cache_s = env_num("LIVE_CACHE_MINUTES", 10) * 60
        self.rpm = env_num("LIVE_RPM", 30)
        self.red_team = env_num("LIVE_RED_TEAM", 0.5)
        # Seeded: with the defaults the red team plants a wrong score in the 24' goal, as in the recorded run.
        self.red_team_seed = os.environ.get("LIVE_RED_TEAM_SEED", "live-8")
        # Offline only: seconds between decisions, so the page behaves as it would with a model.
        self.offline_delay = env_num("LIVE_OFFLINE_DELAY", 3) if self.offline else 0.0
        self.trace = env_flag("LIVE_TRACE", False) or bool(os.environ.get("APPLICATIONINSIGHTS_CONNECTION_STRING"))

    def misconfigured(self) -> str | None:
        if self.offline:
            return None
        missing = [n for n, v in (("FOUNDRY_PROJECT_ENDPOINT", self.endpoint), ("FOUNDRY_MODEL", self.model)) if not v]
        return f"missing {', '.join(missing)}" if missing else None


class LiveHub:
    """One live run at a time. Every viewer of the run gets every event, from the start."""

    def __init__(self, settings: Settings) -> None:
        self.s = settings
        self.events: list[dict] = []
        self.running = False
        self.finished_at: float | None = None
        self.listeners: set[asyncio.Queue] = set()
        self.day = ""
        self.runs_today = 0
        self.calls_today = 0
        self.task: asyncio.Task | None = None
        self._tracing = False

    def _roll_day(self) -> None:
        today = time.strftime("%Y-%m-%d", time.gmtime())
        if today != self.day:
            self.day, self.runs_today, self.calls_today = today, 0, 0

    def cached(self) -> bool:
        return not self.running and self.finished_at is not None and time.time() - self.finished_at < self.s.cache_s

    def blocked(self) -> str | None:
        """Why a new run cannot start, or None."""
        self._roll_day()
        if not self.s.enabled:
            return "Live runs are switched off. This is the recorded run."
        if bad := self.s.misconfigured():
            return f"Live runs are not configured ({bad}). This is the recorded run."
        if self.runs_today >= self.s.daily_runs:
            return f"Today's {self.s.daily_runs} live runs are used up. This is the recorded run."
        if self.calls_today + self.s.max_calls > self.s.daily_calls:
            return "Today's model-call budget is used up. This is the recorded run."
        return None

    def status(self) -> dict:
        self._roll_day()
        state = "running" if self.running else "cached" if self.cached() else "idle"
        return {
            "live": True,
            "enabled": self.s.enabled,
            "offline": self.s.offline,
            "model": self.s.model,
            "state": state,
            "available": state != "idle" or self.blocked() is None,
            "reason": None if state != "idle" else self.blocked(),
            "window": {"from_minute": self.s.from_minute, "moments": self.s.moments},
            "max_calls_per_run": self.s.max_calls,
            "runs_today": self.runs_today,
            "daily_runs": self.s.daily_runs,
            "cache_seconds_left": round(self.s.cache_s - (time.time() - self.finished_at)) if state == "cached" else None,
        }

    def start(self) -> dict:
        """Start a run unless one is running or cached; either way say what the viewer will watch."""
        if self.running or self.cached():
            return self.status()
        if reason := self.blocked():
            return {**self.status(), "available": False, "reason": reason}
        self.running = True
        self.events = []
        self.runs_today += 1
        self.task = asyncio.create_task(self._run())
        return self.status()

    def _publish(self, event: dict) -> None:
        if event["type"] == "end":
            # The run is over before its viewers hear so: a viewer who comes straight back gets the cache.
            self.running = False
            # Only a run that produced something is offered again.
            self.finished_at = time.time() if any(e["type"] == "decision" for e in self.events) else None
        self.events.append(event)
        for q in list(self.listeners):
            q.put_nowait(event)

    def _count_call(self) -> None:
        self.calls_today += 1

    def _client_factory(self, factbox):
        if self.s.offline:
            from captionvar_agents.scripted import ScriptedChatClient
            return ScriptedChatClient(factbox)
        from agent_framework.foundry import FoundryChatClient
        from azure.identity.aio import DefaultAzureCredential
        # Managed identity on Azure Container Apps; az login or env credentials elsewhere. No keys.
        self._credential = DefaultAzureCredential()
        client = FoundryChatClient(project_endpoint=self.s.endpoint, model=self.s.model, credential=self._credential)
        self._client = client
        return client

    async def _setup_tracing(self) -> None:
        if self._tracing or self.s.offline or not self.s.trace:
            return
        self._tracing = True
        try:
            conn = os.environ.get("APPLICATIONINSIGHTS_CONNECTION_STRING")
            if conn:
                from agent_framework.observability import create_metric_views, create_resource, enable_instrumentation
                from azure.monitor.opentelemetry import configure_azure_monitor
                configure_azure_monitor(connection_string=conn, views=create_metric_views(), resource=create_resource())
                enable_instrumentation(enable_sensitive_data=False)
            else:
                await self._client.configure_azure_monitor(enable_sensitive_data=False)
            LOG.info("tracing to Application Insights")
        except Exception as exc:  # noqa: BLE001 - tracing must never stop a run
            LOG.warning("tracing not set up: %s", exc)

    async def _run(self) -> None:
        self._client = self._credential = None
        try:
            gen = live_moments(
                client_factory=self._client_factory, model=self.s.model, offline=self.s.offline,
                from_minute=self.s.from_minute, limit=self.s.moments, red_team=self.s.red_team, red_team_seed=self.s.red_team_seed,
                rpm=self.s.rpm, max_calls=self.s.max_calls, on_call=self._count_call,
            )
            async for event in gen:
                if event["type"] == "start":
                    await self._setup_tracing()
                elif event["type"] == "decision" and self.s.offline_delay:
                    await asyncio.sleep(self.s.offline_delay)
                self._publish(event)
                LOG.info("live %s%s", event["type"], f" {event['decision']['id']}" if event["type"] == "decision" else "")
        except Exception as exc:  # noqa: BLE001 - a run that cannot start still ends cleanly for its viewers
            LOG.exception("live run failed: %s", exc)
            self._publish({"type": "end", "reason": "stopped: the run failed",
                           "decisions": sum(e["type"] == "decision" for e in self.events)})
        finally:
            if self._credential:
                try:
                    await self._credential.close()
                except Exception:  # noqa: BLE001
                    pass
            if not self.events or self.events[-1]["type"] != "end":
                self._publish({"type": "end", "reason": "stopped", "decisions": sum(e["type"] == "decision" for e in self.events)})

    async def stream(self):
        """SSE for the current or cached run; a single 'unavailable' event otherwise."""
        def sse(event: dict) -> str:
            return f"event: {event['type']}\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"

        if not self.running and not self.cached():
            yield sse({"type": "unavailable", "reason": self.blocked() or "No live run in progress. Start one first."})
            return
        cached = not self.running
        q: asyncio.Queue = asyncio.Queue()
        backlog = list(self.events)
        if self.running:
            self.listeners.add(q)
        try:
            for event in backlog:
                yield sse({**event, "cached": cached} if event["type"] == "start" else event)
            if cached:
                return
            if backlog and backlog[-1]["type"] == "end":
                return
            while True:
                try:
                    event = await asyncio.wait_for(q.get(), timeout=15)
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
                    continue
                yield sse(event)
                if event["type"] == "end":
                    return
        finally:
            self.listeners.discard(q)


def create_app(settings: Settings | None = None, dist: Path | None = None) -> Starlette:
    settings = settings or Settings()
    hub = LiveHub(settings)
    dist = dist or REPO_ROOT / "dist"
    index_file = dist / "index.html"

    def index(_: Request) -> Response:
        if not index_file.exists():
            return HTMLResponse("dist/index.html not found: run npm run build", status_code=500)
        # The marker tells the page it is served by this server; GitHub Pages has no such marker.
        html = index_file.read_text(encoding="utf-8").replace(
            "<head>", '<head>\n    <meta name="captionvar-live" content="1" />', 1)
        return HTMLResponse(html, headers={"Cache-Control": "no-cache"})

    async def healthz(_: Request) -> Response:
        return JSONResponse({"ok": True, "live": hub.status()["state"]})

    async def status(_: Request) -> Response:
        return JSONResponse(hub.status(), headers={"Cache-Control": "no-store"})

    async def start(_: Request) -> Response:
        result = hub.start()
        return JSONResponse(result, status_code=200 if result["available"] else 503, headers={"Cache-Control": "no-store"})

    async def stream(_: Request) -> Response:
        return StreamingResponse(hub.stream(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})

    routes = [
        Route("/healthz", healthz),
        Route("/", lambda _: RedirectResponse(f"{BASE}/")),
        Route(BASE, lambda _: RedirectResponse(f"{BASE}/")),
        Route(f"{BASE}/", index),
        Route(f"{BASE}/index.html", index),
        Route(f"{BASE}/api/live/status", status),
        Route(f"{BASE}/api/live/start", start, methods=["POST"]),
        Route(f"{BASE}/api/live/stream", stream),
    ]
    if dist.exists():
        routes.append(Mount(BASE, app=StaticFiles(directory=dist)))
    app = Starlette(routes=routes)
    app.state.hub = hub
    return app


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--offline", action="store_true", help="use the scripted model (no Azure); same as LIVE_OFFLINE=1")
    ap.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8000)))
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    import uvicorn
    uvicorn.run(create_app(Settings(offline=True if args.offline else None)), host=args.host, port=args.port)


if __name__ == "__main__":
    main()
