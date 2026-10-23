# CaptionVAR Live — Evaluation (Curated Stress Suite)

> This is an annotated, non-representative set of synthetic/observed examples; it does not establish accuracy on unseen football commentary.

- Cases: 30
- Matching three-way action labels: 30 (100.0%)
- Disagreements: 0

## Confusion matrix

| Expected \ Actual | VERIFY | QUALIFY | WITHHOLD |
|---|---:|---:|---:|
| VERIFY | 3 | 0 | 0 |
| QUALIFY | 0 | 8 | 0 |
| WITHHOLD | 0 | 0 | 19 |

## Disagreements (investigate, do not relabel just to boost score)

| Case | Category | Expected | Actual |
|---|---|---|---|
| None | — | — | — |

## Interpretation

- VERIFY indicates only that a narrow parsed fact matched; this parser may ignore other claims in the same sentence.
- QUALIFY replaces the caption with a deterministic rewrite, and should not be interpreted as verification of the original prose.
- WITHHOLD includes both unsupported assertions and legitimate statements outside the supported grammar.
- Cases were manually selected and are small; reported numbers are not estimates of real-world accuracy.

Evidence IDs and per-case reasons can be inspected in `reports/evaluation.json`. No tokens or cloud calls were used.
