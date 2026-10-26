/**
 * Turn claims extracted from free text by the Claim Extractor agent into
 * claims the VAR check can verify.
 *
 * The extractor only says WHAT the caption asserts (kind, player, number,
 * quoted span). Which event a claim refers to, and whether it is core or
 * detail, is decided here by code from the moment being captioned — never by
 * the model — so a model cannot talk its way into a weaker check.
 */

import { TEAM_METRICS, PLAYER_METRICS, SINCE_METRICS, RECENT_POSSESSION_MIN } from './context.js';

/** The vocabulary the extractor may use. Anything else must be 'other_fact'. */
export const EXTRACTABLE_KINDS = {
  goal_scorer: 'A named player scored a goal.',
  goal_assist: 'A named player assisted / set up the goal.',
  score: 'The scoreline (home and away goals).',
  goal_from_press: 'The goal came from pressing / winning the ball back high up.',
  scorer_tally: "How many goals the scorer has now (e.g. 'his second').",
  shot_player: 'A named player took the shot / had the chance.',
  shot_outcome: 'What happened to the shot: goal, saved, off_target, blocked, woodwork.',
  shot_xg: 'The expected-goals (xG) value of the chance.',
  card_player: 'A named player was booked.',
  substitution: 'A named player came on and another went off.',
  top_speed: 'A player reached a speed in km/h.',
  distance: 'A player has covered a distance in km.',
  final_third_recoveries: 'How many times a team won the ball back in the final third in the recent window.',
  recoveries_after_press: 'How many of those recoveries came straight after pressing.',
  possession: "A team's share of possession in percent.",
  pass_accuracy: "A team's pass completion in percent.",
  recent_action: 'Something a named player (or a team) did in the build-up: a foul, winning the ball, pressing, a pass, a run with the ball, losing the ball, a shot, a save, a block or a tackle.',
  team_total: "A team's running total so far in the match (metric: goals, shots, shots_on_target, xg, corners, fouls, yellow_cards, final_third_recoveries).",
  player_total: "A player's running total so far in the match (metric: goals, assists, shots, recoveries, pressures, passes_completed).",
  minutes_since: "How many minutes since the team's previous shot, shot_on_target or goal (metric), e.g. 'their first shot on target in 20 minutes'.",
  recent_possession: "A team's share of possession in percent over the last 10 minutes.",
  goal_event: 'A goal scored earlier: who scored (player_id), who assisted (other_player_id) and at which minute (number), as far as stated.',
  card_event: 'A player booked earlier in the match.',
  opinion: 'A judgement, comparison or superlative that match data cannot confirm.',
  other_fact: 'Any other factual assertion not covered above.',
};

const CORE = {
  goal: ['goal_scorer', 'score'],
  chance: ['shot_player', 'shot_outcome'],
  card: ['card_player'],
  sub: ['substitution'],
  sprint: ['top_speed'],
  milestone: ['distance'],
  press: ['final_third_recoveries'],
  stat: ['possession'],
};

const ID_FOR = {
  goal_scorer: 'scorer', goal_assist: 'assist', score: 'score', goal_from_press: 'cause', scorer_tally: 'tally',
  shot_player: 'shooter', shot_outcome: 'outcome', shot_xg: 'xg', card_player: 'booked', substitution: 'change',
  top_speed: 'speed', distance: 'distance', final_third_recoveries: 'count', recoveries_after_press: 'pressed',
  possession: 'possession', pass_accuracy: 'accuracy', recent_action: 'action', opinion: 'opinion', other_fact: 'other',
  team_total: 'team', player_total: 'player', minutes_since: 'since', recent_possession: 'recent', goal_event: 'goal', card_event: 'card',
};

const WINDOW_S = 300;
/** How far back a build-up action may be (match seconds, same half). */
export const RECENT_WINDOW_S = 120;
export const RECENT_ACTIONS = ['foul', 'won_ball', 'pressure', 'pass', 'carry', 'giveaway', 'shot', 'save', 'block', 'tackle'];

/**
 * @param spot  { trigger, moment } from spotMoments()
 * @param extracted  [{ kind, span, player_id?, other_player_id?, side?, number?, outcome?, home?, away? }]
 */
export function toVerifiableClaims(spot, extracted) {
  const { trigger, moment } = spot;
  const type = moment.type;
  const used = new Map();
  const claims = [];

  for (let x of extracted) {
    let kind = EXTRACTABLE_KINDS[x.kind] ? x.kind : 'other_fact';
    // A recap spans a whole half: earlier goals and bookings are looked up in
    // the record, and a two-minute build-up window does not apply.
    if (type === 'recap') {
      if (kind === 'card_player') kind = 'card_event';
      // An assist belongs to an earlier goal, never to the build-up window.
      if (kind === 'goal_assist') kind = 'goal_event_assist';
      if (kind === 'recent_action' || kind === 'shot_player' || kind === 'shot_outcome') {
        x = { ...x, kind: 'other_fact' };
        kind = 'other_fact';
      }
    }
    // A shot, assist or booking mentioned outside its own moment is a build-up action.
    if (type !== 'chance' && type !== 'goal' && (kind === 'shot_player' || kind === 'shot_outcome')) {
      x = { ...x, kind: 'recent_action', action: 'shot' };
      kind = 'recent_action';
    }
    if (type !== 'goal' && kind === 'goal_assist') {
      x = { ...x, kind: 'recent_action', action: 'pass' };
      kind = 'recent_action';
    }
    if (type !== 'card' && kind === 'card_player') {
      x = { ...x, kind: 'recent_action', action: 'card' };
      kind = 'recent_action';
    }
    // Possession "over the last 10 minutes" or "in this spell" is the recent window, not the match.
    if (kind === 'possession' && RECENT_WORDING.test(x.span ?? '')) kind = 'recent_possession';
    // Speed and distance readings are easy to confuse; the moment decides which one it is.
    if (type === 'milestone' && kind === 'top_speed') kind = 'distance';
    if (type === 'sprint' && kind === 'distance') kind = 'top_speed';
    // In a missed-chance moment, "X scores" asserts that the shot went in.
    if (type === 'chance' && kind === 'goal_scorer') kind = 'shot_outcome';
    if (kind === 'goal_event_assist') {
      x = { ...x, kind: 'goal_event', other_player_id: x.player_id, player_id: null };
      kind = 'goal_event';
    }
    const claim = mapClaim(kind, x, trigger, moment);
    const base = ID_FOR[kind];
    const n = (used.get(base) || 0) + 1;
    used.set(base, n);
    claims.push({
      id: n === 1 ? base : `${base}-${n}`,
      role: claim.kind !== 'other_fact' && CORE[type]?.includes(kind) ? 'core' : 'context',
      span: x.span,
      extracted_kind: x.kind,
      ...claim,
    });
  }
  if (type === 'recap') pairAssists(claims);
  return claims;
}

const RECENT_WORDING = /\b(?:last|past)\s+(?:10|ten)\b|\bspell\b|\brecent(?:ly)?\b/i;

/**
 * "Strand scored in the 24th minute, assisted by Benedetti" is one goal: the
 * assist is checked together with the scorer and minute stated before it, so
 * an assist from a different goal does not pass.
 */
function pairAssists(claims) {
  let scorer = null;
  for (const c of claims) {
    if (c.kind !== 'goal_event') continue;
    if (c.asserted.scorer) scorer = c;
    else if (c.asserted.assist && scorer) {
      c.asserted = { ...c.asserted, scorer: scorer.asserted.scorer, minute: c.asserted.minute ?? scorer.asserted.minute };
    }
  }
}

function mapClaim(kind, x, trigger, moment) {
  const side = x.side === 'home' || x.side === 'away' ? x.side : moment.side;
  const num = typeof x.number === 'number' ? x.number : Number(x.number);
  const goalRef = trigger.type === 'goal' ? trigger.id : null;
  const shotRef = trigger.type === 'shot' ? trigger.id : trigger.type === 'goal' ? trigger.shot_id : null;
  const outside = () => ({ kind: 'other_fact', asserted: x.span, note_hint: 'refers to something outside this moment' });

  switch (kind) {
    // Outside its own goal moment, a scorer or assist refers to an earlier goal.
    case 'goal_scorer': return goalRef ? { kind, ref: goalRef, asserted: x.player_id ?? 'unknown' } : goalEvent({ scorer: x.player_id ?? 'unknown' }, x, trigger);
    case 'goal_assist': return goalRef ? { kind, ref: goalRef, asserted: x.player_id ?? 'unknown' } : goalEvent({ assist: x.player_id ?? 'unknown' }, x, trigger);
    case 'goal_event':
      return goalEvent({ ...(x.player_id ? { scorer: x.player_id } : {}), ...(x.other_player_id ? { assist: x.other_player_id } : {}) }, x, trigger, true);
    case 'card_event':
      return { kind, params: { until_seq: trigger.seq }, asserted: { player: x.player_id ?? 'unknown' } };
    case 'team_total':
      return TEAM_METRICS[x.metric] ? { kind, params: { until_seq: trigger.seq, side, metric: x.metric }, asserted: num } : { kind: 'other_fact', asserted: x.span };
    case 'player_total':
      return PLAYER_METRICS.includes(x.metric) && x.player_id
        ? { kind, params: { until_seq: trigger.seq, metric: x.metric }, asserted: { player: x.player_id, n: num } }
        : { kind: 'other_fact', asserted: x.span };
    case 'minutes_since':
      return SINCE_METRICS[x.metric] ? { kind, params: { until_seq: trigger.seq, side, metric: x.metric }, asserted: num } : { kind: 'other_fact', asserted: x.span };
    case 'recent_possession':
      return { kind, params: { until_seq: trigger.seq, window_min: RECENT_POSSESSION_MIN }, asserted: { side, pct: num } };
    case 'goal_from_press': return goalRef ? { kind, ref: goalRef, asserted: true } : outside();
    case 'scorer_tally': return goalRef ? { kind, ref: goalRef, asserted: num } : outside();
    case 'score': return { kind, asserted: { home: Number(x.home), away: Number(x.away) } };
    case 'shot_player': return shotRef ? { kind, ref: shotRef, asserted: x.player_id ?? 'unknown' } : outside();
    case 'shot_outcome': return shotRef ? { kind, ref: shotRef, asserted: x.outcome || (x.kind === 'goal_scorer' ? 'goal' : 'unknown') } : outside();
    case 'shot_xg': return shotRef ? { kind, ref: shotRef, asserted: num } : outside();
    case 'card_player': return trigger.type === 'card' ? { kind, ref: trigger.id, asserted: x.player_id ?? 'unknown' } : outside();
    case 'substitution':
      return trigger.type === 'substitution' ? { kind, ref: trigger.id, asserted: { on: x.player_id ?? 'unknown', off: x.other_player_id ?? 'unknown' } } : outside();
    case 'top_speed':
      return trigger.type === 'sprint' ? { kind, ref: trigger.id, asserted: { player: x.player_id ?? trigger.player_id, kmh: num } } : outside();
    case 'distance':
      return trigger.type === 'physical_milestone' ? { kind, ref: trigger.id, asserted: { player: x.player_id ?? trigger.player_id, km: num } } : outside();
    case 'final_third_recoveries':
      return { kind: 'window_count', params: { side, metric: 'attacking_third_recoveries', window_s: WINDOW_S, until_seq: trigger.seq }, asserted: num };
    case 'recoveries_after_press':
      return { kind: 'window_count', params: { side, metric: 'attacking_third_recoveries_after_pressure', window_s: WINDOW_S, until_seq: trigger.seq }, asserted: num };
    case 'possession': return { kind, params: { until_seq: trigger.seq }, asserted: { side, pct: num } };
    case 'pass_accuracy': return { kind, params: { until_seq: trigger.seq }, asserted: { side, pct: num } };
    case 'recent_action':
      if (!RECENT_ACTIONS.includes(x.action) && x.action !== 'card') return { kind: 'other_fact', asserted: x.span };
      return {
        kind,
        params: { action: x.action, actor: x.player_id ?? null, other: x.other_player_id ?? null, side: x.side ?? null, until_seq: trigger.seq, window_s: RECENT_WINDOW_S },
        asserted: true,
      };
    case 'opinion': return { kind, asserted: true };
    default: return { kind: 'other_fact', asserted: x.span };
  }
}

function goalEvent(asserted, x, trigger, withMinute = false) {
  const minute = withMinute && x.number != null && !Number.isNaN(Number(x.number)) ? Number(x.number) : null;
  return { kind: 'goal_event', params: { until_seq: trigger.seq }, asserted: { ...asserted, minute } };
}

/** Split caption text into segments tied to the claims whose quoted span they contain. */
export function segmentsFromSpans(text, claims) {
  const marks = [];
  for (const c of claims) {
    if (!c.span) continue;
    let at = text.indexOf(c.span);
    if (at < 0) at = text.toLowerCase().indexOf(c.span.toLowerCase());
    if (at < 0) continue;
    const end = at + c.span.length;
    if (marks.some(m => at < m.end && end > m.start)) continue; // keep first of overlapping spans
    marks.push({ start: at, end, claim: c.id });
  }
  marks.sort((a, b) => a.start - b.start);
  const segs = [];
  let pos = 0;
  for (const m of marks) {
    if (m.start > pos) segs.push({ text: text.slice(pos, m.start), claim: null });
    segs.push({ text: text.slice(m.start, m.end), claim: m.claim });
    pos = m.end;
  }
  if (pos < text.length) segs.push({ text: text.slice(pos), claim: null });
  return segs;
}
