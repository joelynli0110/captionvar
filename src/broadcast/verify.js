/**
 * The VAR check.
 *
 * Verifies each structured claim of a caption against the events observed up
 * to that moment (never the future) and decides what may reach the screen:
 *
 *   VERIFY   every claim is supported            -> caption airs as written
 *   QUALIFY  a context claim fails or cannot be  -> airs without that part
 *            checked, the core claims hold
 *   WITHHOLD a core claim is contradicted        -> caption is blocked; a
 *                                                   corrected caption built
 *                                                   from the data airs instead
 *
 * Numbers are compared by code with explicit tolerances, never by a model.
 */
import { possessionShare, teamStats } from '../sim/stats.js';

const TOLERANCE = { kmh: 0.2, xg: 0.015 };

/** A whole-number percentage is right only if it is the actual value rounded down or up. */
const pctMatches = (stated, actual) => stated >= Math.floor(actual) && stated <= Math.ceil(actual);

export function verifyCaption(caption, observed) {
  const byId = new Map(observed.map(e => [e.id, e]));
  const results = caption.claims.map(claim => ({ ...claim, ...checkClaim(claim, observed, byId) }));
  const coreFail = results.some(r => r.role === 'core' && r.status !== 'supported');
  const contextFail = results.some(r => r.role === 'context' && r.status !== 'supported');
  const status = coreFail ? 'WITHHOLD' : contextFail ? 'QUALIFY' : 'VERIFY';
  const evidence = [...new Set(results.flatMap(r => r.evidence))];
  return { status, claims: results, evidence };
}

const supported = (actual, evidence, note) => ({ status: 'supported', actual, evidence, note });
const contradicted = (actual, evidence, note) => ({ status: 'contradicted', actual, evidence, note });
const unverifiable = note => ({ status: 'unverifiable', actual: null, evidence: [], note });

function checkClaim(claim, observed, byId) {
  const ref = claim.ref ? byId.get(claim.ref) : null;
  if (claim.ref && !ref) return contradicted(null, [], `No event ${claim.ref} has been recorded.`);
  const a = claim.asserted;

  switch (claim.kind) {
    case 'goal_scorer':
      return a === ref.scorer_id
        ? supported(ref.scorer_id, [ref.id, ref.shot_id], 'Goal event names this scorer.')
        : contradicted(ref.scorer_id, [ref.id, ref.shot_id], 'The goal event names a different scorer.');

    case 'goal_assist':
      return a === ref.assist_id
        ? supported(ref.assist_id, [ref.id], 'Goal event names this assist.')
        : contradicted(ref.assist_id ?? null, [ref.id], ref.assist_id ? 'A different player provided the assist.' : 'No assist is recorded.');

    case 'score': {
      const goals = observed.filter(e => e.type === 'goal');
      const actual = { home: goals.filter(e => e.side === 'home').length, away: goals.filter(e => e.side === 'away').length };
      return actual.home === a.home && actual.away === a.away
        ? supported(actual, goals.map(e => e.id), 'Score matches the goal events so far.')
        : contradicted(actual, goals.map(e => e.id), `Goal events give ${actual.home}–${actual.away}.`);
    }

    case 'goal_from_press': {
      const shot = byId.get(ref.shot_id);
      const opener = observed.find(e => e.possession_id === shot?.possession_id);
      const pressure = opener?.linked_pressure_id ? byId.get(opener.linked_pressure_id) : null;
      if (opener?.type === 'recovery' && opener.after_pressure && pressure) {
        return supported(true, [pressure.id, opener.id, shot.id, ref.id], 'The move began with a recovery made within 5 s of a pressure.');
      }
      const how = opener?.type === 'recovery' ? `a ${opener.how.replace('_', ' ')} with no pressure before it` : opener?.set_piece ? `a ${opener.set_piece.replace('_', ' ')}` : 'a restart';
      return contradicted(false, opener ? [opener.id, shot?.id].filter(Boolean) : [], `The move began with ${how}.`);
    }

    case 'scorer_tally': {
      const goals = observed.filter(e => e.type === 'goal' && e.scorer_id === ref.scorer_id);
      return goals.length === a
        ? supported(goals.length, goals.map(e => e.id), `${goals.length} goals recorded for this player.`)
        : contradicted(goals.length, goals.map(e => e.id), `Only ${goals.length} goal${goals.length === 1 ? '' : 's'} recorded for this player.`);
    }

    case 'shot_player':
    case 'card_player':
      return a === ref.player_id
        ? supported(ref.player_id, [ref.id], 'Event names this player.')
        : contradicted(ref.player_id, [ref.id], 'The event names a different player.');

    case 'shot_outcome': {
      const goal = observed.find(e => e.type === 'goal' && e.shot_id === ref.id);
      const actual = goal ? 'goal' : ref.outcome;
      const ev = [ref.id, ...observed.filter(e => (e.type === 'save' || e.type === 'block') && e.shot_id === ref.id).map(e => e.id)];
      return a === actual
        ? supported(actual, ev, `Shot outcome: ${actual.replace('_', ' ')}.`)
        : contradicted(actual, ev, a === 'goal' ? `No goal: the shot was ${actual.replace('_', ' ')}.` : `Shot outcome was ${actual.replace('_', ' ')}.`);
    }

    case 'shot_xg':
      return Math.abs(a - ref.xg) <= TOLERANCE.xg
        ? supported(ref.xg, [ref.id], 'Matches the shot xG.')
        : contradicted(ref.xg, [ref.id], `Recorded xG is ${ref.xg.toFixed(2)}.`);

    case 'substitution':
      return a.on === ref.player_on_id && a.off === ref.player_off_id
        ? supported({ on: ref.player_on_id, off: ref.player_off_id }, [ref.id], 'Matches the substitution.')
        : contradicted({ on: ref.player_on_id, off: ref.player_off_id }, [ref.id], 'Players coming on and off are the other way round.');

    case 'top_speed':
      return a.player === ref.player_id && Math.abs(a.kmh - ref.top_speed_kmh) <= TOLERANCE.kmh
        ? supported({ player: ref.player_id, kmh: ref.top_speed_kmh }, [ref.id], 'Matches the speed reading.')
        : contradicted({ player: ref.player_id, kmh: ref.top_speed_kmh }, [ref.id], `Recorded top speed is ${ref.top_speed_kmh.toFixed(1)} km/h.`);

    case 'distance':
      return a.player === ref.player_id && a.km === ref.milestone_km
        ? supported({ player: ref.player_id, km: ref.milestone_km }, [ref.id], 'Matches the distance reading.')
        : contradicted({ player: ref.player_id, km: ref.milestone_km }, [ref.id], `Recorded milestone is ${ref.milestone_km} km.`);

    case 'window_count': {
      const { side, metric, window_s: w, until_seq: until } = claim.params;
      const end = observed.find(e => e.seq === until);
      const hits = observed.filter(e => e.seq <= until && e.period === end.period && e.t >= end.t - w
        && e.type === 'recovery' && e.side === side && e.zone === 'attacking_third'
        && (metric !== 'attacking_third_recoveries_after_pressure' || e.after_pressure));
      const ids = hits.map(e => e.id);
      return hits.length === a
        ? supported(hits.length, ids, `${hits.length} matching recoveries in the window.`)
        : contradicted(hits.length, ids, `The window contains ${hits.length}, not ${a}.`);
    }

    case 'possession': {
      const seen = observed.filter(e => e.seq <= claim.params.until_seq);
      const share = possessionShare(seen);
      const actual = { side: a.side, pct: Math.round(share[a.side]) };
      return pctMatches(a.pct, share[a.side])
        ? supported(actual, [], `On-ball share ${share[a.side]}%.`)
        : contradicted({ side: share.home >= share.away ? 'home' : 'away', pct: Math.round(Math.max(share.home, share.away)) }, [], `${a.side === 'home' ? 'Home' : 'Away'} share is ${share[a.side]}%.`);
    }

    case 'pass_accuracy': {
      const seen = observed.filter(e => e.seq <= claim.params.until_seq);
      const acc = teamStats(seen, a.side).pass_accuracy;
      return pctMatches(a.pct, acc)
        ? supported({ side: a.side, pct: Math.round(acc) }, [], `Pass accuracy ${acc}%.`)
        : contradicted({ side: a.side, pct: Math.round(acc) }, [], `Pass accuracy is ${acc}%.`);
    }

    case 'opinion':
      return unverifiable('A judgement or comparison beyond this match cannot be checked against the match data.');

    case 'recent_action':
      return checkRecentAction(claim.params, observed);

    case 'other_fact':
      return unverifiable(`No rule can check this statement against the match data${claim.note_hint ? ` (it ${claim.note_hint})` : ''}.`);

    default:
      return unverifiable('No rule exists to check this kind of claim.');
  }
}

/**
 * Build-up actions ("after Morita won it back", "a foul on Whitcombe",
 * "pressing from Vence"): the action must appear among the events of the same
 * half in the window before the moment. The event record is complete, so an
 * action that is not there did not happen in that window.
 */
const ACTION_MATCH = {
  foul: e => e.type === 'foul',
  won_ball: e => e.type === 'recovery' || e.type === 'interception' || (e.type === 'tackle' && e.won),
  pressure: e => e.type === 'pressure',
  pass: e => e.type === 'pass' && e.successful,
  carry: e => e.type === 'carry' || e.type === 'sprint',
  giveaway: e => (e.type === 'pass' && !e.successful) || (e.type === 'tackle' && e.won),
  shot: e => e.type === 'shot',
  save: e => e.type === 'save',
  block: e => e.type === 'block' || e.type === 'clearance',
  tackle: e => e.type === 'tackle',
  card: e => e.type === 'card',
};
const ACTION_WORD = {
  foul: 'foul', won_ball: 'ball won back', pressure: 'press', pass: 'completed pass', carry: 'run with the ball',
  giveaway: 'loss of possession', shot: 'shot', save: 'save', block: 'block or clearance', tackle: 'tackle', card: 'booking',
};

/**
 * Who did the action and who was on the other end, as the claim would name
 * them. Shots are linked to the block or save that stopped them, so "Vence's
 * shot is blocked by Abara" and "Strand's chance is blocked" both resolve.
 */
function participants(e, action, observed) {
  const shooterOf = id => observed.find(x => x.id === id)?.player_id;
  if (action === 'giveaway' && e.type === 'tackle') return { doers: [e.target_id], others: [e.player_id] };
  if (e.type === 'shot') {
    const stoppers = observed.filter(x => (x.type === 'block' || x.type === 'save') && x.shot_id === e.id).map(x => x.player_id);
    return { doers: [e.player_id], others: stoppers };
  }
  if ((e.type === 'block' || e.type === 'save') && e.shot_id) {
    const shooter = shooterOf(e.shot_id);
    return { doers: [e.player_id, shooter], others: [shooter, e.player_id] };
  }
  if (e.type === 'card') {
    // A booking records only who was booked; the foul just before it names the victim.
    const foul = observed.filter(x => x.type === 'foul' && x.player_id === e.player_id && x.seq < e.seq && x.seq >= e.seq - 3).at(-1);
    return { doers: [e.player_id], others: foul ? [foul.fouled_id] : [] };
  }
  if (action === 'giveaway' && e.type === 'pass') {
    // "lost it to X": X is whoever won the loose or intercepted ball next.
    const winners = observed.filter(x => x.seq > e.seq && x.seq <= e.seq + 3 && x.side !== e.side
      && (x.type === 'interception' || x.type === 'recovery')).map(x => x.player_id);
    return { doers: [e.player_id], others: winners };
  }
  const other = e.fouled_id ?? e.target_id ?? e.recipient_id ?? null;
  return { doers: [e.player_id], others: other ? [other] : [] };
}

function checkRecentAction({ action, actor, other, side, until_seq: until, window_s: w }, observed) {
  const end = observed.find(e => e.seq === until);
  // The window before the moment, plus the save or block of the moment's own shot.
  const stopsTrigger = e => (e.type === 'save' || e.type === 'block') && e.shot_id === end.id;
  const recent = observed.filter(e => (e.seq <= until || stopsTrigger(e)) && e.period === end.period && e.t >= end.t - w);
  const matches = (e, withActor) => {
    if (!ACTION_MATCH[action](e)) return false;
    const p = participants(e, action, recent);
    // A recovery or a carry has no opponent recorded: check the actor only.
    const otherOk = !other || p.others.includes(other) || (p.others.length === 0 && (action === 'won_ball' || action === 'carry'));
    const actorOk = !withActor || !actor || p.doers.includes(actor);
    // When a tackle is the giveaway, the team that lost the ball is the other one.
    const losingSide = action === 'giveaway' && e.type === 'tackle' ? (e.side === 'home' ? 'away' : 'home') : e.side;
    const sideOk = actor || other || !side || losingSide === side;
    return otherOk && actorOk && sideOk;
  };
  const hits = recent.filter(e => matches(e, true));
  const minutes = Math.round(w / 60);
  if (hits.length) {
    const last = hits.at(-1);
    return supported(true, hits.slice(-3).map(e => e.id), `Recorded at ${last.display_minute} (${last.id}).`);
  }
  // Same action by someone else in the window: name who actually did it.
  const sameAction = recent.filter(e => matches(e, false)).at(-1);
  const note = sameAction && actor
    ? `No ${ACTION_WORD[action]} by that player in the last ${minutes} minutes; the latest was by ${action === 'giveaway' && sameAction.type === 'tackle' ? sameAction.target : sameAction.player} (${sameAction.id}).`
    : `No matching ${ACTION_WORD[action]} in the last ${minutes} minutes of play.`;
  return contradicted(false, sameAction ? [sameAction.id] : [], note);
}

/**
 * Every player a caption names must be backed by at least one statement that
 * passed the check. Catches a wrong name left behind in prose the extractor
 * did not turn into a claim (e.g. "Reyes sprints ... Marsh recorded 34.9 km/h").
 * Returns the verdict with an 'unverifiable' detail added per unbacked name.
 */
export function checkNamedPlayers(text, verdict, players) {
  const backed = new Set();
  for (const c of verdict.claims) {
    if (c.status !== 'supported') continue;
    const a = c.asserted;
    if (typeof a === 'string') backed.add(a);
    if (a && typeof a === 'object') for (const k of ['player', 'on', 'off']) if (a[k]) backed.add(a[k]);
    for (const k of ['actor', 'other']) if (c.params?.[k]) backed.add(c.params[k]);
  }
  const escape = w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const extra = [];
  for (const p of players) {
    const said = new RegExp(`(^|[^\\p{L}])${escape(p.short_name)}(?![\\p{L}])`, 'u').test(text);
    if (!said || backed.has(p.id)) continue;
    extra.push({
      id: `name-${extra.length + 1}`, kind: 'named_player', role: 'context', span: p.short_name,
      params: { player: p.id }, asserted: true, status: 'unverifiable', actual: null, evidence: [],
      note: `Names ${p.name}, but no checked statement about him holds.`,
    });
  }
  if (!extra.length) return verdict;
  return {
    ...verdict,
    status: verdict.status === 'VERIFY' ? 'QUALIFY' : verdict.status,
    claims: [...verdict.claims, ...extra],
  };
}

/**
 * Comparisons beyond this match ("the best strike of the season", "finest
 * save in league history") cannot be checked against match data. The
 * extractor normally reports them as opinions; this catches the ones it
 * misses (seen in a Foundry run: "could've been the best strike attempt of
 * the entire league season" aired unflagged). Words already inside a flagged
 * claim are not counted twice.
 */
const SWEEPING = /\b(?:(?:the|their|his|its|our|a)\s+(?:best|greatest|finest|worst|biggest|fiercest|most\s+\w+)\b[^.!?]{0,40}?\b(?:season|history|career|decade|ever|all[- ]time|league)|season[- ]best|all[- ]time|of all time|ever\s+(?:seen|made|witnessed|scored)|in\s+(?:a\s+)?decade|(?:league|club)(?:'s|’s)?\s+history|record[- ]breaking)\b/i;

export function checkSweepingClaims(text, verdict) {
  const m = SWEEPING.exec(text);
  if (!m) return verdict;
  const hit = m[0].toLowerCase();
  const covered = verdict.claims.some(c => c.status !== 'supported' && c.span && c.span.toLowerCase().includes(hit.split(/\s+/).slice(-1)[0]));
  if (covered) return verdict;
  return {
    ...verdict,
    status: verdict.status === 'VERIFY' ? 'QUALIFY' : verdict.status,
    claims: [...verdict.claims, {
      id: 'sweeping', kind: 'opinion', role: 'context', span: m[0], asserted: true,
      status: 'unverifiable', actual: null, evidence: [],
      note: 'A comparison beyond this match cannot be checked against the match data.',
    }],
  };
}

/**
 * The fact each kind of moment exists to report. A caption that drops it (an
 * editor rewrite that removes the scorer, or "Northbridge hit 12 km" for one
 * player's distance) is true but does not report the moment, so it is withheld
 * and the moment airs from the data instead.
 */
const KEY_FACT = {
  goal: { kinds: ['goal_scorer'], what: 'who scored' },
  chance: { kinds: ['shot_player'], what: 'who had the chance' },
  card: { kinds: ['card_player'], what: 'who was booked' },
  sub: { kinds: ['substitution'], what: 'who came on and off' },
  sprint: { kinds: ['top_speed'], what: 'the top speed and who reached it' },
  milestone: { kinds: ['distance'], what: 'the distance and who covered it' },
  press: { kinds: ['window_count'], what: 'how many times the ball was won back' },
  stat: { kinds: ['possession'], what: 'the possession figure' },
};

export function checkMomentCovered(type, verdict) {
  const key = KEY_FACT[type];
  if (!key) return verdict;
  const covered = verdict.claims.some(c => key.kinds.includes(c.kind) && c.role === 'core' && c.status === 'supported');
  const statedButWrong = verdict.claims.some(c => key.kinds.includes(c.kind) && c.role === 'core');
  if (covered || statedButWrong) return verdict; // a wrong key fact is already a core failure
  return {
    ...verdict,
    status: 'WITHHOLD',
    claims: [...verdict.claims, {
      id: 'moment', kind: 'moment_missing', role: 'core', span: null, asserted: true,
      status: 'contradicted', actual: null, evidence: [],
      note: `Does not report the moment: it never says ${key.what}.`,
    }],
  };
}
