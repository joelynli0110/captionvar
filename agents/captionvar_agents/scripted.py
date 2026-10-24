"""A chat client that needs no model, for tests and offline runs.

It answers as the three agents would, using the test narrator's captions
from the factbox: the narrator returns the test narrator's line (including any
planted error), the extractor returns that line's claims, and the editor
returns the safe template. The full Agent Framework workflow -- agents,
executors, conditional edges, the edit loop -- runs exactly as with Foundry.
"""
import json
from typing import Any

from agent_framework import BaseChatClient, ChatResponse, Message

from .factbox import Factbox


class ScriptedChatClient(BaseChatClient):
    OTEL_PROVIDER_NAME = "scripted"
    # Test hooks: simulate a throttled deployment or a moment that fails once.
    rate_limit_first_calls = 0
    fail_moments_once: set = set()

    def __init__(self, factbox: Factbox, narrator_seed: str = "narrator-10") -> None:
        super().__init__()
        self.factbox = factbox
        self.narrator_seed = narrator_seed
        self.texts: dict[int, str] = {}

    async def _inner_get_response(self, *, messages: Any, stream: bool, options: Any, **kwargs: Any) -> ChatResponse:
        if stream:
            raise NotImplementedError("scripted client does not stream")
        # Each agent receives a differently shaped JSON payload.
        user = json.loads(messages[-1].text)
        if ScriptedChatClient.rate_limit_first_calls > 0:
            ScriptedChatClient.rate_limit_first_calls -= 1
            raise RuntimeError("Error code: 429 - rate_limit_exceeded (simulated)")
        index = user.get("moment", {}).get("index")
        if index in ScriptedChatClient.fail_moments_once:
            ScriptedChatClient.fail_moments_once.discard(index)
            raise RuntimeError(f"simulated outage on moment {index}")
        if "moment" in user:
            reply = await self._narrate(user)
        elif "roster" in user:
            reply = await self._extract(user)
        else:
            reply = await self._edit(user)
        usage = {"input_token_count": len(messages[-1].text) // 4, "output_token_count": len(reply) // 4}
        return ChatResponse(messages=[Message("assistant", [reply])], usage_details=usage, response_format=(options or {}).get("response_format"))

    async def _narrate(self, user: dict) -> str:
        index = user["moment"]["index"]
        sim = await self.factbox.call("simulated", index=index, seed=self.narrator_seed)
        self.texts[index] = sim["text"]
        return sim["text"]

    async def _extract(self, user: dict) -> str:
        caption = user["caption"]
        index = next((i for i, t in self.texts.items() if t == caption), None)
        if index is None:
            return json.dumps({"claims": []})  # edited text: handled by the template path below
        sim = await self.factbox.call("simulated", index=index, seed=self.narrator_seed)
        fields = ("player_id", "other_player_id", "side", "number", "outcome", "home", "away")
        claims = [{"kind": c["kind"], "span": c["span"], **{f: c.get(f) for f in fields}} for c in sim["extracted"]]
        return json.dumps({"claims": claims})

    async def _edit(self, user: dict) -> str:
        # The scripted editor cannot write prose; it reuses the original text so
        # the workflow exercises its retry budget and then the template path.
        return user["original_caption"]
