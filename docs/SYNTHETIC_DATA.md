# Synthetic match data

CaptionVAR ingests a **fully synthetic, football-realistic event stream** produced by a seeded match simulator (`src/sim/`). No real clubs, players, footage or league data are used.

```bash
npm run match                                   # demo match -> src/data/matches/syn-nbr-rvu-captionvar-demo-6.json
npm run match -- --seed derby-7 --out data/derby-7.json
npm run match -- --story none                   # no scripted moments
npm run match -- --stream --speed 60            # NDJSON on stdout, paced on the match clock (60x)
npm run calibrate                               # per-team averages over many seeds vs. reference ranges
```

## Why a simulator instead of a hand-written fixture

| Need | How the simulator meets it |
|---|---|
| Live ingestion | `liveFeed()` releases events on the match clock at any speed; `windowedFeed()` groups them into narrator windows. |
| Realistic statistics | A possession-based model (pressure → tackle/foul → pass/carry/shot) calibrated against top-flight per-team averages (see below). |
| Explainability that can be checked | Events are causally linked: a recovery records the pressure that preceded it (`linked_pressure_id`), a shot its key pass, a goal its shot and assist. Claims like "the press won the ball back" are verifiable, not just plausible. |
| Ground truth for evaluation | A *director* injects story beats (goals, pressing spells). Their event IDs are returned in `script`, so hallucination tests have known answers. |
| Reproducibility | Same seed and config ⇒ byte-identical match. Every demo, test and evaluation case refers to stable event IDs. |
| Trust in the data itself | `validateMatch()` checks invariants (ordering, clock, squads on the pitch, goal ↔ shot ↔ score consistency, pressure links, script integrity). Generation fails loudly on any violation. |

## Calibration (40 seeds, mean per team per match)

| Stat | Simulated | Reference band |
|---|---:|---:|
| Passes / accuracy | 570 / 85.4% | 400–600 / 77–88% |
| Shots / on target | 13.7 / 5.2 | 10–16 / 3–6 |
| Pressures | 134 | 100–180 |
| Tackles / interceptions | 21.4 / 11.1 | 12–22 / 7–14 |
| Fouls / yellow cards | 8.5 / 1.4 | 8–13 / 1–3 |
| Corners / offsides | 4.0 / 2.6 | 3–7 / 1–3 |

About 2,150 events per match. Unscripted conversion is deliberately damped (`naturalGoalFactor`, default 0.3) so the scripted story dominates the scoreline; set it to `1` for unscripted matches. xG comes from a transparent logistic distance/angle model (`src/sim/pitch.js`), documented as a synthetic estimator — not a commercial xG model.

## The demo match (`seed: captionvar-demo-6`)

Northbridge FC 2–1 Riverside United, 2,257 events, possession 66.9%–33.1%, xG 1.85–1.04.

| Minute | Moment | Ground-truth IDs |
|---|---|---|
| 24' | Riverside score on the break (Strand, assist Benedetti) | `G-0559` |
| 69'–77' | Northbridge high-press spell: 4 attacking-third recoveries in 8 minutes (≈3× their normal rate) | `script[1]` window |
| 77' | Equaliser from a high turnover: pressure → tackle → recovery → 2 passes → shot → goal | `PR-1812 → T-1813 → R-1814 → … → G-1819` |
| 89' | Late winner (Marsh, assist Ashkenazi) | `G-2085` |

## Coordinates

`x, y` are 0–100 in a fixed broadcast frame. The home team attacks towards `x = 100` in the first half and `x = 0` in the second. `zone` (`defensive_third | middle_third | attacking_third`) and `channel` (`left | centre | right`) are **relative to the acting team**, so "recovered the ball in the attacking third" means the same thing for both sides.

## Event schema (v1.0)

Every event:

| Field | Meaning |
|---|---|
| `id` | Type prefix + global sequence, e.g. `P-0412`, `R-1814`, `G-1819` |
| `seq` | 1-based order in the stream |
| `type` | see below |
| `period`, `t`, `minute`, `second` | Match clock (`t` in seconds; the second half starts at 2700) |
| `display_minute`, `stoppage_time` | Broadcast label, e.g. `45+2'` |
| `team`, `team_id`, `side` | Acting team (`home` / `away`) |
| `player_id`, `player` | Acting player |
| `x`, `y`, `zone`, `channel` | Location |
| `end_x`, `end_y`, `end_zone` | End location (passes, carries, shots, clearances) |
| `possession_id`, `possession_team_id` | Possession sequence the event belongs to |

Type-specific fields:

| Type | Fields |
|---|---|
| `pass` | `recipient_id`, `successful`, `outcome` (`complete` `intercepted` `incomplete` `cleared` `out_of_play` `offside`), `pass_type` (`short` `back` `long` `through_ball` `switch` `cross`), `set_piece` (`kick_off` `throw_in` `goal_kick` `corner` `free_kick`), `height`, `distance_m`, `ball_speed_kmh`, `difficulty` (0–1), `progressive`, `under_pressure`, `possession_change` |
| `carry` | `distance_m`, `under_pressure` |
| `pressure` | `target_id` (ball carrier) |
| `tackle` | `target_id`, `won` |
| `interception` | `pass_id` |
| `recovery` | Possession won in open play. `how` (`tackle` `interception` `loose_ball`), `possession_change`, `after_pressure`, `linked_pressure_id` (a pressure by the same team ≤ 5 s earlier) |
| `shot` | `xg`, `distance_m`, `body_part`, `situation` (`open_play` `counter` `corner` `free_kick` `penalty`), `shot_speed_kmh`, `on_target`, `outcome` (`goal` `saved` `off_target` `blocked` `woodwork`), `key_pass_id` |
| `goal` | `scorer_id`, `assist_id`, `shot_id`, `confirmed`, `score` (running) |
| `save` / `block` | `shot_id`; saves also `held` |
| `clearance` | `headed` |
| `foul` / `card` | `fouled_id`; `card` (`yellow` `second_yellow`) |
| `offside` | flagged receiver |
| `substitution` | `player_off_id`, `player_on_id`, `position` |
| `sprint` | Threshold indicator: `top_speed_kmh` (≥ `threshold_kmh` = 30), `sprint_distance_m`, `total_distance_km` |
| `physical_milestone` | `milestone_km` (10, 11, 12), `total_distance_km` |
| `period_start` / `period_end` | `period_label`, `score` at the end |

Top level: `schema_version`, `synthetic: true`, `meta` (match id, seed, final score, stoppage time, coordinate system), `squads` (fictional players with position and attributes), `script` (story beats with their event IDs), `events`.

## Modules

| File | Role |
|---|---|
| `src/sim/generateMatch.js` | Simulation engine and story director |
| `src/sim/teams.js` | Fictional squads and team style profiles |
| `src/sim/pitch.js` | Geometry, zones, xG model |
| `src/sim/stats.js` | Deterministic aggregates (the numbers claims are checked against) |
| `src/sim/validate.js` | Invariants |
| `src/sim/stream.js` | Live replay and windowing |
| `scripts/generate_match.mjs` | CLI |
| `scripts/calibrate_sim.mjs` | Calibration report |
