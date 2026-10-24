import test from 'node:test';
import assert from 'node:assert/strict';
import { generateMatch } from '../sim/generateMatch.js';
import { buildTrace, overlayRecord } from './trace.js';
import { verifyCaption } from './verify.js';
import { renderCaption, LANGUAGES } from './render.js';

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
