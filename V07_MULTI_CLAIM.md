# CaptionVAR Live v0.7 — Multi-Claim Regression Patch

## Purpose
Prevent the limited claim parser from approving a **whole caption** merely because one recovery count is correct while another assertion in the same caption is unsupported.

## Changes
- Detect explicit hat-trick / goal claims mixed with otherwise valid recovery statistics (WITHHOLD).
- Flag unsupported injuries, corners, long-term superiority and additional clauses (QUALIFY: rebuild a safe caption exclusively from source events).
- Flag causal phrases before or after the recovery count, including *came from relentless pressing* and *pressing caused the team to win the ball* (QUALIFY).
- Support a narrow `win the ball N times` syntax for testing; never infer pressing causes.
- Keep xG mentions distinct from confirmed goals; unknown xG claims remain WITHHOLD.
- Preserve v0.6 evaluation labels and data unchanged. Add 15 extra regression tests.

## Apply to an existing v0.6 checkout
1. Create a Git checkpoint and back up any local changes to `src/verifyCaption.js`.
2. Unzip v0.7-Update.zip **into your project root** (the directory with `package.json`). Overwrite only the named files.
3. Run `npm.cmd test`, then `npm.cmd run eval`, then `npm.cmd run build` on Windows.
4. Review `reports/evaluation.md` and confirm your four original dashboard scenarios still show the intended outcomes.
5. Commit/push only after reviewing the diff.

## Local validation of this patch
- 39 / 39 JavaScript tests passed (Node 22 in build environment).
- Original v0.6 **curated** 30-case regression suite: 30/30 match annotated status labels after fixes. Earlier v0.6 was 24/30.
- This is a **training-informed regression result**, NOT an independent test set or a generalization claim. Original cases are known to the author of the fix. A separate external, blind evaluation remains necessary before claiming reliability.
- No LLM inference, Azure credits, GPU or internet required for testing.
- Full React build is to be tested on the user's Windows machine (`npm.cmd run build`).

## Known limits
- The gate handles a small restricted set of English event/count/goal/xG phrases; unknown free text may be WITHHELD or some unrecognized secondary claims may still be missed.
- The flags are lexical heuristics, not linguistic parsing or causal inference.
- `VERIFY` applies only to the extracted structured match-event assertions in the supported grammar, NOT to arbitrary prose.
- `QUALIFY` discards the original caption and emits a deterministic safe rewrite from the source event records.
- This patch does not modify the browser interface, Foundry Local integration, synthetic events, or model drafts.
