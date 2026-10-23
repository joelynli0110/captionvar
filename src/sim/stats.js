/**
 * Deterministic aggregation over a (possibly partial) event stream.
 *
 * These functions are the ground truth that CaptionVAR checks AI claims
 * against, so they deliberately avoid any modelling: every number can be
 * traced back to the event IDs that produced it.
 */

export const eventSeconds = e => e.t;

/** Events in a match-clock window [from, to] within one period (inclusive). */
export function windowEvents(events, { period, from = -Infinity, to = Infinity } = {}) {
  return events.filter(e => (period == null || e.period === period) && e.t >= from && e.t <= to);
}

/** Events observed up to and including a given sequence number (for live replay). */
export function eventsUntil(events, seq) {
  return events.filter(e => e.seq <= seq);
}

const bySide = (events, side) => events.filter(e => e.side === side);

export function teamStats(events, side) {
  const own = bySide(events, side);
  const passes = own.filter(e => e.type === 'pass');
  const completed = passes.filter(e => e.successful);
  const shots = own.filter(e => e.type === 'shot');
  const recoveries = own.filter(e => e.type === 'recovery');
  return {
    goals: own.filter(e => e.type === 'goal').length,
    shots: shots.length,
    shots_on_target: shots.filter(e => e.on_target).length,
    xg: Math.round(shots.reduce((s, e) => s + (e.xg || 0), 0) * 100) / 100,
    passes: passes.length,
    passes_completed: completed.length,
    pass_accuracy: passes.length ? Math.round((1000 * completed.length) / passes.length) / 10 : null,
    progressive_passes: completed.filter(e => e.progressive).length,
    crosses: passes.filter(e => e.pass_type === 'cross').length,
    pressures: own.filter(e => e.type === 'pressure').length,
    tackles: own.filter(e => e.type === 'tackle').length,
    tackles_won: own.filter(e => e.type === 'tackle' && e.won).length,
    interceptions: own.filter(e => e.type === 'interception').length,
    recoveries: recoveries.length,
    attacking_third_recoveries: recoveries.filter(e => e.zone === 'attacking_third').length,
    recoveries_after_pressure: recoveries.filter(e => e.after_pressure).length,
    fouls: own.filter(e => e.type === 'foul').length,
    yellow_cards: own.filter(e => e.type === 'card').length,
    corners: passes.filter(e => e.set_piece === 'corner').length,
    offsides: own.filter(e => e.type === 'offside').length,
    sprints: own.filter(e => e.type === 'sprint').length,
  };
}

/**
 * Possession share by on-ball action count (passes + carries + shots), the
 * same proxy many data providers use for live possession.
 */
export function possessionShare(events) {
  const onBall = events.filter(e => e.type === 'pass' || e.type === 'carry' || e.type === 'shot');
  const home = onBall.filter(e => e.side === 'home').length;
  const total = onBall.length;
  if (!total) return { home: null, away: null };
  const h = Math.round((1000 * home) / total) / 10;
  return { home: h, away: Math.round((100 - h) * 10) / 10 };
}

export function matchStats(events) {
  return {
    score: scoreAt(events),
    possession: possessionShare(events),
    home: teamStats(events, 'home'),
    away: teamStats(events, 'away'),
  };
}

export function scoreAt(events) {
  const goals = events.filter(e => e.type === 'goal');
  return {
    home: goals.filter(e => e.side === 'home').length,
    away: goals.filter(e => e.side === 'away').length,
  };
}

/** Per-player on-ball summary; physical totals come from the latest sprint/milestone event. */
export function playerStats(events, playerId) {
  const own = events.filter(e => e.player_id === playerId);
  const passes = own.filter(e => e.type === 'pass');
  const physical = own.filter(e => e.total_distance_km != null).at(-1);
  const sprints = own.filter(e => e.type === 'sprint');
  return {
    player_id: playerId,
    name: own[0]?.player ?? null,
    touches: own.filter(e => ['pass', 'carry', 'shot'].includes(e.type)).length,
    passes: passes.length,
    passes_completed: passes.filter(e => e.successful).length,
    shots: own.filter(e => e.type === 'shot').length,
    goals: own.filter(e => e.type === 'goal').length,
    assists: events.filter(e => e.type === 'goal' && e.assist_id === playerId).length,
    recoveries: own.filter(e => e.type === 'recovery').length,
    pressures: own.filter(e => e.type === 'pressure').length,
    top_speed_kmh: sprints.length ? Math.max(...sprints.map(e => e.top_speed_kmh)) : null,
    total_distance_km: physical?.total_distance_km ?? null,
  };
}
