"""Async client for the Node factbox (scripts/factbox.mjs).

All deterministic work -- spotting moments, checking claims, rendering safe
captions -- runs in the same JavaScript modules that the browser uses and the
unit tests cover. The agents only ever talk to it through these calls.
"""
from __future__ import annotations

import asyncio
import json
import shutil
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]


class FactboxError(RuntimeError):
    pass


class Factbox:
    def __init__(self, seed: str = "captionvar-demo-6", node: str | None = None) -> None:
        self.seed = seed
        self.node = node or shutil.which("node") or "node"
        self._proc: asyncio.subprocess.Process | None = None
        self._lock = asyncio.Lock()
        self._next_id = 0

    async def __aenter__(self) -> "Factbox":
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
        return self

    async def __aexit__(self, *exc: object) -> None:
        if self._proc and self._proc.returncode is None:
            self._proc.stdin.close()
            await self._proc.wait()

    async def call(self, op: str, **params: Any) -> Any:
        if not self._proc:
            raise FactboxError("factbox is not running; use 'async with Factbox()'")
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
