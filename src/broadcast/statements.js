/**
 * The VAR check for lines that are not a moment's caption: the Analyst's
 * "why it matters" line and each sentence of a recap.
 *
 * Rules, stricter than for captions in one way and looser in another:
 *   - Every fact must hold. A line with any false or uncheckable fact does
 *     not air as written; there is no trimming, the editor rewrites it once
 *     and otherwise it is dropped (a caption always airs, context is optional).
 *   - Interpretation is allowed. A line explains why the facts matter, so a
 *     judgement the extractor reports as "opinion" ("the press is paying off")
 *     is marked as framing rather than failed, but only next to at least one
 *     checked fact, and never a comparison beyond this match.
 *   - The usual guards apply: every named player must be backed, and nothing
 *     after the moment (or the end of the half, for a recap) is visible.
 */
import { verifyCaption, checkNamedPlayers, checkSweepingClaims, BEYOND_MATCH } from './verify.js';
import { toVerifiableClaims, segmentsFromSpans } from './extracted.js';
import { observedFor } from './narrator.js';

export function verifyStatement(match, spot, text, extracted, people) {
  const claims = toVerifiableClaims(spot, extracted || []).map(c => ({ ...c, role: 'context' }));
  const observed = spot.moment.type === 'recap'
    ? match.events.filter(e => e.seq <= spot.trigger.seq)
    : observedFor(match, spot.trigger);
  let verdict = verifyCaption({ claims }, observed);
  verdict = checkNamedPlayers(text, verdict, [...people.players.values()]);
  verdict = checkSweepingClaims(text, verdict);

  // Judgements from the extractor are framing; the sweeping-comparison guard's
  // are not, and neither is a judgement that reaches beyond this match ("a
  // pressing intensity rarely seen this season", seen in a Foundry run).
  verdict.claims = verdict.claims.map(c => {
    if (c.kind !== 'opinion' || c.id === 'sweeping' || c.status !== 'unverifiable') return c;
    if (c.span && BEYOND_MATCH.test(c.span)) return { ...c, note: 'A comparison beyond this match cannot be checked against the match data.' };
    return { ...c, framing: true, note: 'Interpretation of the facts. Allowed, not checked.' };
  });
  const facts = verdict.claims.filter(c => !c.framing);
  const checked = facts.filter(c => c.status === 'supported' && c.kind !== 'named_player');
  if (facts.some(c => c.status === 'contradicted')) verdict.status = 'WITHHOLD';
  else if (facts.some(c => c.status !== 'supported')) verdict.status = 'QUALIFY';
  else if (!checked.length) {
    verdict.status = 'WITHHOLD';
    verdict.note = 'No checked fact: a line of context must stand on at least one number from the match.';
  } else verdict.status = 'VERIFY';
  return { claims, segments: segmentsFromSpans(text, verdict.claims), verdict };
}
