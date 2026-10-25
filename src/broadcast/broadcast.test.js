import test from 'node:test';
import assert from 'node:assert/strict';
import { generateMatch } from '../sim/generateMatch.js';
import { buildTrace, overlayRecord } from './trace.js';
import { verifyCaption } from './verify.js';
import { renderCaption, LANGUAGES } from './render.js';
import { spotMoments, indexPeople } from './narrator.js';
import { INSIGHT_TYPES, recapSpot, contextFacts, RECAPS } from './context.js';
import { simulateInsight, simulateRecap } from './analyst.js';
import { verifyStatement } from './statements.js';

const match = generateMatch({ seed: 'captionvar-demo-6' });
const trace = buildTrace(match, { seed: 'narrator-10' });

test('trace is deterministic for the same seeds', () => {
  const again = buildTrace(match, { seed: 'narrator-10' });
  assert.deepEqual(again.decisions.map(d => [d.id, d.verdict.status, d.planted_error?.kind]), trace.decisions.map(d => [d.id, d.verdict.status, d.planted_error?.kind]));
});

test('the VAR check never uses events from after the caption', () => {
  for (const d of trace.decisions) {
    for (const id of d.verdict.evidence) {
      const e = match.events.find(x => x.id === id);
      const stopsTriggerShot = (e.type === 'save' || e.type === 'block') && e.shot_id === d.trigger_event_id;
      assert.ok(e.seq <= d.seq || stopsTriggerShot, `${d.id} cites future event ${id}`);
    }
  }
});

test('verdicts depend only on the claims, not on the planted-error label', () => {
  for (const d of trace.decisions.filter(x => x.planted_error)) {
    const observed = match.events.filter(e => e.seq <= d.seq);
    const blind = verifyCaption({ ...d, planted_error: undefined }, observed);
    assert.equal(blind.status, d.verdict.status);
  }
});

test('across many matches every planted error is caught with no false alarms', () => {
  let planted = 0;
  for (let i = 0; i < 6; i += 1) {
    const m = generateMatch({ seed: `var-${i}` });
    for (const ns of ['n-a', 'n-b']) {
      const { summary } = buildTrace(m, { seed: ns });
      planted += summary.planted_errors;
      assert.equal(summary.caught, summary.planted_errors, `match var-${i}, narrator ${ns}`);
      assert.equal(summary.false_alarms, 0, `match var-${i}, narrator ${ns}`);
    }
  }
  assert.ok(planted > 100, `only ${planted} planted errors exercised`);
});

test('the demo window shows all three verdicts', () => {
  const window = trace.decisions.filter(d => d.period === 2 && d.t >= 72 * 60 && d.t <= 78 * 60);
  const statuses = new Set(window.map(d => d.verdict.status));
  assert.deepEqual([...statuses].sort(), ['QUALIFY', 'VERIFY', 'WITHHOLD']);
  const fakeGoal = window.find(d => d.planted_error?.kind === 'invented_goal');
  assert.equal(fakeGoal.verdict.status, 'WITHHOLD');
  const equaliser = window.find(d => d.type === 'goal');
  assert.equal(equaliser.verdict.status, 'VERIFY');
  assert.ok(equaliser.verdict.claims.find(c => c.id === 'cause').evidence.some(id => id.startsWith('PR-')));
});

test('a withheld caption airs the corrected fact in every language and view', () => {
  const fakeGoal = trace.decisions.find(d => d.planted_error?.kind === 'invented_goal');
  for (const { code } of LANGUAGES) {
    for (const persona of ['fan', 'analyst']) {
      const text = renderCaption(fakeGoal, fakeGoal.verdict, trace.people, { lang: code, persona });
      assert.ok(text.length > 10);
      assert.doesNotMatch(text, /undefined|NaN|null/);
      assert.doesNotMatch(text, /it's in|score!/i);
    }
  }
});

test('every caption renders cleanly in every language, view and allegiance', () => {
  for (const d of trace.decisions) {
    for (const { code } of LANGUAGES) {
      for (const persona of ['fan', 'analyst']) {
        for (const follow of ['neutral', 'home', 'away']) {
          const text = renderCaption(d, d.verdict, trace.people, { lang: code, persona, follow });
          assert.ok(text.trim().length > 5, `${d.id} ${code} ${persona}`);
          assert.doesNotMatch(text, /undefined|NaN|\[object/, `${d.id} ${code} ${persona}: ${text}`);
        }
      }
    }
  }
});

test('a trimmed caption drops exactly the failed detail', () => {
  const trimmed = trace.decisions.find(d => d.verdict.status === 'QUALIFY' && d.planted_error?.kind === 'unverifiable_superlative');
  const text = renderCaption(trimmed, trimmed.verdict, trace.people, { lang: 'en', persona: 'fan' });
  assert.doesNotMatch(text, /season/);
  assert.match(text, /\d+ times/);
});

test('overlay records are machine-readable and carry their evidence', () => {
  const d = trace.decisions.find(x => x.type === 'goal');
  const rec = overlayRecord(d, trace.people, { lang: 'de', persona: 'analyst', follow: 'home' });
  assert.equal(rec.template, 'lower_third.goal');
  assert.equal(rec.language, 'de');
  assert.ok(rec.evidence_event_ids.length > 0);
  assert.equal(typeof rec.air_at_t, 'number');
  JSON.parse(JSON.stringify(rec));
});

test('claims in the extractor format verify exactly like the structured ones', async () => {
  const { spotMoments, observedFor } = await import('./narrator.js');
  const { toVerifiableClaims } = await import('./extracted.js');
  const spots = spotMoments(match);
  const toExtracted = c => {
    const kindFor = { scorer: 'goal_scorer', assist: 'goal_assist', score: 'score', cause: 'goal_from_press', tally: 'scorer_tally', shooter: 'shot_player', outcome: 'shot_outcome', xg: 'shot_xg', booked: 'card_player', change: 'substitution', speed: 'top_speed', distance: 'distance', count: 'final_third_recoveries', pressed: 'recoveries_after_press', possession: 'possession', accuracy: 'pass_accuracy', opinion: 'opinion' };
    if (c.kind === 'recent_action') return { kind: 'recent_action', span: c.id, action: c.params.action, player_id: c.params.actor };
    const a = c.asserted;
    const x = { kind: kindFor[c.id], span: c.id };
    if (typeof a === 'string') { if (c.id === 'outcome') x.outcome = a; else x.player_id = a; }
    if (typeof a === 'number') x.number = a;
    if (a && typeof a === 'object') Object.assign(x, 'home' in a ? { home: a.home, away: a.away } : {}, 'on' in a ? { player_id: a.on, other_player_id: a.off } : {}, 'kmh' in a ? { player_id: a.player, number: a.kmh } : {}, 'km' in a ? { player_id: a.player, number: a.km } : {}, 'pct' in a ? { side: a.side, number: a.pct } : {});
    if (c.params?.side) x.side = c.params.side;
    return x;
  };
  trace.decisions.forEach((d, i) => {
    const claims = toVerifiableClaims(spots[i], d.claims.map(toExtracted));
    const v = verifyCaption({ ...d, claims }, observedFor(match, spots[i].trigger));
    assert.equal(v.status, d.verdict.status, `${d.id} ${d.type}`);
  });
});

test('build-up actions are checked against the last two minutes of play', async () => {
  const { spotMoments } = await import('./narrator.js');
  const { toVerifiableClaims, RECENT_WINDOW_S } = await import('./extracted.js');
  const spots = spotMoments(match);
  const check = (spot, extracted) => {
    const claims = toVerifiableClaims(spot, extracted);
    return verifyCaption({ ...trace.decisions[spots.indexOf(spot)], claims }, match.events.filter(e => e.seq <= spot.trigger.seq)).claims[0];
  };
  // The scripted equaliser: pressure -> tackle -> recovery -> ... -> goal.
  const goalSpot = spots.find(s => s.moment.type === 'goal' && s.trigger.id === trace.decisions.find(d => d.type === 'goal' && d.facts?.cause)?.trigger_event_id);
  const chain = match.events.filter(e => e.seq < goalSpot.trigger.seq && e.period === goalSpot.trigger.period && e.t >= goalSpot.trigger.t - RECENT_WINDOW_S);
  const press = chain.filter(e => e.type === 'pressure' && e.side === goalSpot.moment.side).at(-1);

  const ok = check(goalSpot, [{ kind: 'recent_action', span: 'x', action: 'pressure', player_id: press.player_id }]);
  assert.equal(ok.status, 'supported');
  assert.ok(ok.evidence.includes(press.id));
  assert.equal(ok.role, 'context');

  const someoneElse = match.squads[goalSpot.moment.side].players.find(p => p.id !== press.player_id && !chain.some(e => e.type === 'pressure' && e.player_id === p.id));
  const wrong = check(goalSpot, [{ kind: 'recent_action', span: 'x', action: 'pressure', player_id: someoneElse.id }]);
  assert.equal(wrong.status, 'contradicted');
  assert.match(wrong.note, /latest was by/);

  const team = check(goalSpot, [{ kind: 'recent_action', span: 'x', action: 'pressure', side: goalSpot.moment.side }]);
  assert.equal(team.status, 'supported');

  const noFoul = chain.some(e => e.type === 'foul') ? null : check(goalSpot, [{ kind: 'recent_action', span: 'x', action: 'foul', side: 'away' }]);
  if (noFoul) assert.equal(noFoul.status, 'contradicted');

  const bogus = check(goalSpot, [{ kind: 'recent_action', span: 'x', action: 'dance' }]);
  assert.equal(bogus.kind, 'other_fact');
});

test('a build-up action that happens only after the moment is not accepted', async () => {
  const { spotMoments } = await import('./narrator.js');
  const { toVerifiableClaims } = await import('./extracted.js');
  const spot = spotMoments(match)[5];
  const later = match.events.find(e => e.seq > spot.trigger.seq && e.type === 'foul');
  const claims = toVerifiableClaims(spot, [{ kind: 'recent_action', span: 'x', action: 'foul', player_id: later.player_id, other_player_id: later.fouled_id }]);
  const v = verifyCaption({ ...trace.decisions[5], claims }, match.events.filter(e => e.seq <= spot.trigger.seq));
  assert.notEqual(v.claims[0].status, 'supported');
});

test('narrator packets only describe the checkable build-up window', async () => {
  const { spotMoments } = await import('./narrator.js');
  const { narratorPacket } = await import('./packets.js');
  const spots = spotMoments(match);
  const halfTime = spots.findIndex(s => s.trigger.type === 'period_end');
  const packet = narratorPacket(match, spots[halfTime + 1], halfTime + 1);
  for (const line of packet.recent_play) assert.doesNotMatch(line, /undefined/);
  const foulLine = spots.map((s, i) => narratorPacket(match, s, i)).flatMap(p => p.recent_play).find(l => / fouls /.test(l));
  if (foulLine) assert.doesNotMatch(foulLine, /an opponent$/);
});


test('new build-up actions: runs, giveaways, and shots linked to the block that stopped them', async () => {
  const { spotMoments } = await import('./narrator.js');
  const { toVerifiableClaims } = await import('./extracted.js');
  const { observedFor } = await import('./narrator.js');
  const spots = spotMoments(match);
  const verifyAt = (spot, extracted) => verifyCaption(
    { ...trace.decisions[spots.indexOf(spot)], claims: toVerifiableClaims(spot, extracted) },
    observedFor(match, spot.trigger),
  ).claims;
  const windowOf = spot => match.events.filter(e => e.seq <= spot.trigger.seq && e.period === spot.trigger.period && e.t >= spot.trigger.t - 120);

  // A blocked shot inside some moment's window: "X's shot is blocked by Y" and "X's chance is blocked".
  const spot = spots.find(s => windowOf(s).some(e => e.type === 'block' && windowOf(s).some(x => x.id === e.shot_id)));
  const block = windowOf(spot).find(e => e.type === 'block' && windowOf(spot).some(x => x.id === e.shot_id));
  const shot = match.events.find(e => e.id === block.shot_id);
  const [byBlocker, byShooter, shotByOther] = verifyAt(spot, [
    { kind: 'recent_action', span: 'a', action: 'shot', player_id: shot.player_id, other_player_id: block.player_id },
    { kind: 'recent_action', span: 'b', action: 'block', player_id: shot.player_id },
    { kind: 'recent_action', span: 'c', action: 'block', player_id: block.player_id, other_player_id: shot.player_id },
  ]);
  assert.equal(byBlocker.status, 'supported');
  assert.equal(byShooter.status, 'supported');
  assert.equal(shotByOther.status, 'supported');

  // A run with the ball, and a giveaway.
  const carrySpot = spots.find(s => windowOf(s).some(e => e.type === 'carry'));
  const carry = windowOf(carrySpot).filter(e => e.type === 'carry').at(-1);
  const giveawaySpot = spots.find(s => windowOf(s).some(e => e.type === 'pass' && !e.successful));
  const lost = windowOf(giveawaySpot).filter(e => e.type === 'pass' && !e.successful).at(-1);
  assert.equal(verifyAt(carrySpot, [{ kind: 'recent_action', span: 'x', action: 'carry', player_id: carry.player_id }])[0].status, 'supported');
  assert.equal(verifyAt(giveawaySpot, [{ kind: 'recent_action', span: 'x', action: 'giveaway', player_id: lost.player_id }])[0].status, 'supported');
});

test('a distance mislabelled as a speed is still checked as a distance', async () => {
  const { spotMoments } = await import('./narrator.js');
  const { toVerifiableClaims } = await import('./extracted.js');
  const spot = spotMoments(match).find(s => s.moment.type === 'milestone');
  const [claim] = toVerifiableClaims(spot, [{ kind: 'top_speed', span: 'x', player_id: spot.trigger.player_id, number: spot.trigger.milestone_km }]);
  assert.equal(claim.kind, 'distance');
  assert.equal(claim.role, 'core');
});

test('the save or block of the captioned shot is visible to the check, later events are not', async () => {
  const { spotMoments, observedFor } = await import('./narrator.js');
  const chance = spotMoments(match).find(s => s.moment.type === 'chance' && ['saved', 'blocked'].includes(s.trigger.outcome));
  const seen = observedFor(match, chance.trigger);
  const after = seen.filter(e => e.seq > chance.trigger.seq);
  assert.ok(after.length >= 1);
  assert.ok(after.every(e => e.shot_id === chance.trigger.id));
});


test('every named player must be backed by a checked statement', async () => {
  const { checkNamedPlayers } = await import('./verify.js');
  const players = [...trace.people.players.values()];
  const reyes = players.find(p => p.short_name === 'Reyes');
  const marsh = players.find(p => p.short_name === 'Marsh');
  const verdict = { status: 'VERIFY', claims: [{ id: 'speed', status: 'supported', asserted: { player: marsh.id, kmh: 34.9 } }] };
  // The real leak seen in a Foundry run: the wrong name survived in prose the extractor skipped.
  const leaked = checkNamedPlayers('Callum Reyes sprints after the tackle. Aiden Marsh recorded a top speed of 34.9 km/h.', verdict, players);
  assert.equal(leaked.status, 'QUALIFY');
  assert.deepEqual(leaked.claims.filter(c => c.kind === 'named_player').map(c => c.params.player), [reyes.id]);
  // Backed names, and words that merely contain a surname, pass.
  assert.equal(checkNamedPlayers('Aiden Marsh recorded 34.9 km/h, Marshall says.', verdict, players).status, 'VERIFY');
  // A withheld verdict stays withheld.
  assert.equal(checkNamedPlayers('Reyes!', { ...verdict, status: 'WITHHOLD' }, players).status, 'WITHHOLD');
});

test('a shot, assist or booking mentioned outside its own moment is checked as build-up', async () => {
  const { spotMoments } = await import('./narrator.js');
  const { toVerifiableClaims } = await import('./extracted.js');
  const sub = spotMoments(match).find(s => s.moment.type === 'sub');
  const claims = toVerifiableClaims(sub, [
    { kind: 'shot_player', span: 'a', player_id: 'NBR-07' },
    { kind: 'goal_assist', span: 'b', player_id: 'NBR-08' },
    { kind: 'card_player', span: 'c', player_id: 'NBR-02' },
  ]);
  assert.deepEqual(claims.map(c => [c.kind, c.params.action]), [['recent_action', 'shot'], ['recent_action', 'pass'], ['recent_action', 'card']]);
  assert.ok(claims.every(c => c.role === 'context'));
});

test('"booked for a foul on X" links the booking to the foul before it', async () => {
  const { spotMoments, observedFor } = await import('./narrator.js');
  const { toVerifiableClaims } = await import('./extracted.js');
  const spots = spotMoments(match);
  // A booking followed within two minutes by another captioned moment (e.g. the substitution at 65').
  const nextSpot = c => spots.find(s => s.trigger.seq > c.seq && s.trigger.period === c.period && s.trigger.t - c.t <= 120);
  const card = match.events.find(e => e.type === 'card' && nextSpot(e));
  assert.ok(card, 'demo match has a booking followed by another captioned moment');
  const spot = nextSpot(card);
  const foul = match.events.filter(e => e.type === 'foul' && e.player_id === card.player_id && e.seq < card.seq).at(-1);
  const check = other => verifyCaption(
    { ...trace.decisions[spots.indexOf(spot)], claims: toVerifiableClaims(spot, [{ kind: 'card_player', span: 'x', player_id: card.player_id, other_player_id: other }]) },
    observedFor(match, spot.trigger),
  ).claims[0].status;
  assert.equal(check(foul.fouled_id), 'supported');
  const someoneElse = match.squads[foul.side === 'home' ? 'away' : 'home'].players.find(p => p.id !== foul.fouled_id).id;
  assert.equal(check(someoneElse), 'contradicted');
});

test('a stated percentage must be the actual value rounded down or up', async () => {
  const { spotMoments, observedFor } = await import('./narrator.js');
  const { toVerifiableClaims } = await import('./extracted.js');
  const { possessionShare } = await import('../sim/stats.js');
  const spots = spotMoments(match);
  const spot = spots.find(s => s.moment.type === 'stat');
  const seen = observedFor(match, spot.trigger);
  const share = possessionShare(seen).home;
  const check = pct => verifyCaption(
    { ...trace.decisions[spots.indexOf(spot)], claims: toVerifiableClaims(spot, [{ kind: 'possession', span: 'x', side: 'home', number: pct }]) },
    seen,
  ).claims[0].status;
  assert.equal(check(Math.floor(share)), 'supported');
  assert.equal(check(Math.ceil(share)), 'supported');
  // The miss seen in a Foundry run: actual 61.0%, caption said 62%.
  assert.equal(check(Math.ceil(share) + 1), 'contradicted');
  assert.equal(check(Math.floor(share) - 1), 'contradicted');
});

test('a caption that drops the fact its moment exists to report is withheld', async () => {
  const { checkMomentCovered } = await import('./verify.js');
  // "Pell's tackle ... Reyes races forward" for a sprint moment: true details, no top speed.
  const truthful = { status: 'VERIFY', claims: [{ id: 'a', kind: 'recent_action', role: 'context', status: 'supported' }] };
  const v = checkMomentCovered('sprint', truthful);
  assert.equal(v.status, 'WITHHOLD');
  assert.match(v.claims.at(-1).note, /top speed/);
  // With the key fact present, nothing changes; a wrong key fact is left to the core check.
  const withKey = { status: 'VERIFY', claims: [{ id: 's', kind: 'top_speed', role: 'core', status: 'supported' }] };
  assert.equal(checkMomentCovered('sprint', withKey), withKey);
  const wrongKey = { status: 'WITHHOLD', claims: [{ id: 's', kind: 'top_speed', role: 'core', status: 'contradicted' }] };
  assert.equal(checkMomentCovered('sprint', wrongKey).claims.length, 1);
});

test('a comparison beyond the match is flagged even when the extractor misses it', async () => {
  const { checkSweepingClaims } = await import('./verify.js');
  const clean = { status: 'VERIFY', claims: [] };
  const missed = "Strand’s off-target big chance could’ve been the best strike attempt of the entire league season, but it just drifts wide!";
  const v = checkSweepingClaims(missed, clean);
  assert.equal(v.status, 'QUALIFY');
  assert.equal(v.claims.at(-1).status, 'unverifiable');
  assert.equal(checkSweepingClaims("best possession stats seen in the entire league's history", clean).status, 'QUALIFY');
  // Ordinary broadcast language is left alone.
  for (const ok of ['Collymore sprints at 35.9 km/h, his best burst of the night.', 'Fresh legs coming on at 75 minutes.', 'A big chance, brilliantly saved!']) {
    assert.equal(checkSweepingClaims(ok, clean).status, 'VERIFY', ok);
  }
  // Already flagged by the extractor: not counted twice.
  const flagged = { status: 'QUALIFY', claims: [{ status: 'unverifiable', span: 'their finest opportunity all season' }] };
  assert.equal(checkSweepingClaims('Reyes off target, their finest opportunity all season.', flagged), flagged);
});

// ------------------------------------------------ context lines and recaps

const ctxMatch = generateMatch({ seed: 'captionvar-demo-6' });
const ctxPeople = indexPeople(ctxMatch);
const ctxSpots = spotMoments(ctxMatch);
const insightSpots = ctxSpots.filter(s => INSIGHT_TYPES.has(s.moment.type));

test('every true line of context passes and every planted one is stopped', () => {
  assert.ok(insightSpots.length >= 10);
  for (const spot of insightSpots) {
    const ok = simulateInsight(ctxMatch, spot);
    assert.equal(verifyStatement(ctxMatch, spot, ok.text, ok.extracted, ctxPeople).verdict.status, 'VERIFY', ok.text);
    const bad = simulateInsight(ctxMatch, spot, { plant: 'inflated_number' });
    assert.equal(verifyStatement(ctxMatch, spot, bad.text, bad.extracted, ctxPeople).verdict.status, 'WITHHOLD', bad.text);
  }
});

test('recap sentences are checked against the half they close, never later', () => {
  for (const which of RECAPS) {
    const spot = recapSpot(ctxMatch, which);
    for (const s of simulateRecap(ctxMatch, which).sentences) {
      assert.equal(verifyStatement(ctxMatch, spot, s.text, s.extracted, ctxPeople).verdict.status, 'VERIFY', s.text);
    }
    const planted = simulateRecap(ctxMatch, which, { plant: 'wrong_player' });
    const s = planted.sentences[planted.planted_sentence];
    assert.equal(verifyStatement(ctxMatch, spot, s.text, s.extracted, ctxPeople).verdict.status, 'WITHHOLD', s.text);
  }
  // A second-half goal is not part of the half-time recap.
  const late = ctxMatch.events.find(e => e.type === 'goal' && e.period === 2);
  const name = ctxPeople.name(late.scorer_id);
  const v = verifyStatement(ctxMatch, recapSpot(ctxMatch, 'HT'), `${name} scored.`, [{ kind: 'goal_event', span: `${name} scored`, player_id: late.scorer_id }], ctxPeople);
  assert.equal(v.verdict.status, 'WITHHOLD');
});

test('a line may interpret checked facts, but not stand on opinion alone or compare beyond the match', () => {
  const spot = insightSpots.find(s => s.moment.type === 'chance');
  const base = simulateInsight(ctxMatch, spot);
  const framing = { kind: 'opinion', span: 'so the chances keep coming' };
  const withFraming = verifyStatement(ctxMatch, spot, base.text, [...base.extracted, framing], ctxPeople);
  assert.equal(withFraming.verdict.status, 'VERIFY');
  assert.ok(withFraming.verdict.claims.some(c => c.framing));
  const alone = verifyStatement(ctxMatch, spot, 'The chances keep coming.', [{ kind: 'opinion', span: 'The chances keep coming' }], ctxPeople);
  assert.equal(alone.verdict.status, 'WITHHOLD');
  const sweeping = verifyStatement(ctxMatch, spot, `${base.text} Their best spell of the season.`, base.extracted, ctxPeople);
  assert.notEqual(sweeping.verdict.status, 'VERIFY');
});

test('minutes since the previous shot on target is measured on the match clock', () => {
  const spot = insightSpots.find(s => s.moment.type === 'chance' && contextFacts(ctxMatch, s).teams[ctxPeople.teams[s.moment.side].name].minutes_since_previous_shot_on_target != null);
  const mins = contextFacts(ctxMatch, spot).teams[ctxPeople.teams[spot.moment.side].name].minutes_since_previous_shot_on_target;
  const claim = n => [{ kind: 'minutes_since', span: `first shot on target in ${n} minutes`, side: spot.moment.side, metric: 'shot_on_target', number: n }];
  const text = n => `Their first shot on target in ${n} minutes.`;
  assert.equal(verifyStatement(ctxMatch, spot, text(Math.round(mins)), claim(Math.round(mins)), ctxPeople).verdict.status, 'VERIFY');
  assert.equal(verifyStatement(ctxMatch, spot, text(Math.round(mins) + 5), claim(Math.round(mins) + 5), ctxPeople).verdict.status, 'WITHHOLD');
});

test('found in a Foundry run: a comparison beyond the match is never framing, and recap assists belong to their goal', () => {
  const spot = insightSpots.find(s => s.moment.type === 'press');
  const base = simulateInsight(ctxMatch, spot);
  const text = `${base.text} A pressing intensity rarely seen this season.`;
  const v = verifyStatement(ctxMatch, spot, text, [...base.extracted, { kind: 'opinion', span: 'A pressing intensity rarely seen this season' }], ctxPeople);
  assert.notEqual(v.verdict.status, 'VERIFY');

  // "possession in the last 10 minutes" is checked against the window even if the extractor says possession.
  const recent = contextFacts(ctxMatch, spot).possession_pct_last_10_min[ctxPeople.teams[spot.moment.side].name];
  const pct = Math.round(recent);
  const r = verifyStatement(ctxMatch, spot, `${pct}% possession in the last 10 minutes.`, [{ kind: 'possession', span: `${pct}% possession in the last 10 minutes`, side: spot.moment.side, number: pct }], ctxPeople);
  assert.equal(r.verdict.status, 'VERIFY');

  const goal = ctxMatch.events.find(e => e.type === 'goal' && e.assist_id);
  const other = ctxMatch.events.find(e => e.type === 'goal' && e.assist_id && e.assist_id !== goal.assist_id && e.id !== goal.id);
  const n = id => ctxPeople.name(id);
  const sentence = assist => [`${n(goal.scorer_id)} scored, assisted by ${n(assist)}.`, [
    { kind: 'goal_scorer', span: `${n(goal.scorer_id)} scored`, player_id: goal.scorer_id },
    { kind: 'goal_assist', span: `assisted by ${n(assist)}`, player_id: assist },
  ]];
  const ft = recapSpot(ctxMatch, 'FT');
  assert.equal(verifyStatement(ctxMatch, ft, ...sentence(goal.assist_id), ctxPeople).verdict.status, 'VERIFY');
  if (other) assert.equal(verifyStatement(ctxMatch, ft, ...sentence(other.assist_id), ctxPeople).verdict.status, 'WITHHOLD');
});
