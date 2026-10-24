/**
 * Turn claims extracted from free text by the Claim Extractor agent into
 * claims the VAR check can verify.
 *
 * The extractor only says WHAT the caption asserts (kind, player, number,
 * quoted span). Which event a claim refers to, and whether it is core or
 * detail, is decided here by code from the moment being captioned — never by
 * the model — so a model cannot talk its way into a weaker check.
 */

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
  recent_action: 'Something a named player (or a team) did in the build-up: a foul, winning the ball, pressing, a pass, a shot, a save, a block or a tackle.',
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
};

const WINDOW_S = 300;
/** How far back a build-up action may be (match seconds, same half). */
export const RECENT_WINDOW_S = 120;
export const RECENT_ACTIONS = ['foul', 'won_ball', 'pressure', 'pass', 'shot', 'save', 'block', 'tackle'];

/**
 * @param spot  { trigger, moment } from spotMoments()
 * @param extracted  [{ kind, span, player_id?, other_player_id?, side?, number?, outcome?, home?, away? }]
 */
export function toVerifiableClaims(spot, extracted) {
  const { trigger, moment } = spot;
  const type = moment.type;
  const used = new Map();
  const claims = [];

  for (const x of extracted) {
    let kind = EXTRACTABLE_KINDS[x.kind] ? x.kind : 'other_fact';
    // In a missed-chance moment, "X scores" asserts that the shot went in.
    if (type === 'chance' && kind === 'goal_scorer') kind = 'shot_outcome';
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
  return claims;
}

function mapClaim(kind, x, trigger, moment) {
  const side = x.side === 'home' || x.side === 'away' ? x.side : moment.side;
  const num = typeof x.number === 'number' ? x.number : Number(x.number);
  const goalRef = trigger.type === 'goal' ? trigger.id : null;
  const shotRef = trigger.type === 'shot' ? trigger.id : trigger.type === 'goal' ? trigger.shot_id : null;
  const outside = () => ({ kind: 'other_fact', asserted: x.span, note_hint: 'refers to something outside this moment' });

  switch (kind) {
    case 'goal_scorer': return goalRef ? { kind, ref: goalRef, asserted: x.player_id ?? 'unknown' } : outside();
    case 'goal_assist': return goalRef ? { kind, ref: goalRef, asserted: x.player_id ?? 'unknown' } : outside();
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
      if (!RECENT_ACTIONS.includes(x.action)) return { kind: 'other_fact', asserted: x.span };
      return {
        kind,
        params: { action: x.action, actor: x.player_id ?? null, other: x.other_player_id ?? null, side: x.side ?? null, until_seq: trigger.seq, window_s: RECENT_WINDOW_S },
        asserted: true,
      };
    case 'opinion': return { kind, asserted: true };
    default: return { kind: 'other_fact', asserted: x.span };
  }
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
