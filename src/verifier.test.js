import test from 'node:test';
import assert from 'node:assert/strict';
import scenarios from './data/scenarios.json' with {type:'json'};
import {verifyScenario} from './verifier.js';

test('small sample is qualified',()=>{
  const result=verifyScenario(scenarios[0]);
  assert.equal(result.status,'QUALIFY');
  assert.equal(result.evidence.length,2);
});
test('high recoveries count is verified',()=>{
  const result=verifyScenario(scenarios[1]);
  assert.equal(result.status,'VERIFY');
  assert.deepEqual(result.evidence,['R-311','R-312','R-313']);
});
test('missing xG is withheld',()=>{
  const result=verifyScenario(scenarios[2]);
  assert.equal(result.status,'WITHHOLD');
});
test('incorrect recovery count is rejected',()=>{
  const bad=structuredClone(scenarios[1]);
  bad.claim.count=4;
  assert.equal(verifyScenario(bad).status,'WITHHOLD');
});
test('incorrect passing percentage is rejected',()=>{
  const bad=structuredClone(scenarios[0]);
  bad.claim.rate=80;
  assert.equal(verifyScenario(bad).status,'WITHHOLD');
});

test('real 1.5B response is qualified for unsupported causality',()=>{
  const result=verifyScenario(scenarios[3]);
  assert.equal(result.status,'QUALIFY');
  assert.equal(result.evidence.length,4);
  assert.match(result.reason, /causal attribution/i);
});
test('mismatched numbers in causal claim are withheld',()=>{
  const bad=structuredClone(scenarios[3]);
  bad.claim.home_count=4;
  assert.equal(verifyScenario(bad).status,'WITHHOLD');
});
