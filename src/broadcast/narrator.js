/**
 * Simulated narrator.
 *
 * Stands in for the LLM narrator agent until the agent pipeline is wired in.
 * It watches the event stream, decides when a moment deserves a caption,
 * writes broadcast-style English and — like a real LLM — sometimes gets things
 * wrong. Mistakes are planted deliberately (seeded, reproducible) and recorded
 * in `planted_error`, which the verifier never reads: it is only used to score
 * how many planted errors the VAR check caught.
 *
 * Every caption is a list of text segments, each tied to the structured claim
 * it asserts, so the UI can strike through exactly the words that failed.
 */
import { createRng } from '../sim/rng.js';
import { possessionShare, teamStats } from '../sim/stats.js';

const PRESS_WINDOW_S = 300;

export function narrate(match, { seed = 'narrator-1', errorRate = 0.38 } = {}) {
  const rng = createRng(`${match.meta.seed}:${seed}`);
  const people = indexPeople(match);
  return spotMoments(match).map((spot, i) => {
    const { trigger, moment } = spot;
    const caption = {
      id: `CAP-${String(i + 1).padStart(3, '0')}`,
      ...captionHeader(trigger, moment),
      facts: spot.facts,
      claims: moment.claims,
      planted_error: null,
    };
    if (rng.chance(errorRate)) plantError(caption, moment, rng, people);
    caption.segments = moment.write(Object.fromEntries(caption.claims.map(c => [c.id, c.asserted])), people);
    return caption;
  });
}

export function captionHeader(trigger, moment) {
  return {
    trigger_event_id: trigger.id,
    seq: trigger.seq,
    period: trigger.period,
    t: trigger.t,
    display_minute: trigger.display_minute,
    type: moment.type,
    side: moment.side,
  };
}

/**
 * The spotter: decides which moments deserve a caption and records the true
 * facts of each (snapshot of its correct claims). Shared by the simulated
 * narrator and the LLM agent pipeline.
 */
export function spotMoments(match) {
  const events = match.events;
  const spots = [];
  const last = { chance: -Infinity, sprint: -Infinity, press: { home: -Infinity, away: -Infinity }, milestone11: 0 };
  const statMarks = [15 * 60, 32 * 60, 60 * 60, 82 * 60];
  let nextStat = 0;

  const push = (trigger, moment) => {
    const facts = Object.fromEntries(moment.claims.map(c => [c.id, structuredClone(c.asserted)]));
    spots.push({ trigger, moment, facts });
  };

  for (let i = 0; i < events.length; i += 1) {
    const e = events[i];
    const g = globalT(e);

    // Periodic possession reports (and half-time). Marks are match-clock seconds.
    const mark = statMarks[nextStat];
    if (mark != null && e.period === (mark >= 2700 ? 2 : 1) && e.t >= mark && e.type !== 'goal') {
      nextStat += 1;
      push(e, statMoment(events.slice(0, i + 1), match, false));
    }
    if (e.type === 'period_end' && e.period === 1) {
      push(e, statMoment(events.slice(0, i + 1), match, true));
      continue;
    }

    switch (e.type) {
      case 'goal':
        push(e, goalMoment(e, events.slice(0, i + 1)));
        break;
      case 'shot': {
        const big = e.outcome !== 'goal' && (e.xg >= 0.17 || (e.outcome === 'saved' && e.xg >= 0.1));
        if (big && g - last.chance > 75) {
          last.chance = g;
          const save = events.slice(i + 1, i + 3).find(x => x.type === 'save' && x.shot_id === e.id);
          push(e, chanceMoment(e, save));
        }
        break;
      }
      case 'card':
        push(e, cardMoment(e));
        break;
      case 'substitution':
        push(e, subMoment(e));
        break;
      case 'sprint':
        if (e.top_speed_kmh >= 34.2 && g - last.sprint > 600) {
          last.sprint = g;
          push(e, sprintMoment(e));
        }
        break;
      case 'physical_milestone':
        if (e.milestone_km === 12 || (e.milestone_km === 11 && last.milestone11 < 2)) {
          if (e.milestone_km === 11) last.milestone11 += 1;
          push(e, milestoneMoment(e));
        }
        break;
      case 'recovery': {
        if (e.zone !== 'attacking_third') break;
        const recent = events.slice(0, i + 1).filter(x => x.period === e.period && x.t >= e.t - PRESS_WINDOW_S
          && x.type === 'recovery' && x.side === e.side && x.zone === 'attacking_third');
        if (recent.length >= 3 && g - last.press[e.side] > 240) {
          last.press[e.side] = g;
          push(e, pressMoment(e, recent));
        }
        break;
      }
      default:
        break;
    }
  }
  return spots;
}

/**
 * What the VAR check may see for a caption: every event up to the trigger,
 * plus, for a shot, the save or block that stopped it (same moment, about a
 * second later). Nothing else from after the trigger.
 */
export function observedFor(match, trigger) {
  const before = match.events.filter(e => e.seq <= trigger.seq);
  if (trigger.type !== 'shot') return before;
  const stoppers = match.events.filter(e => e.seq > trigger.seq && e.seq <= trigger.seq + 3
    && (e.type === 'save' || e.type === 'block') && e.shot_id === trigger.id);
  return before.concat(stoppers);
}

/** Monotonic match time across both halves (second-half clock restarts at 45:00). */
export function globalT(e) {
  return e.period === 1 ? e.t : 2700 + 600 + (e.t - 2700);
}

// ------------------------------------------------------------------ people ---

export function indexPeople(match) {
  const players = new Map();
  const teams = {};
  for (const side of ['home', 'away']) {
    const sq = match.squads[side];
    teams[side] = { id: sq.id, name: sq.name, short: sq.short_name, side };
    teams[sq.id] = teams[side];
    for (const p of sq.players) players.set(p.id, { ...p, side });
  }
  const name = id => players.get(id)?.short_name ?? id;
  const full = id => players.get(id)?.name ?? id;
  const teammates = id => [...players.values()].filter(p => p.side === players.get(id)?.side && p.id !== id && p.role_group !== 'goalkeeper');
  return { players, teams, name, full, teammates };
}

const other = side => (side === 'home' ? 'away' : 'home');

// ----------------------------------------------------------------- moments ---
// Each moment returns { type, side, claims, write(asserted) -> segments }.
// Claim: { id, kind, role: 'core' | 'context', ref?, params?, asserted }.

function goalMoment(goal, observed) {
  const tally = observed.filter(e => e.type === 'goal' && e.scorer_id === goal.scorer_id).length;
  const shot = observed.find(e => e.id === goal.shot_id);
  const opener = observed.find(e => e.possession_id === shot?.possession_id);
  const fromPress = opener?.type === 'recovery' && opener.after_pressure === true;
  const claims = [
    { id: 'scorer', kind: 'goal_scorer', role: 'core', ref: goal.id, asserted: goal.scorer_id },
    { id: 'score', kind: 'score', role: 'core', asserted: { ...goal.score } },
  ];
  if (goal.assist_id) claims.push({ id: 'assist', kind: 'goal_assist', role: 'context', ref: goal.id, asserted: goal.assist_id });
  if (fromPress) claims.push({ id: 'cause', kind: 'goal_from_press', role: 'context', ref: goal.id, asserted: true });
  if (tally >= 2) claims.push({ id: 'tally', kind: 'scorer_tally', role: 'context', ref: goal.id, asserted: tally });
  return {
    type: 'goal',
    side: goal.side,
    claims,
    plantable: {
      scorer: 'wrong_scorer',
      score: 'wrong_score',
      ...(goal.assist_id ? { assist: 'wrong_assist' } : {}),
      ...(!fromPress ? { cause: 'invented_cause' } : {}),
      ...(tally < 2 ? { tally: 'invented_tally' } : {}),
    },
    write: (a, P) => {
      const team = P.teams[goal.side];
      const segs = [{ text: `${P.name(a.scorer)} scores for ${team.short}!`, claim: 'scorer' }];
      if (a.assist) segs.push({ text: ` Lovely work from ${P.name(a.assist)} to set it up.`, claim: 'assist' });
      if (a.cause) segs.push({ text: ` It all came from pressing high and winning the ball back.`, claim: 'cause' });
      if (a.tally) segs.push({ text: a.tally >= 3 ? ' That is a hat-trick!' : ' His second of the afternoon.', claim: 'tally' });
      segs.push({ text: ` ${P.teams.home.short} ${a.score.home}–${a.score.away} ${P.teams.away.short}.`, claim: 'score' });
      return segs;
    },
  };
}

function chanceMoment(shot, save) {
  const claims = [
    { id: 'shooter', kind: 'shot_player', role: 'core', ref: shot.id, asserted: shot.player_id },
    { id: 'outcome', kind: 'shot_outcome', role: 'core', ref: shot.id, asserted: shot.outcome },
  ];
  if (shot.xg >= 0.2) claims.push({ id: 'xg', kind: 'shot_xg', role: 'context', ref: shot.id, asserted: shot.xg });
  // Naming the keeper is a statement too: he made this save.
  if (save) {
    claims.push({
      id: 'keeper', kind: 'recent_action', role: 'context', asserted: true,
      params: { action: 'save', actor: save.player_id, other: null, side: null, until_seq: shot.seq, window_s: 120 },
    });
  }
  return {
    type: 'chance',
    side: shot.side,
    claims,
    plantable: { shooter: 'wrong_player', outcome: 'invented_goal', ...(shot.xg >= 0.2 ? { xg: 'inflated_number' } : {}) },
    write: (a, P) => {
      const who = P.name(a.shooter);
      const keeper = save ? P.name(save.player_id) : 'the keeper';
      const tail = {
        saved: ` — but ${keeper} saves.`,
        off_target: ' — just wide.',
        blocked: ' — but it is blocked.',
        woodwork: ' — and it smacks the woodwork!',
        goal: ` — and it's in! ${P.teams[shot.side].short} score!`,
      }[a.outcome];
      const segs = [
        { text: `Big chance for ${who}`, claim: 'shooter' },
        { text: tail, claim: 'outcome' },
      ];
      if (a.xg != null) segs.push({ text: ` That was a ${a.xg.toFixed(2)} xG opportunity.`, claim: 'xg' });
      return segs;
    },
  };
}

function cardMoment(card) {
  return {
    type: 'card',
    side: card.side,
    claims: [{ id: 'booked', kind: 'card_player', role: 'core', ref: card.id, asserted: card.player_id }],
    plantable: { booked: 'wrong_player' },
    write: (a, P) => [{ text: `Yellow card for ${P.name(a.booked)} of ${P.teams[card.side].short}.`, claim: 'booked' }],
  };
}

function subMoment(sub) {
  return {
    type: 'sub',
    side: sub.side,
    claims: [{ id: 'change', kind: 'substitution', role: 'core', ref: sub.id, asserted: { on: sub.player_on_id, off: sub.player_off_id } }],
    plantable: { change: 'swapped_sub' },
    write: (a, P) => [{ text: `${P.teams[sub.side].short} make a change: ${P.name(a.change.on)} on, ${P.name(a.change.off)} off.`, claim: 'change' }],
  };
}

function sprintMoment(s) {
  return {
    type: 'sprint',
    side: s.side,
    claims: [{ id: 'speed', kind: 'top_speed', role: 'core', ref: s.id, asserted: { player: s.player_id, kmh: s.top_speed_kmh } }],
    plantable: { speed: 'inflated_number' },
    write: (a, P) => [{ text: `${P.name(a.speed.player)} hits ${a.speed.kmh.toFixed(1)} km/h on that run.`, claim: 'speed' }],
  };
}

function milestoneMoment(m) {
  return {
    type: 'milestone',
    side: m.side,
    claims: [{ id: 'distance', kind: 'distance', role: 'core', ref: m.id, asserted: { player: m.player_id, km: m.milestone_km } }],
    plantable: { distance: 'inflated_number' },
    write: (a, P) => [{ text: `${P.name(a.distance.player)} has now covered ${a.distance.km} km.`, claim: 'distance' }],
  };
}

function pressMoment(rec, recent) {
  const after = recent.filter(e => e.after_pressure).length;
  const claims = [
    { id: 'count', kind: 'window_count', role: 'core', params: { side: rec.side, metric: 'attacking_third_recoveries', window_s: PRESS_WINDOW_S, until_seq: rec.seq }, asserted: recent.length },
  ];
  if (after >= 1) {
    claims.push({ id: 'pressed', kind: 'window_count', role: 'context', params: { side: rec.side, metric: 'attacking_third_recoveries_after_pressure', window_s: PRESS_WINDOW_S, until_seq: rec.seq }, asserted: after });
  }
  return {
    type: 'press',
    side: rec.side,
    claims,
    plantable: { count: 'inflated_number', ...(after >= 1 ? { pressed: 'inflated_number' } : {}), opinion: 'unverifiable_superlative' },
    write: (a, P) => {
      const segs = [{ text: `${P.teams[rec.side].short} have won the ball back in the final third ${a.count} times in the last five minutes`, claim: 'count' }];
      if (a.pressed != null) segs.push({ text: `, ${a.pressed} of them straight after pressing`, claim: 'pressed' });
      if (a.opinion) segs.push({ text: ' — the most ferocious pressing this league has seen all season', claim: 'opinion' });
      segs.push({ text: '.', claim: null });
      return segs;
    },
  };
}

function statMoment(observed, match, halfTime) {
  const poss = possessionShare(observed);
  const side = poss.home >= poss.away ? 'home' : 'away';
  const acc = teamStats(observed, side).pass_accuracy;
  const last = observed.at(-1);
  return {
    type: 'stat',
    side,
    claims: [
      { id: 'possession', kind: 'possession', role: 'core', params: { until_seq: last.seq }, asserted: { side, pct: Math.round(poss[side]) } },
      { id: 'accuracy', kind: 'pass_accuracy', role: 'context', params: { until_seq: last.seq }, asserted: { side, pct: Math.round(acc) } },
    ],
    plantable: { possession: 'wrong_team_or_number', accuracy: 'inflated_number' },
    halfTime,
    write: (a, P) => [
      { text: `${halfTime ? 'Half-time. ' : ''}${P.teams[a.possession.side].short} have had ${a.possession.pct}% of the ball`, claim: 'possession' },
      { text: `, completing ${a.accuracy.pct}% of their passes.`, claim: 'accuracy' },
    ],
  };
}

// ---------------------------------------------------------------- planting ---

/**
 * Corrupt one claim the way LLM commentary typically goes wrong: wrong
 * player, invented event, inflated number, invented cause, unverifiable
 * superlative. The caption keeps all its other (true) claims.
 */
function plantError(caption, moment, rng, P) {
  const options = Object.entries(moment.plantable || {});
  if (!options.length) return;
  // Subtle errors (a wrong detail inside an otherwise true caption) are the
  // dangerous ones in practice, so they are planted more often.
  const coreIds = new Set(caption.claims.filter(c => c.role === 'core').map(c => c.id));
  const [claimId, kind] = rng.weightedItem(options, ([id]) => (coreIds.has(id) ? 1 : 2.2));
  let claim = caption.claims.find(c => c.id === claimId);
  const before = claim ? structuredClone(claim.asserted) : null;

  switch (kind) {
    case 'wrong_scorer':
    case 'wrong_player':
    case 'wrong_assist': {
      claim.asserted = rng.pick(P.teammates(claim.asserted)).id;
      break;
    }
    case 'wrong_score': {
      const s = { ...claim.asserted };
      s[moment.side] += 1;
      claim.asserted = s;
      break;
    }
    case 'invented_cause':
      claim = { id: 'cause', kind: 'goal_from_press', role: 'context', ref: caption.trigger_event_id, asserted: true };
      caption.claims.push(claim);
      break;
    case 'invented_tally':
      claim = { id: 'tally', kind: 'scorer_tally', role: 'context', ref: caption.trigger_event_id, asserted: rng.chance(0.5) ? 2 : 3 };
      caption.claims.push(claim);
      break;
    case 'invented_goal':
      claim.asserted = 'goal';
      break;
    case 'swapped_sub':
      claim.asserted = { on: claim.asserted.off, off: claim.asserted.on };
      break;
    case 'unverifiable_superlative':
      claim = { id: 'opinion', kind: 'opinion', role: 'context', asserted: true };
      caption.claims.push(claim);
      break;
    case 'wrong_team_or_number': {
      const a = { ...claim.asserted };
      if (rng.chance(0.5)) a.side = other(a.side);
      else a.pct = Math.min(85, a.pct + rng.int(5, 9));
      claim.asserted = a;
      break;
    }
    case 'inflated_number': {
      const a = claim.asserted;
      if (typeof a === 'number' && claim.kind === 'shot_xg') claim.asserted = Math.min(0.95, Math.round((a * 2 + 0.1) * 100) / 100);
      else if (typeof a === 'number') claim.asserted = a + rng.int(1, 3);
      else if (a.kmh != null) claim.asserted = { ...a, kmh: Math.round((a.kmh + rng.range(1.8, 3.5)) * 10) / 10 };
      else if (a.km != null) claim.asserted = { ...a, km: a.km + 1 };
      else if (a.pct != null) claim.asserted = { ...a, pct: Math.min(99, a.pct + rng.int(4, 8)) };
      break;
    }
    default:
      return;
  }
  caption.planted_error = { claim_id: claim.id, kind, before, after: claim.asserted };
}
