# CaptionVAR agent pipeline

Built with **Microsoft Agent Framework** (Python) on **Microsoft Foundry**.

```
                 ┌──────────────────────── edit loop (≤ 2) ────────────────────────┐
                 ▼                                                                 │
Narrator ──► Extractor ──► Referee ──┬── passes / out of retries ──► Publisher     │
  (LLM)        (LLM)       (code)    └── fails ──► Editor (LLM) ───────────────────┘
```

| Agent | Kind | Sees | Produces |
|---|---|---|---|
| Narrator | LLM | The moment's true facts and the last few actions, in words | One broadcast caption |
| Claim Extractor | LLM, structured output | The caption and squad lists **only, never the facts** | Typed claims with the exact words that make each one |
| Referee (VAR) | Deterministic code | Claims and the events observed **up to that moment** | Verdict per claim (holds / false / cannot be checked) with evidence event IDs |
| Editor | LLM | The verdict on each claim and the true facts | A repaired caption, which goes back through Extractor and Referee |
| Publisher | Code | The last checked version | The first version that passes; otherwise a caption rendered from the true facts |

Design choices that matter for trust:

- **The referee is not a model.** Numbers, names and outcomes are compared by code with explicit tolerances (`src/broadcast/verify.js`), the same code the browser runs and the unit tests cover.
- **The extractor is blind to the truth.** It reports what was said, so it cannot quietly "fix" a claim before it is checked.
- **Code, not the model, decides what a claim refers to and whether it is core.** `src/broadcast/extracted.js` binds each extracted claim to the moment's event and assigns its role, so a model cannot weaken its own check.
- **Fail closed.** A caption with no checkable claim is withheld. An editor rewrite airs only if it passes the same check; after two failed rewrites, a template built from the facts airs.
- **Build-up details are checked, not just trimmed.** "After Morita won it back", "a foul on Whitcombe" or "pressing from Vence" become `recent_action` claims, verified against the events of the same half in the two minutes before the moment. The event record is complete, so a named action that is not there is reported as false, with the player who actually did it. These are always detail claims: a failure trims that phrase, it never withholds the whole caption. Actions covered: foul, winning the ball, pressing, a pass, a run with the ball, losing the ball, a shot, a save, a block and a tackle; a shot is linked to the block or save that stopped it, and a caption about a shot can cite that save or block even though it is recorded a second later.
- **Every named player must be backed.** After the claim checks, code scans the caption for every player name in the squads. A name that no passing statement is about is flagged as unconfirmed, so a wrong name left in prose the extractor skipped (seen in a Foundry run: "Reyes sprints … Marsh recorded 34.9 km/h") cannot air. This applies to editor rewrites as much as to the narrator's first draft.
- **Every caption must report its moment.** A rewrite can be true in every word and still miss the point ("Pell's tackle … Reyes races forward" for Marsh's 34.9 km/h sprint, or "Northbridge hit 12 km" for one player's distance). Each moment type has a key fact (scorer, shooter, booked player, substitution, top speed, distance, recovery count, possession) that must be stated and verified; otherwise the caption is withheld and the moment airs from the data.
- **Percentages are not rounded generously.** A whole-number percentage must equal the actual value rounded down or up (61.0% allows only 61%; 62.6% allows 62% or 63%).
- **No future data.** The referee only sees events with `seq` up to the moment being captioned.
- **Red team.** A seeded plan tells the narrator to plant one specific kind of error in about a third of captions (wrong player, invented goal, inflated number, wrong score, invented cause, unverifiable superlative). Only the plan knows; the extractor and referee do not. The trace reports how many were caught, and separately how many other captions were flagged (these may be genuine narrator mistakes and are listed for review rather than scored).

The JavaScript side runs as a small stdio service (`scripts/factbox.mjs`), so Python and the browser share one implementation of spotting, checking and rendering.

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

# full match (40 captions, a few minutes, roughly $0.05-0.10)
python agents\run_match.py --out public\traces\foundry-demo.json
```

`public/traces/foundry-demo.json` is picked up by the web app automatically: the VAR room then shows the Foundry agents' captions, with a switch back to the test narrator.

**Rate limits.** Model calls are spaced to `--rpm` requests per minute (default 30), `429` responses are retried after the server's `Retry-After`, and progress is saved after every moment to `<out>.partial.jsonl`: if a run stops, run the same command again and it resumes. Each call uses about 1,500 tokens, so keep `--rpm` below both the deployment's requests-per-minute and its tokens-per-minute divided by 1,500 (see the deployment's rate limit in the Foundry portal).

If a call fails with `401`/`403 PermissionDenied`, give your account the **Azure AI User** role on the Foundry resource (Access control (IAM) in the Azure portal) and run `az login` again.

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

## Trace format

Each decision in the trace carries the narrator's original caption split into claim segments, the verdict on every claim with its evidence event IDs, the red-team label (if any), each attempt (narrator, editor rewrites) with its status, and what aired (`aired.text`, `aired.by`). `usage` records model calls, tokens and the estimated cost of the run.
