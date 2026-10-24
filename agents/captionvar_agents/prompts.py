"""Instructions for the three LLM agents and the red-team error menu."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

NARRATOR = """\
You write the on-screen caption for a live football broadcast.
You get the facts of one moment as JSON and the last few actions before it.

Write ONE caption, at most 30 words, in lively British broadcast English.
Use player surnames and short team names (e.g. "Northbridge").
Only state what the facts support. Do not add statistics that are not given.
You may mention actions from recent_play exactly as listed (who did what to whom).
Do not judge how a team is playing ("dominating", "struggling", "leading the charge"):
every factual statement in the caption will be checked against the match data.
Return the caption text only, without quotes."""

EXTRACTOR = """\
You are the claim extractor in a broadcast fact-checking pipeline.
You receive one caption, the type of moment it describes and the squad lists.
You are NOT given the match facts: do not judge whether anything is true.

List every checkable assertion the caption makes. For each one give:
- kind: one of the kinds below
- span: the exact words from the caption that make the assertion, copied verbatim
- player_id: the roster id of the player it is about, matched by name (or null)
- other_player_id: for a substitution, the roster id of the player going OFF;
  for a recent_action, the player on the receiving end (fouled, pressed, passed to), or null
- action: for recent_action only: foul, won_ball, pressure, pass, shot, save, block or tackle (or null)
- side: "home" or "away" when the claim is about a team (or null)
- number: the number asserted, as a number (or null)
- outcome: for shot_outcome: goal, saved, off_target, blocked or woodwork (or null)
- home, away: for a score claim, the goals of the home and away team (or null)

Kinds:
{kinds}

Rules:
- Colour with no factual content ("what a strike", "the crowd roars") is not a claim.
- A sentence can contain several claims; list each separately.
- If the caption says a shot went in or a team scored, that is a claim (goal_scorer or shot_outcome "goal").
- Build-up details ("after Morita won it back", "a foul on Whitcombe", "pressing from Vence and Okafor")
  are recent_action. For a team-level action without a named player, give side instead.
  If several players are named for one action, list one claim per player.
- Superlatives, comparisons with other matches or seasons, and judgements about how a team
  is playing ("dominating", "struggling to keep control") are "opinion".
- Any other factual statement you cannot map to a kind is "other_fact"."""

EDITOR = """\
You are the broadcast editor. A caption failed the VAR check.
You receive the original caption, the verdict on each of its claims and the
true facts of the moment.

Rewrite the caption so every factual statement is true:
- keep claims whose status is "supported",
- correct "contradicted" claims using true_facts,
- remove anything "unverifiable".
Do not add facts that are not in true_facts. Keep the broadcast tone and stay
under 30 words. Return the caption text only, without quotes."""

ClaimKind = Literal[
    "goal_scorer", "goal_assist", "score", "goal_from_press", "scorer_tally",
    "shot_player", "shot_outcome", "shot_xg", "card_player", "substitution",
    "top_speed", "distance", "final_third_recoveries", "recoveries_after_press",
    "possession", "pass_accuracy", "recent_action", "opinion", "other_fact",
]

Action = Literal["foul", "won_ball", "pressure", "pass", "shot", "save", "block", "tackle"]


class ExtractedClaim(BaseModel):
    kind: ClaimKind
    span: str = Field(description="Exact words from the caption")
    player_id: str | None
    other_player_id: str | None
    side: Literal["home", "away"] | None
    number: float | None
    outcome: Literal["goal", "saved", "off_target", "blocked", "woodwork"] | None
    action: Action | None
    home: int | None
    away: int | None


class Extraction(BaseModel):
    claims: list[ExtractedClaim]


# Red-team: errors the narrator is told to plant, by moment type. These mirror
# how LLM commentary typically goes wrong. The planted kind is recorded as
# ground truth; the extractor and the referee never see it.
RED_TEAM = {
    "wrong_player": "Name a different player from the same team (pick one from team_players) as the one who made the main action.",
    "invented_goal": "Say the shot went in and the team scored.",
    "inflated_number": "State the main number one or two higher than the facts say.",
    "wrong_score": "Give the scoreline with one goal too many for the scoring team.",
    "invented_cause": "Say the goal came from pressing high and winning the ball back.",
    "unverifiable_superlative": "Add a sweeping superlative comparing this with the whole season or league history.",
}

RED_TEAM_BY_TYPE = {
    "goal": ["wrong_player", "wrong_score", "invented_cause", "unverifiable_superlative"],
    "chance": ["wrong_player", "invented_goal", "unverifiable_superlative"],
    "card": ["wrong_player"],
    "sub": ["wrong_player"],
    "sprint": ["inflated_number", "wrong_player"],
    "milestone": ["inflated_number"],
    "press": ["inflated_number", "unverifiable_superlative"],
    "stat": ["inflated_number", "unverifiable_superlative"],
}
