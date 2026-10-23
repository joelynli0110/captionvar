import test from 'node:test';
import assert from 'node:assert/strict';
import { generateMatch } from '../sim/generateMatch.js';
import { buildTrace, overlayRecord } from './trace.js';
import { verifyCaption } from './verify.js';
import { renderCaption, LANGUAGES } from './render.js';

const match = generateMatch({ seed: 'captionvar-demo-6' });
const trace = buildTrace(match, { seed: 'narrator-10' });

test('trace is deterministic for the same seeds', () => {
  const again = buildTrace(match, { seed: 'narrator-10' });
  assert.deepEqual(again.decisions.map(d => [d.id, d.verdict.status, d.planted_error?.kind]), trace.decisions.map(d => [d.id, d.verdict.status, d.planted_error?.kind]));
});

test('the VAR check never uses events from after the caption', () => {
  for (const d of trace.decisions) {
    for (const id of d.verdict.evidence) {
      const e = match.events.find(x => x.id === id);
      assert.ok(e.seq <= d.seq, `${d.id} cites future event ${id}`);
    }
  }
});

test('verdicts depend only on the claims, not on the planted-error label', () => {
  for (const d of trace.decisions.filter(x => x.planted_error)) {
    const observed = match.events.filter(e => e.seq <= d.seq);
    const blind = verifyCaption({ ...d, planted_error: undefined }, observed);
    assert.equal(blind.status, d.verdict.status);
  }
});

test('across many matches every planted error is caught with no false alarms', () => {
  let planted = 0;
  for (let i = 0; i < 6; i += 1) {
    const m = generateMatch({ seed: `var-${i}` });
    for (const ns of ['n-a', 'n-b']) {
      const { summary } = buildTrace(m, { seed: ns });
      planted += summary.planted_errors;
      assert.equal(summary.caught, summary.planted_errors, `match var-${i}, narrator ${ns}`);
      assert.equal(summary.false_alarms, 0, `match var-${i}, narrator ${ns}`);
    }
  }
  assert.ok(planted > 100, `only ${planted} planted errors exercised`);
});

test('the demo window shows all three verdicts', () => {
  const window = trace.decisions.filter(d => d.period === 2 && d.t >= 72 * 60 && d.t <= 78 * 60);
  const statuses = new Set(window.map(d => d.verdict.status));
  assert.deepEqual([...statuses].sort(), ['QUALIFY', 'VERIFY', 'WITHHOLD']);
  const fakeGoal = window.find(d => d.planted_error?.kind === 'invented_goal');
  assert.equal(fakeGoal.verdict.status, 'WITHHOLD');
  const equaliser = window.find(d => d.type === 'goal');
  assert.equal(equaliser.verdict.status, 'VERIFY');
  assert.ok(equaliser.verdict.claims.find(c => c.id === 'cause').evidence.some(id => id.startsWith('PR-')));
});

test('a withheld caption airs the corrected fact in every language and view', () => {
  const fakeGoal = trace.decisions.find(d => d.planted_error?.kind === 'invented_goal');
  for (const { code } of LANGUAGES) {
    for (const persona of ['fan', 'analyst']) {
      const text = renderCaption(fakeGoal, fakeGoal.verdict, trace.people, { lang: code, persona });
      assert.ok(text.length > 10);
      assert.doesNotMatch(text, /undefined|NaN|null/);
      assert.doesNotMatch(text, /it's in|score!/i);
    }
  }
});

test('every caption renders cleanly in every language, view and allegiance', () => {
  for (const d of trace.decisions) {
    for (const { code } of LANGUAGES) {
      for (const persona of ['fan', 'analyst']) {
        for (const follow of ['neutral', 'home', 'away']) {
          const text = renderCaption(d, d.verdict, trace.people, { lang: code, persona, follow });
          assert.ok(text.trim().length > 5, `${d.id} ${code} ${persona}`);
          assert.doesNotMatch(text, /undefined|NaN|\[object/, `${d.id} ${code} ${persona}: ${text}`);
        }
      }
    }
  }
});

test('a trimmed caption drops exactly the failed detail', () => {
  const trimmed = trace.decisions.find(d => d.verdict.status === 'QUALIFY' && d.planted_error?.kind === 'unverifiable_superlative');
  const text = renderCaption(trimmed, trimmed.verdict, trace.people, { lang: 'en', persona: 'fan' });
  assert.doesNotMatch(text, /season/);
  assert.match(text, /\d+ times/);
});

test('overlay records are machine-readable and carry their evidence', () => {
  const d = trace.decisions.find(x => x.type === 'goal');
  const rec = overlayRecord(d, trace.people, { lang: 'de', persona: 'analyst', follow: 'home' });
  assert.equal(rec.template, 'lower_third.goal');
  assert.equal(rec.language, 'de');
  assert.ok(rec.evidence_event_ids.length > 0);
  assert.equal(typeof rec.air_at_t, 'number');
  JSON.parse(JSON.stringify(rec));
});
