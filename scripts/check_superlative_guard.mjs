#!/usr/bin/env node
/**
 * Checks the superlative guard (checkSweepingClaims) over every text recorded in
 * this repository: drafts, rewrites, lines of context and recap sentences from the
 * five evaluation matches and the published Foundry runs. Prints how many planted
 * superlatives it flags, and any text it flags that was not planted.
 *
 *   node scripts/check_superlative_guard.mjs
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { checkSweepingClaims } from '../src/broadcast/verify.js';
const hit = t => checkSweepingClaims(t, { status: 'VERIFY', claims: [] }).claims.length > 0;
process.chdir(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const seen = new Set(); let planted = 0, flagged = 0; const extra = [], missed = [];
function take(text, isPlanted) {
  if (!text || seen.has(text)) return; seen.add(text);
  const h = hit(text);
  if (isPlanted) { planted++; flagged += h; if (!h) missed.push(text); } else if (h) extra.push(text);
}
for (const f of fs.readdirSync('public/traces/eval')) {
  const d = JSON.parse(fs.readFileSync('public/traces/eval/' + f, 'utf8'));
  if (f.endsWith('.trace.json')) for (const x of d.decisions) x.attempts.forEach(a => take(a.text, a.attempt === 0 && x.planted_error?.kind === 'unverifiable_superlative'));
  if (f.endsWith('.baselines.json')) for (const [s, v] of Object.entries(d.setups)) for (const c of v.captions) {
    take(c.draft, c.planted === 'unverifiable_superlative'); take(c.aired, false);
    (c.steps || []).forEach(st => take(st.text, false));
  }
}
for (const f of ['public/traces/foundry-demo.json', 'public/traces/models/gpt-4.1-nano.json']) {
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const x of d.decisions) {
    x.attempts.forEach(a => take(a.text, a.attempt === 0 && x.planted_error?.kind === 'unverifiable_superlative'));
    x.insight?.attempts.forEach(a => take(a.text, a.attempt === 0 && x.insight.planted_error?.kind === 'unverifiable_superlative'));
  }
  (d.recaps || []).forEach(r => r.sentences.forEach(s => s.attempts.forEach(a => take(a.text, false))));
}
console.log({ texts: seen.size, planted, flagged });
missed.forEach(t => console.log('PLANTED, NOT FLAGGED (read it: did the agent write a superlative?):', t)); extra.forEach(t => console.log('NOT PLANTED:', t));
