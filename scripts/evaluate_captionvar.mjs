// Curated stress-test, not evidence of generalization. No network/model calls.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { verifyCaption } from '../src/verifyCaption.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const cases = JSON.parse(readFileSync(resolve(root,'src/data/evaluation_cases.json'),'utf8'));
const scenarios = JSON.parse(readFileSync(resolve(root,'src/data/scenarios.json'),'utf8'));
const byId = new Map(scenarios.map(s=>[s.id,s]));
const VALID = ['VERIFY','QUALIFY','WITHHOLD'];

const results = cases.map(testCase=> {
 const scene = byId.get(testCase.scenarioId);
 if (!scene) throw new Error(`Unknown scenario: ${testCase.scenarioId}`);
 if (!VALID.includes(testCase.expected)) throw new Error(`Invalid expected status: ${testCase.expected}`);
 const start = performance.now();
 const result = verifyCaption(scene,testCase.caption);
 const latencyMs = performance.now()-start;
 return {
  id:testCase.id, category:testCase.category, expected:testCase.expected,
  actual:result.status, match:result.status===testCase.expected,
  latencyMs:Number(latencyMs.toFixed(3)), reason:result.reason,
  label:testCase.annotation,
 };
});

const aggregate=rows=>({count:rows.length, matching:rows.filter(r=>r.match).length, mismatching:rows.filter(r=>!r.match).length});
const conf = Object.fromEntries(VALID.map(exp=> [exp, Object.fromEntries(VALID.map(actual=>[actual,results.filter(x=>x.expected===exp && x.actual===actual).length]))]));
const categories=[...new Set(results.map(r=>r.category))].sort();
const summary = {
 label:'Small, hand-curated regression/stress suite — NOT an estimate of deployment accuracy',
 recordedAt:new Date().toISOString(),
 methodology:'Fixed synthetic match events and manually annotated candidate captions. A prediction is counted as a match only if its three-way action agrees with one human label. This is not an unbiased test set or a safety guarantee.',
 totals:aggregate(results),
 statuses:conf,
 byCategory:Object.fromEntries(categories.map(c=>[c,aggregate(results.filter(r=>r.category===c))])),
 limitations:[
  'VERIFY indicates only that a narrow parsed fact matched; this parser may ignore other claims in the same sentence.',
  'QUALIFY replaces the caption with a deterministic rewrite, and should not be interpreted as verification of the original prose.',
  'WITHHOLD includes both unsupported assertions and legitimate statements outside the supported grammar.',
  'Cases were manually selected and are small; reported numbers are not estimates of real-world accuracy.'
 ],
 results,
};

const outDir = resolve(root,'reports');
mkdirSync(outDir,{recursive:true});
writeFileSync(resolve(outDir,'evaluation.json'),JSON.stringify(summary,null,2)+'\n');
const pct = (summary.totals.matching/summary.totals.count*100).toFixed(1);
const table=VALID.map(expected=>`| ${expected} | ${VALID.map(actual=>conf[expected][actual]).join(' | ')} |`).join('\n');
const failures=results.filter(r=>!r.match).map(r=>`| ${r.id} | ${r.category} | ${r.expected} | ${r.actual} |`).join('\n')||'| None | — | — | — |';
const lines=[
 '# CaptionVAR Live — Evaluation (Curated Stress Suite)', '',
 '> This is an annotated, non-representative set of synthetic/observed examples; it does not establish accuracy on unseen football commentary.', '',
 `- Cases: ${summary.totals.count}`,
 `- Matching three-way action labels: ${summary.totals.matching} (${pct}%)`,
 `- Disagreements: ${summary.totals.mismatching}`, '',
 '## Confusion matrix', '',
 '| Expected \\ Actual | VERIFY | QUALIFY | WITHHOLD |',
 '|---|---:|---:|---:|',table,'',
 '## Disagreements (investigate, do not relabel just to boost score)', '',
 '| Case | Category | Expected | Actual |', '|---|---|---|---|', failures,'',
 '## Interpretation', '', ...summary.limitations.map(x=>`- ${x}`),'',
 'Evidence IDs and per-case reasons can be inspected in `reports/evaluation.json`. No tokens or cloud calls were used.',
];
writeFileSync(resolve(outDir,'evaluation.md'),lines.join('\n')+'\n');
console.log(`CaptionVAR curated evaluation: ${summary.totals.matching}/${summary.totals.count} label matches (${pct}%).`);
console.log(`${summary.totals.mismatching} disagreements — see reports/evaluation.md and reports/evaluation.json`);
console.log('No model or cloud inference was used.');
