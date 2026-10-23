# CaptionVAR Live v0.8 — Hackathon Showcase

## Scope

A minimal, additive update to v0.7. **No change to the existing `verifyCaption.js` verification engine**, the Foundry Local script, or any existing event/caption payloads.

- Adds a fifth, deliberately curated **mixed-claim** case: one correct attacking-third recovery statistic and one unsubstantiated hat-trick assertion.
- The existing v0.7 text gate WITHHOLDS the complete caption.
- A focused, deterministic claim audit displays the recovery evidence (R-711, R-712, R-713) separately from the hat-trick claim. Clicking an ID opens its event on the pitch.
- An unchanged candidate attribution explicitly says **CURATED ADVERSARIAL CAPTION — NO LLM CALL**. The first three scenarios still load generated captions from your local `src/data/model_drafts.json` if present.

## Install over the v0.7 working tree

1. Save your current state in Git and back up `src/data/model_drafts.json`.
2. Extract `CaptionVAR-Live-v0.8-Update.zip` over the repository root (the folder containing `package.json`).
3. Run `npm.cmd test`, `npm.cmd run eval`, and `npm.cmd run build` in PowerShell.
4. Run `npm.cmd run dev`. Select **Candidate 05** then **RUN VAR CHECK**.

## Expected behavior

- Full caption decision: **WITHHELD**.
- Claim 1 recovery count: **SUPPORTED**, with clickable evidence IDs R-711, R-712, R-713.
- Claim 2 hat-trick: **NOT SUPPORTED**, because no goal/scorer events are included.
- Left-side replay renders those recovery events with clickable positions and timestamps.

## Honest limits and presentation

The fifth caption is **not a new output from Qwen**; it is an intentionally curated red-team test. The original local Qwen captions remain available in the first three scenarios, while scenario 4 preserves the manually recorded causal example.

The narrow claim breakdown is only for the fifth, curated example. It does not make the tool an open-domain or comprehensive NLP claim extraction system. The 30/30 curated regression result has already informed development and must not be advertised as an independent accuracy estimate.

## Suggested 2-minute sequence

1. Show actual local model caption, click VAR, inspect evidence (0:00–0:35).
2. Select Candidate 05 and read the superficially plausible but mixed caption (0:35–0:55).
3. Press VAR, show full WITHHELD decision, then inspect each claim separately (0:55–1:25).
4. Click R-711 evidence and demonstrate the corresponding pitch event (1:25–1:42).
5. Close with offline Foundry Local, no Azure costs, and project limitations (1:42–1:58).

## GitHub Pages

This repository already contains `.github/workflows/pages.yml` using Vite `base:'./'` in `vite.config.js`.
For a public repository, in **Settings → Pages**, select **GitHub Actions** as the source. Push to `main` and verify the Pages deployment. The online site runs the pre-generated/cached text gate; Foundry Local itself is not running on the Pages server.
