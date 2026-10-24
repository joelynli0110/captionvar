#!/usr/bin/env node
/**
 * Factbox: the deterministic side of CaptionVAR, served to the Python agent
 * pipeline over stdio (one JSON request per line, one JSON response per line).
 *
 *   node scripts/factbox.mjs --seed captionvar-demo-6
 *
 * Requests: {"id": 1, "op": "<op>", ...}
 *   info                                   -> match id, number of moments
 *   moments                                -> narrator packets for every moment
 *   extractor_packet  {index, text}        -> what the extractor may see
 *   verify            {index, text, extracted}
 *                                          -> claims, segments, verdict (only events up to the moment)
 *   editor_packet     {index, text, verdict}
 *   template          {index, verdict}     -> safe English caption from true facts
 *   decision_header   {index}              -> fields the trace needs (seq, t, minute, facts...)
 *   simulated         {index, seed}        -> the test narrator's caption, for offline runs
 *
 * The same modules power the browser, so the agents are checked by exactly
 * the code that is unit-tested and shown in the UI.
 */
import { createInterface } from 'node:readline';
import { generateMatch } from '../src/sim/generateMatch.js';
import { spotMoments, captionHeader, indexPeople, narrate, observedFor } from '../src/broadcast/narrator.js';
import { verifyCaption } from '../src/broadcast/verify.js';
import { renderCaption } from '../src/broadcast/render.js';
import { toVerifiableClaims, segmentsFromSpans } from '../src/broadcast/extracted.js';
import { narratorPacket, extractorPacket, editorPacket } from '../src/broadcast/packets.js';

const args = process.argv.slice(2);
const seed = args.includes('--seed') ? args[args.indexOf('--seed') + 1] : 'captionvar-demo-6';

const match = generateMatch({ seed });
const people = indexPeople(match);
const spots = spotMoments(match);
const simulatedCache = new Map();

const spotAt = i => {
  const spot = spots[i];
  if (!spot) throw new Error(`no moment ${i}`);
  return spot;
};

/** Inverse of extracted.js, used to give the offline client realistic extractor output. */
const EXTRACT_KIND = {
  scorer: 'goal_scorer', assist: 'goal_assist', score: 'score', cause: 'goal_from_press', tally: 'scorer_tally',
  shooter: 'shot_player', outcome: 'shot_outcome', xg: 'shot_xg', booked: 'card_player', change: 'substitution',
  speed: 'top_speed', distance: 'distance', count: 'final_third_recoveries', pressed: 'recoveries_after_press',
  possession: 'possession', accuracy: 'pass_accuracy', opinion: 'opinion',
};

function simulated(index, narratorSeed) {
  if (!simulatedCache.has(narratorSeed)) simulatedCache.set(narratorSeed, narrate(match, { seed: narratorSeed }));
  const cap = simulatedCache.get(narratorSeed)[index];
  const text = cap.segments.map(s => s.text).join('');
  const extracted = cap.claims.map(c => {
    const span = cap.segments.filter(s => s.claim === c.id).map(s => s.text.trim()).join(' ') || c.id;
    const a = c.asserted;
    const x = { kind: EXTRACT_KIND[c.id] ?? 'other_fact', span };
    if (typeof a === 'string') { if (c.id === 'outcome') x.outcome = a; else x.player_id = a; }
    if (typeof a === 'number') x.number = a;
    if (a && typeof a === 'object') {
      if ('home' in a) { x.home = a.home; x.away = a.away; }
      if ('on' in a) { x.player_id = a.on; x.other_player_id = a.off; }
      if ('kmh' in a) { x.player_id = a.player; x.number = a.kmh; }
      if ('km' in a) { x.player_id = a.player; x.number = a.km; }
      if ('pct' in a) { x.side = a.side; x.number = a.pct; }
    }
    if (c.params?.side) x.side = c.params.side;
    return x;
  });
  return { text, extracted, planted_error: cap.planted_error };
}

const OPS = {
  info: () => ({ match_id: match.meta.match_id, seed, moments: spots.length, home: match.squads.home.name, away: match.squads.away.name }),
  moments: () => spots.map((spot, i) => narratorPacket(match, spot, i)),
  extractor_packet: ({ index, text }) => extractorPacket(match, spotAt(index), text),
  verify: ({ index, text, extracted }) => {
    const spot = spotAt(index);
    const claims = toVerifiableClaims(spot, extracted || []);
    const header = captionHeader(spot.trigger, spot.moment);
    const verdict = verifyCaption({ ...header, claims }, observedFor(match, spot.trigger));
    // A caption with no checkable claim at all must not air unchecked.
    if (!claims.length) {
      verdict.status = 'WITHHOLD';
      verdict.claims = [];
      verdict.note = 'No checkable claim was found in the caption.';
    }
    return { claims, segments: segmentsFromSpans(text, claims), verdict };
  },
  editor_packet: ({ index, text, verdict }) => editorPacket(match, spotAt(index), text, verdict),
  template: ({ index, verdict }) => {
    const spot = spotAt(index);
    const caption = { ...captionHeader(spot.trigger, spot.moment), facts: spot.facts };
    const v = verdict && verdict.status !== 'VERIFY' ? verdict : { status: 'QUALIFY', claims: verdict?.claims || [] };
    return { text: renderCaption(caption, v, people, { lang: 'en', persona: 'fan' }) };
  },
  decision_header: ({ index }) => {
    const spot = spotAt(index);
    return { ...captionHeader(spot.trigger, spot.moment), facts: spot.facts };
  },
  simulated: ({ index, seed: narratorSeed = 'narrator-10' }) => simulated(index, narratorSeed),
};

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', line => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
    const fn = OPS[req.op];
    if (!fn) throw new Error(`unknown op ${req.op}`);
    process.stdout.write(`${JSON.stringify({ id: req.id, ok: true, result: fn(req) })}\n`);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ id: req?.id ?? null, ok: false, error: String(err?.message || err) })}\n`);
  }
});
