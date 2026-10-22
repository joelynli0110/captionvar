import test from 'node:test';
import assert from 'node:assert/strict';
import scenarios from './data/scenarios.json' with {type:'json'};
import {verifyCaption} from './verifyCaption.js';

test('garbled local caption is blocked',()=>{
  const r=verifyCaption(scenarios[0],'North Northbridgebridge FC recover recover the ball at the attacking third during the 90 seconds of the match.');
  assert.equal(r.status,'WITHHOLD');
});
test('rolling window described as final 90 seconds is qualified',()=>{
  const r=verifyCaption(scenarios[1],'Northbridge FC recovered the ball three times in the final 90 seconds of the match.');
  assert.equal(r.status,'QUALIFY');
  assert.deepEqual(r.evidence,['R-311','R-312','R-313']);
});
test('fabricated goal detected in model output',()=>{
  const r=verifyCaption(scenarios[2],'Northbridge FC scored their first goal at 83:11 during the 90-minute match against Riverside United.');
  assert.equal(r.status,'WITHHOLD');
  assert.match(r.reason,/no goal event/i);
});
test('manual recorded causal claim qualified',()=>{
  const r=verifyCaption(scenarios[3],scenarios[3].claim_text);
  assert.equal(r.status,'QUALIFY');
  assert.equal(r.evidence.length,4);
});
test('clean supported recovery count verified',()=>{
  const r=verifyCaption(scenarios[1],'Northbridge FC recovered the ball three times in the attacking third in the last 90 seconds.');
  assert.equal(r.status,'VERIFY');
});
test('wrong recovery total blocked',()=>{
  const r=verifyCaption(scenarios[1],'Northbridge FC recovered the ball four times in the attacking third in the last 90 seconds.');
  assert.equal(r.status,'WITHHOLD');
});
test('unknown assertion fails closed',()=>{
  const r=verifyCaption(scenarios[0],'The captain initiated a brilliant tactical maneuver.');
  assert.equal(r.status,'WITHHOLD');
});
