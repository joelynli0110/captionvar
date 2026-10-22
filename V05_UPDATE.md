# CaptionVAR Live v0.5 update

Incremental patch over your working v0.4 project. It intentionally excludes `src/data/model_drafts.json` and the Python / verification modules.

## New features

- Each synthetic event has explicit, illustrative 0–100 pitch coordinates.
- Dynamic pitch: only events observed at the current replay time appear; no invented passes/routes.
- Play / pause / scrub a rolling 90-second synthetic observation window.
- Select a pitch marker or event row to inspect original event ID, team, time, coordinates and recorded attributes.
- Show **supporting** and **related** events separately. Withheld goal claim shows the shot `S-502` as related evidence but *not* as proof of a goal.
- Original v0.4 generated captions and its narrow fail-closed verifier remain unchanged.

## Install on Windows PowerShell

```powershell
cd D:\projects\captionvar-live-starter
Copy-Item .\src\data\model_drafts.json .\model_drafts_backup.json
Expand-Archive -Path "$HOME\Downloads\CaptionVAR-Live-v0.5-Update.zip" -DestinationPath . -Force
npm.cmd test
npm.cmd run build
npm.cmd run dev
```

If the archive is stored elsewhere, modify the `-Path` argument. The new patch ships `src/App.jsx`, `src/styles.css`, `src/replay.js`, `src/replay.test.js`, and `src/data/scenarios.json` only.

**Acceptance test:** choose the `missing-xg` scenario. Its fabricated goal is withheld; `0 SUPPORTING · 1 RELATED` should appear. Click `S-502` and confirm that the pitch highlights a shot at 83:11, without inferring any goal or xG.

**Honest limitations:** event coordinates are synthetic demo enrichments, not match-tracking data. Replaying the pre-generated match events online does not mean the local model is running online. Free-text claim parsing remains narrowly scoped and conservative.
