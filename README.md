# CaptionVAR Live

**Every AI insight deserves a VAR check.**

> **A local-first, evidence-grounded verification layer for AI-generated football commentary.** Built for the Microsoft × Premier League *Inside the Game* Hackathon.

**[Try the interactive demo](https://joelynli0110.github.io/captionvar-live-starter/)** · **[Browse the source](https://github.com/joelynli0110/captionvar-live-starter)**

## Why CaptionVAR?

AI can turn match events into football commentary in seconds, but it can also invent goals, misstate time windows, exaggerate statistics, or attach unsupported tactical explanations to correct numbers. A plausible caption is not necessarily a reliable one.

**CaptionVAR Live adds a VAR-style editorial checkpoint between generated commentary and the viewer.** It compares supported classes of claims against **synthetic, timestamped match events**, then chooses whether to **VERIFY**, **QUALIFY**, or **WITHHOLD** the candidate. Viewers can replay the relevant events, inspect the supporting records, and switch between casual-fan and tactical-analyst presentations.

This is an **interactive hackathon prototype**, not a general-purpose fact checker or a production live-broadcast service.

## Try the demo

**Live demo:** https://joelynli0110.github.io/captionvar-live-starter/

No sign-in or Azure subscription is required. Select any editorial scenario, press **RUN VAR CHECK**, and inspect its event IDs on the pitch. Use the replay controls and switch the **Casual fan / Tactical analyst** view.

The public website runs **interactive, deterministic browser-side verification over saved candidate captions**. It does **not** generate new text using Foundry Local in the browser: model generation was performed separately on a Windows computer, and the resulting drafts were saved in the repository.

### Five interactive scenarios

| Scenario | What it demonstrates | Editorial action |
| --- | --- | --- |
| **01 · Perfect passing, tiny sample** | A superficially impressive percentage that cannot justify a broad dominance claim; real local-model prose may also be too garbled to approve | QUALIFY or WITHHOLD depending on the displayed draft |
| **02 · Attacking-third recoveries** | Checking recovery counts against timestamped events and correcting a misdescribed 90-second window | VERIFY or QUALIFY depending on the displayed draft |
| **03 · Fabricated goal / missing evidence** | A local model claims a goal, while the supplied source contains a related shot but no supporting goal event | WITHHOLD |
| **04 · Unsupported tactical causality** | Correct recovery counts do not establish that aggressive pressing *caused* them | QUALIFY |
| **05 · Hidden hallucination** | One supported statistic is combined with an unsupported hat-trick claim; the two claims are audited separately | WITHHOLD |

**Scenario 05 — the showcase case:**

> “Northbridge regained possession three times in the attacking third in the last 90 seconds, then went on to score a hat trick.”

- **Supported:** Three attacking-third recoveries with traceable synthetic event IDs `R-711`, `R-712`, `R-713`.
- **Not supported:** No goal/scorer records sufficient to establish a hat-trick.
- **Decision:** WITHHOLD the original mixed-claim caption. A correct subclaim does not authorize an unsupported companion claim.

Scenario 05 is **deliberately curated adversarial test text**, **not** a newly generated Qwen response. Scenarios 01–03 can show actual locally generated Foundry Local drafts; scenario 04 is a saved, observed model response.

## How it works

```text
             Synthetic match-event records
           (event ID · team · time · coordinates)
                             │
                             ▼
              Microsoft Foundry Local
         Qwen 2.5 1.5B · offline text drafting
                             │
                             ▼
             Saved candidate commentary
               src/data/model_drafts.json
                             │
                             ▼
                 CaptionVAR text gate
           limited parsing + evidence checks
                             │
                 ┌───────────┼───────────┐
                 ▼           ▼           ▼
               VERIFY      QUALIFY     WITHHOLD
                 └───────────┼───────────┘
                             ▼
           Traceable evidence + safe output
             Interactive React/Vite replay
```

**Design choices**

- **Evidence first.** Numeric and event assertions are checked by deterministic code, not delegated to the language model.
- **Conservative editorial actions.** Unrecognized or insufficiently supported statements are withheld rather than silently certified.
- **Inspectable provenance.** Each synthetic source event has a timestamp, an event ID, and a visual location on the pitch. Relevant events are distinguished from events that actually support the challenged claim.
- **Local-first.** Text generation uses Microsoft Foundry Local on the developer's device with no Azure cloud-model token charges.
- **Small, testable scope.** The current text gate recognizes a limited set of English constructions. The focused claim-by-claim audit in scenario 05 is tailored to that curated demonstration; it is not general NLP extraction.

### Tech stack

| Layer | Technology |
| --- | --- |
| Local text generation | Microsoft Foundry Local, Qwen 2.5 1.5B, Python SDK |
| Verifier & replay | JavaScript deterministic claim/evidence checks |
| User interface | React + Vite |
| Evaluation | Node.js test runner and curated label fixture |
| Public hosting | GitHub Pages via GitHub Actions |
| Football data | Fully synthetic, fictional clubs and match events |

## Evaluation and limitations

Latest completed development checks:

- **47 JavaScript unit tests passing** (as reported during v0.8 validation).
- **30 / 30 label matches** on a **curated regression fixture** after fixes guided by that fixture.
- A successful local Vite production build and a publicly reachable, interactive GitHub Pages demonstration.

**Do not interpret 30 / 30 as 100% hallucination detection accuracy.** The regression examples informed development; they are *not* an unseen independent test set. The evaluation makes no claim about performance on arbitrary natural language or real-world football feeds. Run `npm.cmd run eval` to regenerate the current report in `reports/evaluation.md` and `reports/evaluation.json`.

**Known limits:**

- The app recognizes a **narrow set of claims and phrasings**. Unsupported/unrecognized inputs can be rejected conservatively, including captions that may actually be true.
- The full text gate is **not** a broadly validated semantic fact checker, and the specialized two-claim presentation is **specific to the curated fifth scenario**.
- The match and pitch events are fictional and replayed, not a live Premier League feed. The positions are illustrative synthetic coordinates, not real player tracking.
- The hosted demo replays **pre-generated** model outputs; Foundry Local inference happens only when you run the local Python script.
- The project does not use licensed Premier League footage, match data, club crests, or live broadcast feeds.

## Run locally

**Browser demo (Windows PowerShell)**

Requirements: Node.js 22/24, npm, and Git. Python and Foundry Local are **not** required to explore the already saved drafts and browser verifier.

```powershell
# From the repository root
npm.cmd install
npm.cmd test
npm.cmd run eval
npm.cmd run dev
```

Open the URL printed by Vite (normally `http://127.0.0.1:5173/`). For a production build, run:

```powershell
npm.cmd run build
```

**Optional: regenerate real model drafts offline with Microsoft Foundry Local**

Use a supported Windows machine (16 GB RAM recommended). This project was developed using Windows 11, Python 3.11, and a 4 GB RTX 3050 Laptop GPU; model availability and hardware acceleration depend on the installed Foundry Local runtime.

```powershell
winget install --id Microsoft.FoundryLocal -e
foundry model list
foundry chat qwen2.5-1.5b
# Type /exit to leave the model chat.
```

Create the Python environment and run the existing script:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install foundry-local-sdk-winml
.\.venv\Scripts\python.exe -u scripts\generate_local_drafts.py
```

This reads the synthetic-event scenario data and writes generated **unverified** drafts to `src/data/model_drafts.json`. Rebuild or restart the frontend to display the latest saved results. Foundry Local does not require an Azure subscription for this setup.

## Project layout

```text
.github/workflows/pages.yml       # GitHub Pages build/deploy
src/App.jsx                       # Interactive dashboard
src/verifier.js                  # Structured evidence checks
src/verifyCaption.js             # Limited text gate
src/data/scenarios.json          # Synthetic scenarios and events
src/data/model_drafts.json       # Saved local model outputs
scripts/generate_local_drafts.py  # Optional local text generation
scripts/evaluate_captionvar.mjs  # Curated regression evaluation
reports/evaluation.md            # Human-readable evaluation report
reports/evaluation.json          # Per-case evaluation output
V08_SHOWCASE.md                   # v0.8 details and caveats
```

## Deployment

This repository publishes the compiled React/Vite site to **GitHub Pages** with `.github/workflows/pages.yml`. For this project repository, the public site lives under `/captionvar-live-starter/`, and the GitHub branch is `master`.

**[Open the public demo](https://joelynli0110.github.io/captionvar-live-starter/)**

If rebuilding the deployment setup, configure the Vite `base` to `/captionvar-live-starter/` and make the Actions push trigger match your actual default branch. In GitHub: **Settings → Pages → Source: GitHub Actions**.

## Hackathon scope and integrity

Developed as a local-first prototype for the **Microsoft × Premier League Inside the Game Hackathon**. The goal is to explore how automated football narratives can become **more explainable and evidence-grounded** without requiring a large cloud infrastructure budget.

All match events, teams, coordinates, and scenarios are synthetic. Generated model captions are distinguished from manually curated challenge examples in the UI. No claims are made about real club performance or about general-purpose detection accuracy.

**Tagline:** *Every AI insight deserves a VAR check.*
