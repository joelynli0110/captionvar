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

const TOLERANCE = { pct: 1.5, kmh: 0.2, xg: 0.015 };

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
      return Math.abs(share[a.side] - a.pct) <= TOLERANCE.pct
        ? supported(actual, [], `On-ball share ${share[a.side]}%.`)
        : contradicted({ side: share.home >= share.away ? 'home' : 'away', pct: Math.round(Math.max(share.home, share.away)) }, [], `${a.side === 'home' ? 'Home' : 'Away'} share is ${share[a.side]}%.`);
    }

    case 'pass_accuracy': {
      const seen = observed.filter(e => e.seq <= claim.params.until_seq);
      const acc = teamStats(seen, a.side).pass_accuracy;
      return Math.abs(acc - a.pct) <= TOLERANCE.pct
        ? supported({ side: a.side, pct: Math.round(acc) }, [], `Pass accuracy ${acc}%.`)
        : contradicted({ side: a.side, pct: Math.round(acc) }, [], `Pass accuracy is ${acc}%.`);
    }

    case 'opinion':
      return unverifiable('A judgement or comparison beyond this match cannot be checked against the match data.');

    case 'other_fact':
      return unverifiable(`No rule can check this statement against the match data${claim.note_hint ? ` (it ${claim.note_hint})` : ''}.`);

    default:
      return unverifiable('No rule exists to check this kind of claim.');
  }
}
