# CaptionVAR Live — Local-First Hackathon Starter

**Every AI insight deserves a VAR check.**

A small React prototype that replays **fully synthetic** football situations,
checks *typed / structured* commentary claims against event evidence, and
shows different viewer narratives. No Azure account or cloud model calls needed.

> **Prototype disclosure:** This starter checks four **structured** claim types
> (`pass_dominance`, `high_recoveries`, `xg`, and `recovery_causality`). It **does not** verify every
> possible free-text assertion in an LLM response, and should not be described as
> an open-domain fact checker. The match replay is simulated, not live Premier
> League data. `src/data/model_drafts.json` defaults to `{}` until you run the
> optional local inference script. The online GitHub Pages demo does not run
> Foundry Local in the browser; it uses locally generated drafts saved at build
> time. The VAR engine still runs interactively in the browser.

## 0. Requirements (Windows)

- Windows 11 24H2+ recommended for Foundry Local SDK, 16 GB RAM recommended.
- Node.js LTS 22/24, Git, optionally Python 3.11 or 3.12.
- No GPU required if a CPU-compatible model is available; internet for first model download.

## 1. Run the offline-capable UI

In PowerShell, extract the zip, open the `captionvar-live-starter` directory:

```powershell
npm install
npm test
npm run dev
```

Open the local address printed by Vite (normally http://127.0.0.1:5173/).
Click the four match scenarios and **RUN VAR CHECK**. Switch **Casual fan** / **Tactical analyst**.

You should see these outcomes:

- 100% pass accuracy from 2/2 passes → **QUALIFY** (sample too small)
- 3 recoveries high up the pitch → **VERIFY**
- fabricated 0.82 xG without a source xG estimate → **WITHHOLD**
- A real local 1.5B commentary response (replayed) that attributes recoveries to aggressive pressing without causal evidence → **QUALIFY**

## 2. Try Microsoft Foundry Local (no Azure account)

Install CLI through PowerShell:

```powershell
winget install -e --id Microsoft.FoundryLocal
```

Restart PowerShell and verify:

```powershell
foundry --version
foundry model list
foundry model info qwen2.5-1.5b
foundry chat qwen2.5-1.5b
```

Type `/exit` to leave chat. If the alias isn't listed, use another small chat model
from `foundry model list` and update `MODEL_ALIAS` in the script below.

## 3. Generate actual local model drafts (optional, later step)

In a separate PowerShell from the project directory:

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install foundry-local-sdk-winml
.\.venv\Scripts\python.exe scripts\generate_local_drafts.py
```

This script downloads/loads a small local model, makes three actual local
inference calls **using synthetic event facts, not prewritten faulty claims as prompts**,
and writes the UNVERIFIED generated candidate commentary to
`src/data/model_drafts.json`. Then run the React UI again to display them.

If virtual environment activation is blocked by PowerShell execution policy,
use the venv Python directly rather than modifying machine-wide policies:

```powershell
.\.venv\Scripts\python.exe -m pip install foundry-local-sdk-winml
.\.venv\Scripts\python.exe scripts\generate_local_drafts.py
```

Microsoft docs: https://learn.microsoft.com/en-us/azure/foundry-local/get-started

## 4. GitHub repository and demo

Create a **new public repo** `captionvar-live` and upload/commit all project
files except ignored dependencies and private data. Then in GitHub:

1. Go to **Settings → Pages**.
2. Choose **Build and deployment → Source → GitHub Actions**.
3. Push to `main`; `.github/workflows/pages.yml` builds/deploys the Vite React site.
4. Open the `https://YOURUSERNAME.github.io/captionvar-live/` URL shown in Pages.

The public demo works without your Windows PC being on, but it does **not**
perform new local LLM inference on remote judges' machines. Judges can run
`scripts/generate_local_drafts.py` locally following the above instructions.

## 5. The seven-day plan

| Day | Outcome |
| --- | --- |
| 1 | Computer checked, Node/Git/Foundry CLI installed, starter UI and tests run |
| 2 | Expand football-realistic synthetic data, implement event replay/timestamps |
| 3 | Add robust verifier, unique event IDs, failure test cases, provenance |
| 4 | Run Foundry Local SDK and connect constrained generation to verification |
| 5 | Polish animation, overlay, two audience modes, narrative corrections |
| 6 | Measure precision/false positives, publish public Pages demo and README |
| 7 | Record under-2-minute demo, write English submission, test judge setup |

## Architecture

`src/data/scenarios.json` → typed claim extraction → `src/verifier.js` → status
and supporting event IDs → `src/App.jsx` (viewer mode / screen overlay).

Optional offline generation:

`Microsoft Foundry Local` → `scripts/generate_local_drafts.py` →
`src/data/model_drafts.json` → **unverified draft**, with a separate deterministic
claim check. For higher-quality final submission, ensure the verifier checks
*all claims* that the model emits, or constrain the generator to evidence-approved
fact fields; do not claim arbitrary natural language is automatically fact-checked.

## Official competition requirements

- Newly created, original work; synthetic football-realistic data.
- Public GitHub repository and English documentation.
- A real demonstration video **under two minutes** using a public supported host.
- Free judge access to a working demo/test build through the judging period.
- No Premier League footage, club marks or licensed event data is used here.

Rules: https://github.com/microsoft/insidethegamehackathon/blob/main/OFFICIAL%20RULES.md

## License and integrity

The sample event data and project code were newly generated for this prototype.
Review any dependencies' licenses. Do not push private data, tokens, or secrets.

## What changed in v0.2

- Added the user's observed qwen2.5-1.5b football commentary as a **replayed** case.
- Added a typed claim validator for correct recovery counts plus unsupported causal inference.
- Updated the verified-recoveries casual-fan caption so it does not imply that pressing caused the recoveries.
- The observed text is manually annotated with a claim type; this is **not** general-purpose claim extraction or real-time free-text verification.
- The online UI remains a static replay plus interactive deterministic verifier.

## v0.3 — Event-grounded Foundry Local generator (important)

In PowerShell from the project directory, after `npm.cmd test` passes:

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install foundry-local-sdk-winml
.\.venv\Scripts\python.exe -m unittest discover -s scripts -p "test_*.py"
.\.venv\Scripts\python.exe scripts\generate_local_drafts.py
npm.cmd run dev
```

- **Generation really uses the local SDK**, on your computer; no Azure account or cloud token billing.
- **Prompts are constructed from synthetic event records**, rather than paraphrasing faulty seed statements.
- The model outputs for the first three scenarios appear under **UNVERIFIED CAPTION**.
- The fourth scenario remains a transparently labeled **manually copied replay** of the user's actual local model output.
- **Critical distinction:** `RUN VAR CHECK` still verifies the *typed seed claim in the scenario*, **not every sentence the LLM just wrote**. Never tell a judge that generated prose is automatically verified. Live generated-caption claim extraction and consistency checks remain future work.
- The exported GitHub Pages build runs only the interactive browser verifier and can replay saved local model drafts; the visitor does not receive local AI inference.
- If the Python SDK installation fails on a Windows machine, consult the Microsoft Foundry Local Python SDK quickstart and keep the verified static MVP intact.

Microsoft SDK reference: https://learn.microsoft.com/en-us/azure/foundry-local/how-to/how-to-integrate-with-inference-sdks

## v0.4 — Model-output-aware, fail-closed verification

The dashboard now runs `verifyCaption` against **the exact currently displayed local model draft** (when a generated draft is present), rather than validating an unrelated pre-annotated seed claim.

- A tiny allowlist recognizes selected recovery counts, limited shot mentions, goal inventions and unsupported pressing / rolling-window claims.
- The default is **WITHHOLD** for unrecognized language. This is **not an open-domain NLP fact checker**; the purpose is to give an honest, inspectable, conservative MVP.
- The audience-facing published/qualified output is generated independently from the event records, not a blindly polished model hallucination.
- It should not be claimed that the app validates all information in unconstrained natural language.
- For original structured seed scenarios with no model draft, the previous `verifyScenario` route remains available for demo comparisons.

### Apply the update without losing your real draft output

If you have actual generated captions in `src/data/model_drafts.json`, **do not overwrite that file**. The v0.4 **Update** ZIP contains only the source/code files required for these changes and does not include `model_drafts.json`.

After unpacking the update into the existing project root:

```powershell
npm.cmd test
npm.cmd run dev
```

Expected: 14 tests (7 existing + 7 new). The three generated captions should now receive **WITHHOLD / QUALIFY / WITHHOLD** respectively, while the manually replayed causal statement receives **QUALIFY**.
