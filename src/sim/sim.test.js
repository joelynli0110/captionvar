import test from 'node:test';
import assert from 'node:assert/strict';
import { generateMatch } from './generateMatch.js';
import { validateMatch } from './validate.js';
import { teamStats, matchStats, playerStats } from './stats.js';
import { liveFeed, windowedFeed } from './stream.js';
import { expectedGoals } from './pitch.js';

const demo = generateMatch();

test('generation is deterministic for a seed and differs across seeds', () => {
  assert.equal(JSON.stringify(generateMatch()), JSON.stringify(demo));
  assert.notEqual(JSON.stringify(generateMatch({ seed: 'another' }).events), JSON.stringify(demo.events));
});

test('generated matches pass every structural invariant', () => {
  for (let i = 0; i < 25; i += 1) {
    const match = generateMatch({ seed: `invariants-${i}` });
    assert.deepEqual(validateMatch(match), [], `seed invariants-${i}`);
  }
});

test('a story-free match also validates', () => {
  const match = generateMatch({ seed: 'no-story', story: [] });
  assert.deepEqual(validateMatch(match), []);
  assert.equal(match.script.length, 0);
});

test('demo match delivers the scripted story', () => {
  assert.deepEqual(demo.meta.final_score, { home: 2, away: 1 });
  const goals = demo.script.filter(b => b.kind === 'goal');
  assert.equal(goals.length, 3);
  for (const beat of goals) {
    const goal = demo.events.find(e => e.id === beat.goal_event_id);
    assert.ok(goal, beat.label);
    assert.equal(goal.scorer_id, beat.scorer_id);
    assert.equal(goal.assist_id, beat.assist_id);
  }
});

test('the scripted pressing goal has a verifiable causal chain', () => {
  const beat = demo.script.find(b => b.via === 'press');
  const chain = beat.event_ids.map(id => demo.events.find(e => e.id === id));
  assert.equal(chain[0].type, 'pressure');
  assert.equal(chain[1].type, 'tackle');
  const recovery = chain[2];
  assert.equal(recovery.type, 'recovery');
  assert.equal(recovery.linked_pressure_id, chain[0].id);
  assert.equal(recovery.zone, 'attacking_third');
  assert.equal(chain.at(-1).type, 'goal');
  assert.ok(chain.every(e => !['physical_milestone', 'substitution'].includes(e.type)));
});

test('season-average totals stay in realistic football ranges', () => {
  const totals = { shots: 0, passes: 0, completed: 0, fouls: 0, tackles: 0, interceptions: 0 };
  const n = 12;
  for (let i = 0; i < n; i += 1) {
    const { events } = generateMatch({ seed: `realism-${i}` });
    for (const side of ['home', 'away']) {
      const s = teamStats(events, side);
      totals.shots += s.shots; totals.passes += s.passes; totals.completed += s.passes_completed;
      totals.fouls += s.fouls; totals.tackles += s.tackles; totals.interceptions += s.interceptions;
    }
  }
  const per = k => totals[k] / (2 * n);
  assert.ok(per('shots') > 9 && per('shots') < 18, `shots ${per('shots')}`);
  assert.ok(per('passes') > 380 && per('passes') < 650, `passes ${per('passes')}`);
  const acc = totals.completed / totals.passes;
  assert.ok(acc > 0.75 && acc < 0.9, `pass accuracy ${acc}`);
  assert.ok(per('fouls') > 6 && per('fouls') < 15, `fouls ${per('fouls')}`);
  assert.ok(per('tackles') > 10 && per('tackles') < 26, `tackles ${per('tackles')}`);
  assert.ok(per('interceptions') > 5 && per('interceptions') < 18, `interceptions ${per('interceptions')}`);
});

test('absolute coordinates follow the teams switching ends at half-time', () => {
  const shots = demo.events.filter(e => e.type === 'shot' && e.side === 'home');
  assert.ok(shots.filter(e => e.period === 1).every(e => e.x > 50));
  assert.ok(shots.filter(e => e.period === 2).every(e => e.x < 50));
});

test('xG model is monotonic in distance and sensible for penalties', () => {
  const close = expectedGoals({ ax: 94, ay: 50 });
  const edge = expectedGoals({ ax: 84, ay: 50 });
  const far = expectedGoals({ ax: 75, ay: 50 });
  assert.ok(close > edge && edge > far);
  assert.equal(expectedGoals({ ax: 89.5, ay: 50, situation: 'penalty' }), 0.76);
});

test('stats are traceable aggregates of the event stream', () => {
  const s = matchStats(demo.events);
  assert.deepEqual(s.score, demo.meta.final_score);
  assert.equal(s.possession.home + s.possession.away, 100);
  const scorer = demo.script.find(b => b.via === 'press').scorer_id;
  assert.ok(playerStats(demo.events, scorer).goals >= 1);
});

test('live feed replays every event in order; windows partition the stream', async () => {
  const seen = [];
  for await (const ev of liveFeed(demo, { speed: 0, toSeq: 400 })) seen.push(ev.seq);
  assert.equal(seen.length, 400);
  assert.ok(seen.every((s, i) => s === i + 1));

  let count = 0;
  for await (const w of windowedFeed(liveFeed(demo, { speed: 0 }), { windowSeconds: 60 })) {
    count += w.events.length;
    assert.ok(w.events.every(e => e.period === w.period));
  }
  assert.equal(count, demo.events.length);
});
