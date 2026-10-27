# Does the multi-agent design earn its cost?

Five full matches on Microsoft Foundry with gpt-4.1-mini: 195 captions in all. Every set-up below starts from the **same narrator drafts**, so the only thing that differs is how the drafts are checked.

| Set-up | Who checks the draft before it airs |
|---|---|
| Narrator alone | Nobody |
| Self-check | The same model gets its draft back with the facts and fixes it |
| LLM judge | A second LLM judges the draft against the facts. An LLM editor fixes it, at most twice, and if the judge still objects nothing airs. This is multi-agent, but with no code referee. |
| CaptionVAR | A blind claim extractor, the code referee and an editor |

### Evaluation version

| | |
|---|---|
| Version | **v1**, run 24 Oct 2026 23:28 – 25 Oct 00:26 UTC (`generated_at` in each raw report) |
| Data | 5 synthetic matches (`captionvar-demo-6`, `eval-1` to `eval-4`), 195 captions, one seeded red-team plan per match |
| Model | gpt-4.1-mini on Microsoft Foundry, for every agent in every set-up |
| Referee | the code as it was at that run, before the superlative guard (`checkSweepingClaims`, added in 9fab8cb and widened in 8f4d91d) |
| Numbers | one source: `python agents/summarise_baselines.py` writes [`baselines-summary.json`](../public/traces/baselines-summary.json) (`reported`). `npm test` fails if a table here or in the README disagrees with it. |

## Results (v1, as run)

| | Planted errors on air | Narrator's own false details on air | Cost per match |
|---|---|---|---|
| Narrator alone | 61 / 61 | 11 / 11 | ≈ $0.01 |
| Self-check | **0** / 61 | **8** / 11 | ≈ $0.02 |
| LLM judge | **0** / 61 | **7** / 11 | ≈ $0.025 |
| CaptionVAR | **1** / 61 | **0** / 11 | ≈ $0.10 |

CaptionVAR's one planted error on air is a superlative its extractor did not report; see [What this found](#what-this-found-in-captionvar-itself).

**Given the facts, an LLM catches the errors you plant. It misses the ones the model makes on its own.**

The red team's errors land on the headline fact: the scorer, the scoreline or the speed. Both LLM checkers correct every one, because the true value sits right there in the facts. The narrator's own mistakes are different. They sit in the build-up ("loses possession under pressure from Sow", "blocked by Quiroga", "Hale's pressing"), and finding them means checking a list of recent actions one by one. The LLM checkers read past them. The code referee looks each one up.

Examples that aired with an LLM checker, and why the event record contradicts them:

| Caption detail | What the events show | Self-check | LLM judge |
|---|---|---|---|
| "Reyes loses possession under pressure from Sow" (73') | Sow made no press; he won the ball after a loose pass | aired | aired |
| "Pell loses possession again under pressure" (eval-1, 73') | Pell's last pass found Reyes | aired | aired |
| "Strand's strike … blocked by Northbridge's Quiroga" (eval-3, 44') | Quiroga made no block | aired | aired |
| "Collymore's thunderous strike denied by Nyman" (eval-2, 61') | Nyman plays for the shooter's own side | aired | fixed |
| "Haddad … pressing Northbridge's Reyes" (eval-2, 11') | The other way round: Reyes pressed Haddad | fixed | aired |

## How it was measured

- **Planted errors.** The red team's instruction for each caption is recorded: 62 instructions over the five matches. The automatic count takes an error as present when the referee's flags on the draft show the planted kind (55). We read the other 7 drafts by hand: 6 carry the error in a form the count did not see (3 superlatives worded differently, "Brandt scores" when Reyes scored, "levels at 3-2" at 2-2, a sprint credited to Lind), and in 1 the narrator ignored the instruction (it named Pell, who was booked). That makes **61** planted errors. An error counts as on air if the same kind of claim still fails in what aired, or, for the 6, if a hand reading finds it there.
- **The narrator's own errors.** These are false statements the narrator made without being told to, found by the referee in the drafts. The referee flagged 39. **We checked every one against the raw events by hand.** 11 are real errors, and 10 of those are about who did what to whom: a pass, a press, a block, a giveaway, which side a keeper plays for. Only one is a number (three final-third turnovers, not two). The other 28 are true details the extractor tied to the wrong player, for example reading "X under pressure from Y" as X pressing. The verdict and the reason for each case are in [`eval-adjudication.json`](eval-adjudication.json).
- **On air or not.** For each set-up, the aired caption was extracted again and checked by the same referee, and we checked whether the false words still appear word for word. Each of the 11 real cases was then read by hand. Hand and code disagree once: the re-check flags CaptionVAR's eval-3 70' caption ("Ashkenazi's press leads to Abara's giveaway"), which is true (PR-1690, P-1691), so it is not counted.
- **Reproduce the numbers.** `python agents/summarise_baselines.py "public/traces/eval/*.baselines.json"` prints both sets: the automatic counts (every flag, false alarms included: own errors on air 36/22/28/1 of 39) and the hand-checked ones quoted above. [`baselines-summary.json`](../public/traces/baselines-summary.json) stores both, under `automatic` and `reported`, with every case.
- **Cost** is the published gpt-4.1-mini price for the tokens used, narrator included.

Reproduce: [AGENTS.md → Baselines](AGENTS.md#baselines-what-the-multi-agent-design-adds). The raw reports are in `public/traces/eval/`, and `public/traces/baselines-summary.json` lists every case.

## What this found in CaptionVAR itself

- **One planted error got through in v1.** A superlative ("could've been the best strike attempt of the entire league season") aired because the extractor did not report it as a claim. v1 counts it: CaptionVAR **1 / 61**.
- **The fix, and what has been checked so far.** After the run we added a code guard that flags comparisons beyond the match whether or not the extractor reports them (`checkSweepingClaims` in `src/broadcast/verify.js`).
  - *Checked:* the guard applied to every text recorded in this repository, 738 drafts, rewrites, lines of context and recap sentences from the five evaluation matches and the published Foundry runs (gpt-4.1-mini and gpt-4.1-nano). It flags all 24 planted superlatives actually written, including the one that aired, and no other text (`node scripts/check_superlative_guard.mjs`). In 5 more lines the red team asked for one and the Analyst did not write it.
  - *Not yet checked:* the five matches have not been re-run with the guard. A re-run would draw new drafts from the model, with new chances to miss. So we do not claim 0 / 61; that needs a v2 run, reported next to v1.
- **It is strict at the cost of some true detail.** In 28 of the 195 captions, a true build-up detail was flagged because the extractor tied it to the wrong player, and the editor trimmed it. Trimming removed true colour; it added nothing false. Better role rules in the extractor prompt (passive voice, "under pressure from", "forces X into") are the obvious next step.
- **The measurement has noise too.** Re-checking CaptionVAR's own aired captions flagged 6 of 195. All 6 are measurement mistakes: three colour phrases read as claims, two true details checked wrongly (a giveaway, a lead), and a count checked against the wrong metric. They are listed in the summary file.

## A cheaper model

The same match, the same seeded red-team plan, gpt-4.1-nano behind every agent instead of gpt-4.1-mini ([`public/traces/models/`](../public/traces/models/), compared with `agents/compare_models.py`).

- **Safety held in this match.** All 15 planted caption errors were stopped. We checked by hand every one of the 21 captions nano wrote that aired (6 first drafts, 15 editor rewrites) against the raw events, including the build-up details ("Vence winning the ball back after pressing", "Sow winning a tackle"). All are true. The other 19 aired from the data.
- **Quality dropped.** Only 6 of 40 first drafts passed (22 with mini). Nano's narrator and editor make more mistakes, and its extractor misreads more true details. Two rewrites were often not enough, so 19 captions aired as plain captions built from the data. Only 2 of 19 lines of context passed; 11 of 12 recap sentences did.
- **Cost and time.** About $0.07 for the match against $0.18, but more calls (280 against 188) and a slower median time to air (6.9 s against 3.7 s), because more drafts go through the editor.
- **One failure handled.** At 61' nano's extractor returned JSON that did not parse. The workflow now retries such replies and, if they never parse, treats them as no claims, so the draft cannot air unchecked.

So on this match the referee turned the model into a cost and quality dial: the cheaper model cost fluency and context, not correctness. One match is a small sample.

## Foundry evaluators

A second opinion on what aired, from Microsoft Foundry's built-in evaluators (the `azure-ai-evaluation` SDK, 1.16.9), next to the code referee. `agents/foundry_eval.py` reads a trace and scores:

- **What aired**: every caption, line of context and recap sentence. Captions are split by what the referee did: verified, trimmed, withheld then corrected, built from data. Lines and recap sentences are verified or rewritten.
- **The first drafts the referee stopped**, scored the same way. Each is labelled with what is known about it: a planted red-team error, an error the narrator made on its own (checked by hand, [`demo-adjudication.json`](demo-adjudication.json)), a true detail flagged by mistake, or unreviewed. A groundedness fail means the evaluator also caught the draft.

| Evaluator | Reads | Question |
|---|---|---|
| Groundedness | the text and the facts | Is every statement backed by the facts? |
| Coherence | the text and its brief | Does it read as one clear answer? |
| Fluency | the text | Is it well written? |

Scores are 1 to 5; 3 or more passes (the SDK's default). The facts are what the agent that wrote the text was given, rebuilt from the match seed by the factbox: the narrator's moment facts and recent play, the Analyst's running numbers, or the recap facts. Squad lists are left out, as for the LLM judge above. The evaluators are a model judge too, so their scores are an opinion, not ground truth. The groundedness rubric also rewards completeness: a short caption that is true but leaves facts out can score below 5.

```powershell
pip install -r agents\requirements-eval.txt
$env:FOUNDRY_PROJECT_ENDPOINT = "<project endpoint from the Foundry portal>"
$env:FOUNDRY_MODEL = "gpt-4.1-mini"
python agents\foundry_eval.py --trace public\traces\foundry-demo.json
```

It writes `public/traces/eval/foundry-evaluators.foundry-demo.json` (scores per text and totals by kind, by what the referee did, and for the stopped drafts) and the inputs it sent, as JSONL. The evaluators call the deployment in `FOUNDRY_MODEL` at the Foundry resource's Azure OpenAI endpoint, `https://<resource>.openai.azure.com/`; set `AZURE_OPENAI_ENDPOINT` if yours differs. Sign-in is `az login` (DefaultAzureCredential), no keys. `--dry-run` builds every input without calling Azure; `--limit N` scores only the first N; `--log-to-foundry` also uploads the run to the project's Evaluation page, after the local results are saved (best effort).

**Results: not run yet.** They will be added here after a run on the published trace.

## Limits

- The 11 own errors come from 5 matches with one model. The direction is clear (8 and 7 against 0), but the sample is small.
- The matches are synthetic. Real commentary models may make different mistakes.
- The LLM judge gets the same facts as the narrator. A judge with tools or more context might do better, at higher cost.
- The comparison covers captions only. It was run before the Analyst, the recaps and their claim kinds (running totals, minutes since a shot, recent possession, earlier goals and bookings) were added. Those are scored by their own red team in each run's `summary.insights` and `summary.recaps`.
