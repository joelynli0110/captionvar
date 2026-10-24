/**
 * Structural and football-logic invariants for a generated match.
 *
 * Downstream agents trust this data as ground truth, so any violation is a
 * generator bug. Returns a list of human-readable problems (empty = valid).
 */
export function validateMatch(match) {
  const problems = [];
  const fail = (msg, e) => problems.push(e ? `${e.id}: ${msg}` : msg);
  const { events, squads, meta, script } = match;

  if (!Array.isArray(events) || !events.length) return ['no events'];

  const ids = new Set();
  const squadIds = new Set([...squads.home.players, ...squads.away.players].map(p => p.id));
  const sideOf = new Map();
  for (const side of ['home', 'away']) for (const p of squads[side].players) sideOf.set(p.id, side);

  const onPitch = {
    home: new Set(squads.home.players.filter(p => p.starter).map(p => p.id)),
    away: new Set(squads.away.players.filter(p => p.starter).map(p => p.id)),
  };
  const score = { home: 0, away: 0 };
  let lastSeq = 0;
  let lastT = { 1: -Infinity, 2: -Infinity };
  let lastPeriod = 1;
  const byId = new Map(events.map(e => [e.id, e]));

  for (const e of events) {
    if (ids.has(e.id)) fail('duplicate id', e);
    ids.add(e.id);
    if (e.seq !== lastSeq + 1) fail(`sequence gap (expected ${lastSeq + 1})`, e);
    lastSeq = e.seq;
    if (e.period < lastPeriod) fail('period went backwards', e);
    lastPeriod = e.period;
    if (e.t < lastT[e.period]) fail('clock went backwards', e);
    lastT[e.period] = e.t;
    if (e.minute !== Math.floor(e.t / 60) || e.second !== Math.floor(e.t % 60)) fail('minute/second disagree with t', e);

    for (const k of ['x', 'y', 'end_x', 'end_y']) {
      if (e[k] != null && (e[k] < 0 || e[k] > 100)) fail(`${k} out of bounds (${e[k]})`, e);
    }

    if (e.player_id) {
      if (!squadIds.has(e.player_id)) fail('unknown player', e);
      else if (sideOf.get(e.player_id) !== e.side) fail('player acting for the wrong side', e);
      else if (e.type !== 'substitution' && !onPitch[e.side].has(e.player_id)) fail(`${e.player_id} acted while not on the pitch`, e);
    }

    switch (e.type) {
      case 'pass':
        if (typeof e.successful !== 'boolean') fail('pass without successful flag', e);
        if (e.successful && sideOf.get(e.recipient_id) !== e.side) fail('completed pass to a non-teammate', e);
        if (e.recipient_id === e.player_id) fail('pass to self', e);
        if (!(e.distance_m >= 0)) fail('pass without distance', e);
        break;
      case 'shot':
        if (!(e.xg > 0 && e.xg < 1)) fail(`xg out of range (${e.xg})`, e);
        if (e.on_target !== (e.outcome === 'goal' || e.outcome === 'saved')) fail('on_target inconsistent with outcome', e);
        break;
      case 'goal': {
        score[e.side] += 1;
        const shot = byId.get(e.shot_id);
        if (!shot || shot.type !== 'shot' || shot.outcome !== 'goal') fail('goal without a matching scoring shot', e);
        if (e.score.home !== score.home || e.score.away !== score.away) fail('running score mismatch', e);
        if (e.assist_id && sideOf.get(e.assist_id) !== e.side) fail('assist by the wrong side', e);
        break;
      }
      case 'recovery':
        if (e.linked_pressure_id) {
          const pr = byId.get(e.linked_pressure_id);
          if (!pr || pr.type !== 'pressure' || pr.side !== e.side) fail('linked pressure is not a pressure by the recovering side', e);
          else if (pr.seq > e.seq || e.period !== pr.period || e.t - pr.t > 5.01) fail('linked pressure is not shortly before the recovery', e);
        }
        break;
      case 'substitution':
        if (!onPitch[e.side].has(e.player_off_id)) fail('substituted a player who was not on the pitch', e);
        if (onPitch[e.side].has(e.player_on_id)) fail('substitute already on the pitch', e);
        onPitch[e.side].delete(e.player_off_id);
        onPitch[e.side].add(e.player_on_id);
        break;
      case 'card':
        if (e.card === 'second_yellow' || e.card === 'red') onPitch[e.side].delete(e.player_id);
        break;
      default:
        break;
    }
  }

  if (meta.final_score.home !== score.home || meta.final_score.away !== score.away) {
    fail(`final score ${JSON.stringify(meta.final_score)} disagrees with goal events ${JSON.stringify(score)}`);
  }
  for (const beat of script || []) {
    if (beat.kind !== 'goal' || beat.skipped) continue;
    const goal = byId.get(beat.goal_event_id);
    if (!goal) fail(`scripted goal "${beat.label}" has no goal event`);
    else if (goal.scorer_id !== beat.scorer_id) fail(`scripted goal "${beat.label}" scored by ${goal.scorer_id}, expected ${beat.scorer_id}`);
    for (const id of beat.event_ids) if (!byId.has(id)) fail(`script references unknown event ${id}`);
  }
  return problems;
}
