/**
 * Build the broadcast trace: every caption the narrator proposed, the VAR
 * decision on it, and machine-readable overlay records for each audience.
 *
 * This is the contract between the pipeline and any renderer. The agent
 * pipeline will emit the same shape, so the UI does not change when the
 * simulated narrator is replaced.
 */
import { narrate, globalT, indexPeople, observedFor, spotMoments } from './narrator.js';
import { verifyCaption } from './verify.js';
import { renderCaption, airFacts } from './render.js';
import { INSIGHT_TYPES, RECAPS, recapSpot } from './context.js';
import { simulateInsight, simulateRecap } from './analyst.js';
import { verifyStatement } from './statements.js';

export const TRACE_VERSION = '1.0';
const CHECK_LATENCY_S = 2; // match seconds between the trigger and the caption airing
const LINE_LATENCY_S = 5; // and its line of context

export function buildTrace(match, options = {}) {
  const people = indexPeople(match);
  const captions = narrate(match, options);
  const spots = spotMoments(match);
  let lines = 0;
  const decisions = captions.map((caption, i) => {
    const observed = observedFor(match, match.events[caption.seq - 1]);
    const verdict = verifyCaption(caption, observed);
    const decision = { ...caption, g: globalT(caption) + CHECK_LATENCY_S, verdict };
    if (INSIGHT_TYPES.has(spots[i].moment.type)) {
      // The test analyst plants an error in every third line.
      lines += 1;
      const plant = lines % 3 === 2 ? 'inflated_number' : null;
      decision.insight = checkedLine(match, spots[i], simulateInsight(match, spots[i], { plant }), people, 'analyst');
    }
    return decision;
  });
  const recaps = RECAPS.map(which => {
    const spot = recapSpot(match, which);
    const plant = which === 'FT' ? 'wrong_player' : null;
    const sim = simulateRecap(match, which, { plant });
    const sentences = sim.sentences.map((x, k) => checkedLine(match, spot, { ...x, planted_error: k === sim.planted_sentence ? sim.planted_error : null }, people, 'recap_writer'));
    return {
      id: `RECAP-${which}`, recap: which, trigger_event_id: spot.trigger.id, seq: spot.trigger.seq, period: spot.trigger.period,
      t: spot.trigger.t, display_minute: spot.trigger.display_minute,
      sentences, aired_text: sentences.filter(x => x.aired).map(x => x.aired.text).join(' '),
      planted_error: plant ? { kind: plant, sentence: sim.planted_sentence } : null,
    };
  });
  return { version: TRACE_VERSION, match_id: match.meta.match_id, source: 'simulated-narrator', people, decisions, recaps, summary: summarise(decisions) };
}

/** A test line checked by the referee, shaped like the agent trace (no editor: a failed line is cut). */
function checkedLine(match, spot, sim, people, author) {
  const checked = verifyStatement(match, spot, sim.text, sim.extracted, people);
  const status = checked.verdict.status;
  const flags = checked.verdict.claims.filter(c => c.status !== 'supported' && !c.framing).map(c => ({ span: c.span, status: c.status, note: c.note }));
  return {
    text: sim.text,
    segments: checked.segments,
    verdict: checked.verdict,
    planted_error: sim.planted_error ? { kind: sim.planted_error.kind } : null,
    aired: status === 'VERIFY' ? { text: sim.text, by: author, verified: true } : null,
    attempts: [{ attempt: 0, author, text: sim.text, status, flags }],
    timing: { time_to_air_s: LINE_LATENCY_S },
  };
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
