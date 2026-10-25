"""Async client for the referee and the rest of the deterministic side.

All deterministic work -- spotting moments, checking claims, rendering safe
captions -- runs in the same JavaScript modules that the browser uses and the
unit tests cover (scripts/factbox-ops.mjs). The agents only ever reach it
through `Factbox.call`, over one of two transports:

* ``mcp`` (default): the MCP server in scripts/referee-mcp.mjs. Each call is
  an MCP ``tools/call``, traced as its own span, so the referee is a tool any
  MCP client can use, not code private to this workflow.
* ``jsonl``: scripts/factbox.mjs, one JSON request per line. Same code, no
  MCP dependency; set CAPTIONVAR_FACTBOX=jsonl to use it.
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
from contextlib import AsyncExitStack
from pathlib import Path
from typing import Any

from opentelemetry import trace

REPO_ROOT = Path(__file__).resolve().parents[2]
TRACER = trace.get_tracer("captionvar")

# Factbox operation -> MCP tool (kept in sync with TOOLS in scripts/referee-mcp.mjs).
OP_TO_TOOL = {
    "info": "match_info",
    "moments": "list_moments",
    "extractor_packet": "extractor_view",
    "verify": "check_caption",
    "editor_packet": "editor_view",
    "template": "caption_from_data",
    "decision_header": "moment_header",
    "simulated": "test_narrator_caption",
}


class FactboxError(RuntimeError):
    pass


class Factbox:
    def __init__(self, seed: str = "captionvar-demo-6", node: str | None = None, transport: str | None = None) -> None:
        self.seed = seed
        self.node = node or shutil.which("node") or "node"
        self.transport = (transport or os.environ.get("CAPTIONVAR_FACTBOX") or "mcp").lower()
        if self.transport not in ("mcp", "jsonl"):
            raise ValueError(f"unknown factbox transport {self.transport!r}; use 'mcp' or 'jsonl'")
        self._proc: asyncio.subprocess.Process | None = None
        self._session: Any = None
        self._stack: AsyncExitStack | None = None
        self._lock = asyncio.Lock()
        self._next_id = 0

    async def __aenter__(self) -> "Factbox":
        if self.transport == "mcp":
            await self._open_mcp()
        else:
            await self._open_jsonl()
        return self

    async def __aexit__(self, *exc: object) -> None:
        if self._stack:
            await self._stack.aclose()
            self._stack = self._session = None
        if self._proc and self._proc.returncode is None:
            self._proc.stdin.close()
            await self._proc.wait()

    async def call(self, op: str, **params: Any) -> Any:
        if self._session:
            return await self._call_mcp(op, params)
        if self._proc:
            return await self._call_jsonl(op, params)
        raise FactboxError("factbox is not running; use 'async with Factbox()'")

    # ----------------------------------------------------------------- MCP

    async def _open_mcp(self) -> None:
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client

        params = StdioServerParameters(
            command=self.node,
            args=[str(REPO_ROOT / "scripts" / "referee-mcp.mjs"), "--seed", self.seed],
            cwd=str(REPO_ROOT),
        )
        self._stack = AsyncExitStack()
        read, write = await self._stack.enter_async_context(stdio_client(params))
        self._session = await self._stack.enter_async_context(ClientSession(read, write))
        await self._session.initialize()
        tools = {t.name for t in (await self._session.list_tools()).tools}
        missing = set(OP_TO_TOOL.values()) - tools
        if missing:
            raise FactboxError(f"referee MCP server is missing tools: {', '.join(sorted(missing))}")

    async def _call_mcp(self, op: str, params: dict) -> Any:
        tool = OP_TO_TOOL.get(op)
        if not tool:
            raise FactboxError(f"unknown op {op}")
        # Named and tagged after the OpenTelemetry conventions for MCP.
        with TRACER.start_as_current_span(f"tools/call {tool}") as span:
            span.set_attributes({"mcp.method.name": "tools/call", "gen_ai.tool.name": tool, "mcp.server.name": "captionvar-referee"})
            result = await self._session.call_tool(tool, params)
            body = "".join(getattr(c, "text", "") for c in result.content)
            # `is_error` in mcp 2.x, `isError` in 1.x.
            if getattr(result, "is_error", None) or getattr(result, "isError", None):
                span.set_attribute("error.type", "tool_error")
                raise FactboxError(f"{tool}: {body}")
            return json.loads(body)

    # --------------------------------------------------------------- JSONL

    async def _open_jsonl(self) -> None:
        self._proc = await asyncio.create_subprocess_exec(
            self.node,
            str(REPO_ROOT / "scripts" / "factbox.mjs"),
            "--seed",
            self.seed,
            cwd=str(REPO_ROOT),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            limit=32 * 1024 * 1024,
        )

    async def _call_jsonl(self, op: str, params: dict) -> Any:
        async with self._lock:
            self._next_id += 1
            req = {"id": self._next_id, "op": op, **params}
            self._proc.stdin.write((json.dumps(req) + "\n").encode())
            await self._proc.stdin.drain()
            line = await self._proc.stdout.readline()
        if not line:
            raise FactboxError("factbox exited unexpectedly")
        res = json.loads(line)
        if not res.get("ok"):
            raise FactboxError(f"{op}: {res.get('error')}")
        return res["result"]
