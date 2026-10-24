/**
 * Build the broadcast trace: every caption the narrator proposed, the VAR
 * decision on it, and machine-readable overlay records for each audience.
 *
 * This is the contract between the pipeline and any renderer. The agent
 * pipeline will emit the same shape, so the UI does not change when the
 * simulated narrator is replaced.
 */
import { narrate, globalT, indexPeople, observedFor } from './narrator.js';
import { verifyCaption } from './verify.js';
import { renderCaption, airFacts } from './render.js';

export const TRACE_VERSION = '1.0';
const CHECK_LATENCY_S = 2; // match seconds between the trigger and the caption airing

export function buildTrace(match, options = {}) {
  const people = indexPeople(match);
  const captions = narrate(match, options);
  const decisions = captions.map(caption => {
    const observed = observedFor(match, match.events[caption.seq - 1]);
    const verdict = verifyCaption(caption, observed);
    return {
      ...caption,
      g: globalT(caption) + CHECK_LATENCY_S,
      verdict,
    };
  });
  return { version: TRACE_VERSION, match_id: match.meta.match_id, source: 'simulated-narrator', people, decisions, summary: summarise(decisions) };
}

/**
 * Detection score against the planted errors.
 *
 * Test narrator: an error is caught when the claim it corrupted did not pass,
 * and a flagged caption without a planted error is a false alarm (its other
 * claims are true by construction).
 * Agent narrator: the red team only names the kind of error, so an error is
 * caught when the caption did not pass; a flagged caption without a planted
 * error may be a genuine narrator mistake, so it is reported, not scored.
 */
export function summarise(decisions) {
  const planted = decisions.filter(d => d.planted_error);
  const caught = planted.filter(d => (d.planted_error.claim_id
    ? d.verdict.claims.find(c => c.id === d.planted_error.claim_id)?.status !== 'supported'
    : d.verdict.status !== 'VERIFY'));
  const clean = decisions.filter(d => !d.planted_error);
  const falseAlarms = clean.filter(d => d.verdict.status !== 'VERIFY');
  // Captions flagged without a planted error, split by why: a claim the data
  // contradicts (the narrator's own mistake) or only details it cannot confirm.
  const contradicts = d => d.verdict.claims.some(c => c.status === 'contradicted');
  const ownErrors = falseAlarms.filter(contradicts);
  const count = s => decisions.filter(d => d.verdict.status === s).length;
  return {
    captions: decisions.length,
    verified: count('VERIFY'),
    qualified: count('QUALIFY'),
    withheld: count('WITHHOLD'),
    planted_errors: planted.length,
    caught: caught.length,
    false_alarms: falseAlarms.length,
    unprompted_errors: ownErrors.length,
    unconfirmed_details: falseAlarms.length - ownErrors.length,
  };
}

/** Overlay record for one audience: what a graphics renderer would consume. */
export function overlayRecord(decision, people, view) {
  return {
    caption_id: decision.id,
    period: decision.period,
    match_clock: decision.display_minute,
    air_at_t: decision.t + CHECK_LATENCY_S,
    hold_s: 8,
    template: `lower_third.${decision.type}`,
    verdict: decision.verdict.status,
    language: view.lang,
    audience: view.persona,
    follow: view.follow,
    text: renderCaption(decision, decision.verdict, people, view),
    facts: airFacts(decision, decision.verdict),
    evidence_event_ids: decision.verdict.evidence,
  };
}
