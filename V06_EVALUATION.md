# CaptionVAR Live v0.6 — Curated Evaluation Harness

This update is **additive**: it does not modify the Foundry Local scripts, generated captions, replay UI, or `src/verifyCaption.js`. It adds a transparent quality audit of the existing v0.5 verifier.

## Use on Windows

```powershell
cd D:\projects\captionvar-live-starter
npm.cmd test
npm.cmd run eval
```

The second command creates `reports/evaluation.md` (human readable) and `reports/evaluation.json` (per-caption record). The evaluator never calls Foundry Local, Azure, or another model.

## What the numbers mean

- 30 hand-selected cases, including some *observed local-model outputs* and deliberately constructed adversarial statements.
- Each case has a **human-assigned expected editorial action**: `VERIFY`, `QUALIFY`, or `WITHHOLD`.
- Three-way agreement is a regression diagnostic only, **not** generalization accuracy or evidence of end-to-end factual correctness.
- `VERIFY` means this very limited parser thinks it recognizes its target claim; it does **not** certify that every other phrase is verified.
- `QUALIFY` means the verifier produces a conservative, deterministic rewritten caption from events; it has **not** endorsed the original sentence.
- `WITHHOLD` means the candidate is not publishable without review, including cases that might actually be factual but use unsupported grammar.

## Important known safety failures in v0.5

Several examples contain a correct event count **plus** unsupported additional claims, but are incorrectly labeled `VERIFY`. For example `E14` adds a claim about scoring a hat trick. This is a genuine **false verification** risk. Do not deploy the limited verifier as a general-purpose automatic approval system. The right next step is a **conservative multi-claim gate** that rejects or qualifies uncaptured clauses instead of verifying the first recognized number alone.

## Follow-up evaluation

After improving the parser, **keep this evaluation fixture frozen** and separately create unseen test examples. Do not simply rewrite expected labels to increase the score; track false VERIFY cases and false WITHHOLD cases distinctly.
