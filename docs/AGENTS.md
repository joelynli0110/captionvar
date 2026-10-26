# CaptionVAR agent pipeline

Built with **Microsoft Agent Framework** (Python) on **Microsoft Foundry**.

Per moment (one workflow run):

```
                 ┌──────────────────────── edit loop (≤ 2) ────────────────────────┐
                 ▼                                                                 │
Narrator ──► Extractor ──► Referee ──┬── passes / out of retries ──► Publisher ──► Analyst (LLM, key moments)
  (LLM)        (LLM)     (code, MCP) └── fails ──► Editor (LLM) ───────────────────┘        │
                 ▲                                                                           │
                 └─── the Analyst's line: Extractor ► Referee ► Line editor (≤ 1) or Line publisher ◄┘
```

Per recap (half-time and full time), every sentence on its own:

```
Recap writer ──► Extractor ──► Referee ──┬──► Line publisher (airs the sentence, or cuts it)
    (LLM)          (LLM)     (code, MCP) └──► Line editor (LLM, one rewrite) ──► Extractor
```

| Agent | Kind | Sees | Produces |
|---|---|---|---|
| Narrator | LLM | The moment's true facts and the last few actions, in words | One broadcast caption |
| Claim Extractor | LLM, structured output | The caption and squad lists **only, never the facts** | Typed claims with the exact words that make each one |
| Referee (VAR) | Deterministic code | Claims and the events observed **up to that moment** | Verdict per claim (holds / false / cannot be checked) with evidence event IDs |
| Editor | LLM | The verdict on each claim and the true facts | A repaired caption, which goes back through Extractor and Referee |
| Publisher | Code | The last checked version | The first version that passes; otherwise a caption rendered from the true facts. For goals, big chances, pressing spells and possession reports it hands the aired caption to the Analyst |
| Analyst | LLM | The aired caption, the moment's facts and the running numbers behind it (team totals, xG, minutes since the previous shot, shot on target or goal, possession over the last 10 minutes, the player's match totals) | One line on why the moment matters |
| Recap writer | LLM, structured output | Everything recorded up to the end of the half or match | A recap as a list of sentences |
| Line editor | LLM | A failed line or recap sentence, the verdict on each claim and the true numbers | One rewrite, checked again |
| Line publisher | Code | The last checked line or sentence | The line if it passed; otherwise nothing (it is cut) |

Design choices that matter for trust:

- **The referee is not a model.** Numbers, names and outcomes are compared by code with explicit tolerances (`src/broadcast/verify.js`), the same code the browser runs and the unit tests cover.
- **The extractor is blind to the truth.** It reports what was said, so it cannot quietly "fix" a claim before it is checked.
- **Code, not the model, decides what a claim refers to and whether it is core.** `src/broadcast/extracted.js` binds each extracted claim to the moment's event and assigns its role, so a model cannot weaken its own check.
- **Fail closed.** A caption with no checkable claim is withheld. That includes an extractor reply that never parses as the claim schema (seen with gpt-4.1-nano): it is retried twice, then treated as no claims, so the draft is rewritten or airs from the data instead of stopping the run. An editor rewrite airs only if it passes the same check; after two failed rewrites, a template built from the facts airs.
- **Build-up details are checked, not just trimmed.** "After Morita won it back", "a foul on Whitcombe" or "pressing from Vence" become `recent_action` claims, verified against the events of the same half in the two minutes before the moment. The event record is complete, so a named action that is not there is reported as false, with the player who actually did it. These are always detail claims: a failure trims that phrase, it never withholds the whole caption. Actions covered: foul, winning the ball, pressing, a pass, a run with the ball, losing the ball, a shot, a save, a block and a tackle; a shot is linked to the block or save that stopped it, and a caption about a shot can cite that save or block even though it is recorded a second later.
- **Every named player must be backed.** After the claim checks, code scans the caption for every player name in the squads. A name that no passing statement is about is flagged as unconfirmed, so a wrong name left in prose the extractor skipped (seen in a Foundry run: "Reyes sprints … Marsh recorded 34.9 km/h") cannot air. This applies to editor rewrites as much as to the narrator's first draft.
- **Every caption must report its moment.** A rewrite can be true in every word and still miss the point ("Pell's tackle … Reyes races forward" for Marsh's 34.9 km/h sprint, or "Northbridge hit 12 km" for one player's distance). Each moment type has a key fact (scorer, shooter, booked player, substitution, top speed, distance, recovery count, possession) that must be stated and verified; otherwise the caption is withheld and the moment airs from the data.
- **No comparisons beyond the match.** "The best strike of the season" or "finest save in league history" cannot be checked against match data. Code flags such phrases even when the extractor misses them (seen in a Foundry run), so they are trimmed rather than aired.
- **Percentages are not rounded generously.** A whole-number percentage must equal the actual value rounded down or up (61.0% allows only 61%; 62.6% allows 62% or 63%).
- **No future data.** The referee only sees events with `seq` up to the moment being captioned.
- **Red team.** A seeded plan tells the narrator to plant one specific kind of error in about a third of captions (wrong player, invented goal, inflated number, wrong score, invented cause, unverifiable superlative). Only the plan knows; the extractor and referee do not. The trace reports how many were caught, and separately how many other captions were flagged (these may be genuine narrator mistakes and are listed for review rather than scored). The Analyst gets its own plan (an inflated number, a total credited to the wrong player, or a comparison beyond the match) at the same rate, and one of the two recaps per run is told to carry a wrong scorer, an inflated total or a wrong score; the recap writer names which sentence it put it in, and that is used only for scoring.

### Lines of context and recaps

A line on why a moment matters, or a recap sentence, is checked by the same extractor and referee as a caption (`src/broadcast/statements.js`), with these rules:

- **Every fact must hold.** There is no trimming: a line with a false or uncheckable fact goes to the line editor once, and if the rewrite also fails, nothing airs. A caption always airs (corrected if need be); context is optional.
- **Interpretation is allowed, invention is not.** The point of the line is to say what the numbers show, so a judgement the extractor reports as `opinion` ("the press is pinning them back") is kept as framing, but only next to at least one checked fact, and never a comparison beyond the match.
- **Running totals are checked against the record.** New claim kinds: `team_total` (shots, shots on target, xG to ±0.05, corners, fouls, bookings, final-third recoveries so far), `player_total` (goals, assists, shots, recoveries, pressures, completed passes), `minutes_since` (a team's previous shot, shot on target or goal, on the match clock), `recent_possession` (last 10 minutes), `goal_event` and `card_event` (an earlier goal or booking, with scorer, assist and minute as stated). Captions can use them too.
- **A recap sees only its half.** The half-time recap is checked against events up to the half-time whistle, so a second-half goal in it is false.

### The referee as an MCP server

`scripts/referee-mcp.mjs` serves the deterministic side as read-only MCP tools on stdio: `check_caption` (the VAR check, for a caption, a line of context or a recap sentence), `extractor_view`, `editor_view`, `analyst_view`, `recap_view`, `line_editor_view`, `caption_from_data`, `list_moments`, `list_insight_moments`, `list_recaps`, `match_info`, `moment_header` and the test agents' outputs for offline runs. The workflow reaches all of them through an MCP client session (`agents/captionvar_agents/factbox.py`), and each `tools/call` is a span in the trace, named and tagged after the OpenTelemetry conventions for MCP.

The same tools work from any MCP client. `.vscode/mcp.json` registers the server for GitHub Copilot agent mode in VS Code, so you can ask Copilot to check a caption against the match.

`scripts/factbox.mjs` serves the same operations as one JSON request per line, without the MCP dependency; set `CAPTIONVAR_FACTBOX=jsonl` to use it. A test runs the workflow both ways and checks the decisions are identical. Either way, Python and the browser share one implementation of spotting, checking and rendering (`scripts/factbox-ops.mjs`).

## Run it on Microsoft Foundry

Prerequisites: Python 3.10+, Node.js 22+, the [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli), and a Foundry project with a `gpt-4.1-mini` deployment.

```powershell
# from the repository root
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r agents\requirements.txt
npm install

az login

# Foundry portal -> your project -> Overview -> "Project endpoint"
$env:FOUNDRY_PROJECT_ENDPOINT = "https://<resource>.services.ai.azure.com/api/projects/<project>"
$env:FOUNDRY_MODEL = "gpt-4.1-mini"      # your deployment name

# smoke test: 3 moments, a few cents of a cent
python agents\run_match.py --limit 3 --out public\traces\smoke.json

# full match (40 captions, about 19 lines of context and 2 recaps; a few minutes, roughly $0.10-0.20)
python agents\run_match.py --out public\traces\foundry-demo.json
```

`public/traces/foundry-demo.json` is picked up by the web app automatically: the VAR room then shows the Foundry agents' captions, with a switch back to the test narrator.

**Rate limits.** Model calls are spaced to `--rpm` requests per minute (default 30), `429` responses are retried after the server's `Retry-After`, and progress is saved after every moment to `<out>.partial.jsonl`: if a run stops, run the same command again and it resumes. Each call uses about 1,500 tokens, so keep `--rpm` below both the deployment's requests-per-minute and its tokens-per-minute divided by 1,500 (see the deployment's rate limit in the Foundry portal).

If a call fails with `401`/`403 PermissionDenied`, give your account the **Azure AI User** role on the Foundry resource (Access control (IAM) in the Azure portal) and run `az login` again.

## Trace it in Foundry

Each caption becomes one OpenTelemetry trace. The caption span is the root. Under it come the workflow run, each executor (narrator, extractor, referee, editor, publisher) and every model call. The referee's verdict is written onto its own span.

| Span | Attributes |
|---|---|
| `caption 77' goal` | `captionvar.red_team`, `captionvar.first_draft_verdict`, `captionvar.rewrites`, `captionvar.aired_by`, `captionvar.aired_text` |
| `executor.process referee` | `captionvar.attempt`, `captionvar.author`, `captionvar.verdict`, `captionvar.claims`, `captionvar.claims_false`, `captionvar.claims_unchecked`, `captionvar.evidence` |
| `invoke_agent …` / `chat …` | Model, token counts and latency, from Agent Framework |

One-time setup: connect an Application Insights resource to the Foundry project. The Foundry portal's menus change often; look for a **Tracing** or **Traces** page with a **Connect** button, or add it as a connected resource of the project (**Connected resources → Add connection → Application Insights**). You can pick an existing resource or create a new one. To read traces you need the **Log Analytics Reader** role on that resource.

```powershell
pip install -r agents\requirements.txt        # adds azure-monitor-opentelemetry
python agents\run_match.py --limit 5 --trace --out public\traces\trace-test.json
```

The script reads the connection string from the project, so nothing else needs configuring.

To read a trace, open the Application Insights resource in the Azure portal and go to **Investigate → Transaction search**. Traces arrive after 2–5 minutes. Search for `caption` (or a minute, such as `caption 7'`) and open a result: **End-to-end transaction details** shows the caption as one timeline, with the narrator, extractor, referee and editor calls in order, and the attributes above on each span. Selecting the `executor.process referee` span shows that attempt's verdict and evidence IDs. Depending on the portal version, the same traces may also appear on the Foundry project's tracing page.

`--trace-content` also records prompts and replies; leave it off unless you need them. A five-caption run sends a few hundred spans, well inside the Application Insights free allowance.

## Run it offline (no model)

```powershell
python agents\run_match.py --offline --out public\traces\offline-demo.json
python -m pytest agents\tests
```

The scripted client answers as the three agents using the test narrator, so the full workflow — agents, executors, conditional edges, the edit loop and the fallback — runs without any cloud resources.

## Baselines: what the multi-agent design adds

```powershell
python agents\run_baselines.py --trace public\traces\foundry-demo.json --out public\traces\baselines.json --rpm 30
```

Starting from the **same narrator drafts** as the published run (red-team errors included), it compares four set-ups:

| Set-up | Who checks the draft |
|---|---|
| `narrator_only` | Nobody; the draft airs |
| `self_check` | The same model, given its draft back with the facts |
| `llm_judge` | A second LLM judges the draft against the facts; an LLM editor fixes it from the judge's problems (at most twice); if the judge still objects, nothing airs |
| `captionvar` | Blind extractor + code referee + editor (the published run) |

Every caption that would air is measured the same way: a fresh claim extraction and the code referee. Reported per set-up: planted errors still on air, captions with a false statement, captions with a statement the data cannot back, and captions that did not air. The planted errors are known ground truth; the other counts come from the referee, so they share its coverage limits. About 250 model calls, roughly $0.15 with gpt-4.1-mini; it resumes like `run_match.py`.

To compare over several matches, run both scripts per match seed and combine the reports:

```powershell
foreach ($seed in "eval-1","eval-2","eval-3","eval-4") {
  python agents\run_match.py --match-seed $seed --out public\traces\eval\$seed.trace.json --rpm 30
  python agents\run_baselines.py --trace public\traces\eval\$seed.trace.json --out public\traces\eval\$seed.baselines.json --rpm 30
}
python agents\summarise_baselines.py "public\traces\eval\*.baselines.json" --out public\traces\baselines-summary.json
```

The summary separates **planted** errors (the red team's, known ground truth) from the narrator's **own** errors (false statements it made unasked, mostly build-up details such as who pressed whom), and lists every own-error case and every CaptionVAR caption the re-measurement flagged, for manual review.

## Compare models

The referee is code, so the model behind the agents is a cost and speed choice, not a safety one. To test that, deploy another model in the same Foundry project (for example `gpt-4.1-nano`) and run the demo match again with the same red-team plan:

```powershell
$env:FOUNDRY_MODEL = "gpt-4.1-nano"
python agents\run_match.py --fresh --out public\traces\models\gpt-4.1-nano.json --rpm 30
python agents\compare_models.py public\traces\foundry-demo.json "public\traces\models\*.json" --out public\traces\models\summary.json
```

`compare_models.py` prints one row per model: planted errors caught and not stopped, how many first drafts passed, who wrote what aired (narrator, editor, or the data), lines of context and recap sentences aired, time to air and cost. Prices for common deployments are in `PRICE_PER_M` in `run_match.py`; check them against the Azure pricing page for your region.

## Time to air

Each decision records `timing`: the time from the start of its workflow run to the caption airing (`time_to_air_s`), split into model time, referee time and model calls. Waits on our own rate limiter and `429` back-offs are left out, because they come from a small deployment quota, not from the design; they are recorded separately as `throttle_s`. A line of context has its own `timing`, from the same start to the line airing. `summary.time_to_air` gives the median, p95 and maximum, the median by number of rewrites, and the referee's median in milliseconds. Moments run one at a time (`--concurrency 1`), so nothing else competes for the measured time. The demo airs each caption as late as it did in the recorded run.

## Trace format

Each decision in the trace carries the narrator's original caption split into claim segments, the verdict on every claim with its evidence event IDs, the red-team label (if any), each attempt (narrator, editor rewrites) with its status, what aired (`aired.text`, `aired.by`) and `timing`. Key moments also carry `insight`: the Analyst's first line with its segments and verdict, each attempt, the red-team label and what aired (`null` if it was cut). `recaps` lists the half-time and full-time recaps, each with its sentences in the same shape and `aired_text`. `summary` adds `insights` and `recaps` counts (aired, cut, planted, caught), and `usage` records model calls, tokens and the estimated cost of the run.
