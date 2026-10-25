"""A chat client that needs no model, for tests and offline runs.

It answers as the agents would, using the test narrator, analyst and recap
writer from the factbox: the narrator returns the test narrator's line
(including any planted error), the analyst and the recap writer return the
test lines (planting an error when the red team asks), the extractor returns
the claims of whichever line it is given, and the editors return the text
unchanged, so a failed caption falls back to the template and a failed line
is dropped. The full Agent Framework workflow -- agents,
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
        self.all_known = False
        # Claims of lines written by the test analyst and recap writer, by text.
        self.line_claims: dict[str, list] = {}

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
        if "caption_to_check" in user:  # baseline judge: accepts everything
            reply = json.dumps({"ok": True, "problems": []})
        elif "your_caption" in user:  # baseline self-check: changes nothing
            reply = user["your_caption"]
        elif "problems" in user:  # baseline judge editor
            reply = user["caption"]
        elif "caption_on_air" in user:
            reply = await self._analyse(user)
        elif "recap_facts" in user:
            reply = await self._recap(user)
        elif "original_line" in user:
            reply = user["original_line"]  # cannot write prose: the line is dropped
        elif "moment" in user:
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

    async def _analyse(self, user: dict) -> str:
        plant = "inflated_number" if "red_team_instruction" in user else None
        sim = await self.factbox.call("simulated_insight", index=user["index"], plant=plant)
        self.line_claims[sim["text"]] = sim["extracted"]
        return sim["text"]

    async def _recap(self, user: dict) -> str:
        which = "HT" if user["recap_facts"]["recap"] == "half-time" else "FT"
        plant = "wrong_player" if "red_team_instruction" in user else None
        sim = await self.factbox.call("simulated_recap", recap=which, plant=plant)
        for sentence in sim["sentences"]:
            self.line_claims[sentence["text"]] = sentence["extracted"]
        return json.dumps({"sentences": [x["text"] for x in sim["sentences"]], "planted_sentence": sim["planted_sentence"]})

    async def _extract(self, user: dict) -> str:
        caption = user["caption"]
        fields = ("player_id", "other_player_id", "side", "number", "outcome", "home", "away", "action", "metric")
        if caption in self.line_claims:
            return json.dumps({"claims": [{"kind": c["kind"], "span": c["span"], **{f: c.get(f) for f in fields}} for c in self.line_claims[caption]]})
        index = next((i for i, t in self.texts.items() if t == caption), None)
        if index is None and not self.all_known:
            # A caption this client did not narrate (e.g. a baseline re-check): learn every test caption.
            for i in range((await self.factbox.call("info"))["moments"]):
                self.texts.setdefault(i, (await self.factbox.call("simulated", index=i, seed=self.narrator_seed))["text"])
            self.all_known = True
            index = next((i for i, t in self.texts.items() if t == caption), None)
        if index is None:
            return json.dumps({"claims": []})  # edited text: handled by the template path below
        sim = await self.factbox.call("simulated", index=index, seed=self.narrator_seed)
        claims = [{"kind": c["kind"], "span": c["span"], **{f: c.get(f) for f in fields}} for c in sim["extracted"]]
        return json.dumps({"claims": claims})

    async def _edit(self, user: dict) -> str:
        # The scripted editor cannot write prose; it reuses the original text so
        # the workflow exercises its retry budget and then the template path.
        return user["original_caption"]
