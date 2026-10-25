/**
 * "Why it matters" and match recaps: the numbers behind a moment, computed
 * from the events observed so far, and the scopes the referee checks
 * free-standing lines against.
 *
 * The Analyst agent writes one line of context for key moments and the Recap
 * writer writes the half-time and full-time recaps from these facts. Every
 * number in them is checked by the same referee, with the claim kinds in
 * verify.js (team_total, player_total, minutes_since, recent_possession,
 * goal_event, card_event).
 */
import { possessionShare, teamStats, playerStats, scoreAt } from '../sim/stats.js';
import { indexPeople, observedFor } from './narrator.js';

/** Moments that get a line of context after their caption. */
export const INSIGHT_TYPES = new Set(['goal', 'chance', 'press', 'stat']);

/** Window for "recent" possession, in match minutes. */
export const RECENT_POSSESSION_MIN = 10;

/** Team metrics a line may quote, as named in claims, and where teamStats keeps them. */
export const TEAM_METRICS = {
  goals: 'goals',
  shots: 'shots',
  shots_on_target: 'shots_on_target',
  xg: 'xg',
  corners: 'corners',
  fouls: 'fouls',
  yellow_cards: 'yellow_cards',
  final_third_recoveries: 'attacking_third_recoveries',
};

export const PLAYER_METRICS = ['goals', 'assists', 'shots', 'recoveries', 'pressures', 'passes_completed'];

/** Events that count for "minutes since the last ...". */
export const SINCE_METRICS = {
  shot: e => e.type === 'shot',
  shot_on_target: e => e.type === 'shot' && e.on_target,
  goal: e => e.type === 'goal',
};

/**
 * Match clock in seconds for elapsed-time claims. First-half stoppage time is
 * clamped to 45:00, so "the first shot in 20 minutes" means regular minutes.
 */
export const clockSeconds = e => (e.period === 1 ? Math.min(e.t, 2700) : e.t);

/** The side's last matching event strictly before `trigger`, or null. */
export function previousEvent(observed, trigger, side, metric) {
  const match = SINCE_METRICS[metric];
  for (let i = observed.length - 1; i >= 0; i -= 1) {
    const e = observed[i];
    if (e.seq < trigger.seq && e.side === side && match(e)) return e;
  }
  return null;
}

/** Minutes from the previous matching event (or kick-off) to the trigger. */
export function minutesSince(observed, trigger, side, metric) {
  const prev = previousEvent(observed, trigger, side, metric);
  const from = prev ? clockSeconds(prev) : 0;
  return { minutes: Math.round(((clockSeconds(trigger) - from) / 60) * 10) / 10, prev };
}

/** Events in the last `minutes` of match clock before the trigger, same half. */
export function recentWindow(observed, trigger, minutes = RECENT_POSSESSION_MIN) {
  return observed.filter(e => e.seq <= trigger.seq && e.period === trigger.period && e.t >= trigger.t - minutes * 60);
}

const round1 = x => (x == null ? null : Math.round(x * 10) / 10);

function teamLine(observed, trigger, side) {
  const s = teamStats(observed, side);
  const since = metric => {
    const { minutes, prev } = minutesSince(observed, trigger, side, metric);
    return prev ? minutes : null;
  };
  return {
    goals: s.goals,
    shots: s.shots,
    shots_on_target: s.shots_on_target,
    xg: s.xg,
    corners: s.corners,
    fouls: s.fouls,
    yellow_cards: s.yellow_cards,
    final_third_recoveries: s.attacking_third_recoveries,
    final_third_recoveries_last_10_min: recentWindow(observed, trigger).filter(e => e.type === 'recovery' && e.side === side && e.zone === 'attacking_third').length,
    minutes_since_previous_shot: since('shot'),
    minutes_since_previous_shot_on_target: since('shot_on_target'),
    minutes_since_previous_goal: since('goal'),
  };
}

/** The player a moment is about, if any. */
function momentPlayer(spot) {
  const F = spot.facts;
  return F.scorer ?? F.shooter ?? F.booked ?? null;
}

/**
 * Everything the Analyst may use for one moment. Counts include the moment
 * itself ("their fifth shot" counts this shot); "minutes since previous" looks
 * only at events before it.
 */
export function contextFacts(match, spot) {
  const people = indexPeople(match);
  const observed = observedFor(match, spot.trigger);
  const trigger = spot.trigger;
  const recent = possessionShare(recentWindow(observed, trigger));
  const overall = possessionShare(observed);
  const score = scoreAt(observed);
  const pid = momentPlayer(spot);
  const player = pid ? playerStats(observed, pid) : null;
  const t = side => people.teams[side].name;
  return {
    score: `${t('home')} ${score.home}-${score.away} ${t('away')}`,
    teams: { [t('home')]: teamLine(observed, trigger, 'home'), [t('away')]: teamLine(observed, trigger, 'away') },
    possession_pct_so_far: { [t('home')]: round1(overall.home), [t('away')]: round1(overall.away) },
    possession_pct_last_10_min: { [t('home')]: round1(recent.home), [t('away')]: round1(recent.away) },
    player: player && {
      name: people.full(pid),
      team: t(people.players.get(pid).side),
      goals: player.goals, assists: player.assists, shots: player.shots,
      recoveries: player.recoveries, pressures: player.pressures, passes_completed: player.passes_completed,
    },
  };
}

// ------------------------------------------------------------------ recaps

/** Recaps: 'HT' after the first half, 'FT' at the final whistle. */
export const RECAPS = ['HT', 'FT'];

/** A pseudo-moment for a recap: everything up to the end of the half or match. */
export function recapSpot(match, which) {
  const period = which === 'HT' ? 1 : 2;
  const trigger = match.events.find(e => e.type === 'period_end' && e.period === period) ?? match.events.at(-1);
  return { trigger, moment: { type: 'recap', side: null, recap: which }, facts: {} };
}

export function recapFacts(match, which) {
  const people = indexPeople(match);
  const { trigger } = recapSpot(match, which);
  const observed = match.events.filter(e => e.seq <= trigger.seq);
  const t = side => people.teams[side].name;
  const score = scoreAt(observed);
  const goals = observed.filter(e => e.type === 'goal').map(e => ({
    minute: e.display_minute, team: t(e.side), scorer: people.full(e.scorer_id),
    assist: e.assist_id ? people.full(e.assist_id) : null,
  }));
  const cards = observed.filter(e => e.type === 'card').map(e => ({ minute: e.display_minute, team: t(e.side), player: people.full(e.player_id) }));
  const share = possessionShare(observed);
  const stats = side => {
    const s = teamStats(observed, side);
    return { shots: s.shots, shots_on_target: s.shots_on_target, xg: s.xg, corners: s.corners, fouls: s.fouls, final_third_recoveries: s.attacking_third_recoveries, pass_accuracy_pct: s.pass_accuracy };
  };
  // Leading players by a few counts the referee can check.
  const ids = [...people.players.keys()];
  const top = metric => {
    const best = ids.map(id => ({ id, n: playerStats(observed, id)[metric] })).sort((a, b) => b.n - a.n)[0];
    return best && best.n > 0 ? { player: people.full(best.id), team: t(people.players.get(best.id).side), [metric]: best.n } : null;
  };
  return {
    recap: which === 'HT' ? 'half-time' : 'full-time',
    score: `${t('home')} ${score.home}-${score.away} ${t('away')}`,
    goals,
    yellow_cards: cards,
    possession_pct: { [t('home')]: share.home, [t('away')]: share.away },
    teams: { [t('home')]: stats('home'), [t('away')]: stats('away') },
    most_shots: top('shots'),
    most_recoveries: top('recoveries'),
  };
}
