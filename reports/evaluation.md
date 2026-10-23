# CaptionVAR Live — Evaluation (Curated Stress Suite)

> This is an annotated, non-representative set of synthetic/observed examples; it does not establish accuracy on unseen football commentary.

- Cases: 30
- Matching three-way action labels: 24 (80.0%)
- Disagreements: 6

## Confusion matrix

| Expected \ Actual | VERIFY | QUALIFY | WITHHOLD |
|---|---:|---:|---:|
| VERIFY | 3 | 0 | 0 |
| QUALIFY | 4 | 3 | 1 |
| WITHHOLD | 1 | 0 | 18 |

## Disagreements (investigate, do not relabel just to boost score)

| Case | Category | Expected | Actual |
|---|---|---|---|
| E13 | unsupported-causality | QUALIFY | VERIFY |
| E14 | invented-goal | WITHHOLD | VERIFY |
| E15 | unsupported-extra-claim | QUALIFY | VERIFY |
| E16 | unsupported-extra-claim | QUALIFY | VERIFY |
| E28 | unsupported-causality | QUALIFY | WITHHOLD |
| E29 | unsupported-extra-claim | QUALIFY | VERIFY |

## Interpretation

- VERIFY indicates only that a narrow parsed fact matched; this parser may ignore other claims in the same sentence.
- QUALIFY replaces the caption with a deterministic rewrite, and should not be interpreted as verification of the original prose.
- WITHHOLD includes both unsupported assertions and legitimate statements outside the supported grammar.
- Cases were manually selected and are small; reported numbers are not estimates of real-world accuracy.

Evidence IDs and per-case reasons can be inspected in `reports/evaluation.json`. No tokens or cloud calls were used.
