import test from 'node:test';
import assert from 'node:assert/strict';
import scenarios from './data/scenarios.json' with {type:'json'};
import {verifyCaption} from './verifyCaption.js';

const pressing = scenarios.find(s=>s.id==='pressing');
const causality = scenarios.find(s=>s.id==='unsupported-causality');
const missingXg = scenarios.find(s=>s.id==='missing-xg');

// Extra compound-claim regression probes; manually written, not a representative
// benchmark and not suitable for a generalized accuracy claim.
const probes = [
  ['recovery + invented hat trick',pressing,'Northbridge regained possession three times and went on to score a hat trick.','WITHHOLD'],
  ['recovery + fabricated injury',pressing,'Northbridge regained possession three times, and its star striker was injured.','QUALIFY'],
  ['recovery + unsupported corners',pressing,'Northbridge regained possession three times and earned five corners.','QUALIFY'],
  ['recovery + season-wide comparison',causality,'Northbridge recovered three times and was clearly the better side all season.','QUALIFY'],
  ['causality after measured recovery',pressing,'Three recoveries for Northbridge came from relentless pressing.','QUALIFY'],
  ['causality before measured recovery',causality,'Aggressive pressing caused Northbridge to win the ball three times.','QUALIFY'],
  ['two sentences mixed with unverified judgment',pressing,'Northbridge regained possession three times. The coach is a genius.','QUALIFY'],
  ['unrelated appended clause',pressing,'Northbridge regained possession three times and performed something unprecedented.','QUALIFY'],
  ['recovery + explicit fabricated goal',pressing,'Northbridge recovered three times and scored a late goal.','WITHHOLD'],
  ['wrong recovery count + unrelated clause',pressing,'Northbridge recovered four times and earned five corners.','WITHHOLD'],
  ['correct recovery count but wrong opponent total',causality,'Northbridge recovered three times compared to two for Riverside.','WITHHOLD'],
  ['supported short recovery caption',pressing,'Northbridge regained possession 3 times.','VERIFY'],
  ['xG without provenance',missingXg,'Riverside had a 0.82 expected-goals chance.','WITHHOLD'],
  ['unknown extra information marked for qualification',pressing,'Northbridge regained possession three times, with an astonishing comeback.','QUALIFY']
];

for (const [label,scene,caption,expected] of probes) {
  test(`multi-claim: ${label}`,()=>{
    const result=verifyCaption(scene,caption);
    assert.equal(result.status,expected,`Caption: ${caption}; Reason: ${result.reason}`);
    assert.ok(result.reason);
    if (result.status==='QUALIFY') {
      assert.ok(result.fan.includes('3 time'), 'Qualifying should publish only a deterministic, event-grounded rewrite');
      assert.ok(result.evidence.filter(id=>id.startsWith('R-')).length>=3, 'Safe rewrite should retain the supporting recovery records');
    }
  });
}

test('expected-goals is evaluated as xG rather than a scored goal',()=>{
 const result=verifyCaption(missingXg,'That shot had an expected-goals value of 0.82.');
 assert.equal(result.status,'WITHHOLD');
 assert.match(result.reason,/xG/i);
});
