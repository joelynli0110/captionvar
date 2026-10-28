/**
 * The published evaluation numbers have one source: the `reported` block of
 * public/traces/baselines-summary.json, written by agents/summarise_baselines.py.
 * This fails if a results table in the README or docs/EVALUATION.md drifts from it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const summary = JSON.parse(read('public/traces/baselines-summary.json')).reported;

const ROWS = {
  'README.md': { 'Narrator alone': 'narrator_only', 'Same model checks itself': 'self_check', 'Second LLM as judge + editor': 'llm_judge', '**CaptionVAR**': 'captionvar' },
  'docs/EVALUATION.md': { 'Narrator alone': 'narrator_only', 'Self-check': 'self_check', 'LLM judge': 'llm_judge', 'CaptionVAR': 'captionvar' },
};

/** The two "a / b" pairs in a table row: planted on air, own errors on air. */
function rowPairs(doc, label) {
  const line = doc.split('\n').find(l => l.startsWith(`| ${label} |`) && /\d+\s*\/\s*\d+/.test(l.replace(/\*/g, '')));
  assert.ok(line, `no row "${label}"`);
  return [...line.replace(/\*/g, '').matchAll(/(\d+)\s*\/\s*(\d+)/g)].slice(0, 2).map(m => [Number(m[1]), Number(m[2])]);
}

for (const [file, rows] of Object.entries(ROWS)) {
  test(`${file}: the results table matches baselines-summary.json`, () => {
    const doc = read(file);
    for (const [label, key] of Object.entries(rows)) {
      const s = summary[key];
      assert.deepEqual(rowPairs(doc, label), [[s.planted_on_air, s.planted_present], [s.own_real_on_air, s.own_real]], `${file}, row ${label}`);
    }
  });
}

test('README counts match the summary in its prose too', () => {
  const doc = read('README.md');
  const planted = summary.captionvar.planted_present;
  assert.ok(doc.includes(`The ${planted} are the red team's ${summary.red_team_instructions} instructions less ${summary.not_followed.length === 1 ? 'one' : summary.not_followed.length}`));
  assert.ok(doc.includes(`the ${summary.captionvar.own_real} are the narrator's own errors confirmed by hand among ${summary.own_flagged}`));
});

test('the one-line positioning quotes the measured result', () => {
  const own = summary.captionvar.own_real;
  const judgeStopped = summary.llm_judge.own_real - summary.llm_judge.own_real_on_air;
  const varStopped = summary.captionvar.own_real - summary.captionvar.own_real_on_air;
  const line = `of the ${own} errors our narrator made on its own weren't numbers: they were who did what to whom. CaptionVAR checks those too, and we measured it: an LLM judge stopped ${judgeStopped} of the ${own}, CaptionVAR stopped ${varStopped === own ? `all ${own}` : `${varStopped} of the ${own}`}.`;
  for (const file of ['README.md', 'docs/SUBMISSION.md']) assert.ok(read(file).includes(line), `${file} positioning line`);
  assert.ok(read('docs/SUBMISSION.md').includes(`stopped only ${judgeStopped} of the ${own} errors`));
});

test('docs/EVALUATION.md: the Foundry evaluator tables match foundry-evaluators.foundry-demo.json', () => {
  const fe = JSON.parse(read('public/traces/eval/foundry-evaluators.foundry-demo.json'));
  const doc = read('docs/EVALUATION.md');
  const of = (g, ev, failed = false) => `${failed ? g[ev].fail : g[ev].pass} of ${g.n}`;
  const t = fe.first_drafts.by_truth;
  assert.ok(doc.includes(`| Planted red-team errors | ${t.planted_error.n} of ${t.planted_error.n} | ${of(t.planted_error, 'groundedness', true)} |`));
  assert.ok(doc.includes(`| The narrator's own error (CAP-030) | 1 of 1 | ${of(t.own_error, 'groundedness', true)} |`));
  assert.ok(doc.includes(`| True details the referee flagged by mistake | ${t.true_detail_flagged.n} of ${t.true_detail_flagged.n} | ${of(t.true_detail_flagged, 'groundedness', true)} |`));
  const k = fe.aired.by_kind;
  for (const [label, key] of [['Captions', 'caption'], ['Lines on why it matters', 'why_it_matters'], ['Recap sentences', 'recap_sentence']]) {
    const g = k[key];
    assert.ok(doc.includes(`| ${label} | ${of(g, 'groundedness')} | ${of(g, 'coherence')} | ${of(g, 'fluency')} |`), `aired row ${label}`);
  }
});
