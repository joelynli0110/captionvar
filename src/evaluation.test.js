import test from 'node:test';
import assert from 'node:assert/strict';
import cases from './data/evaluation_cases.json' with {type:'json'};
import scenarios from './data/scenarios.json' with {type:'json'};
import {verifyCaption} from './verifyCaption.js';
const byId = new Map(scenarios.map(s=>[s.id,s]));
test('evaluation fixture ids are unique and every case has an existing scenario',()=>{
  assert.equal(new Set(cases.map(c=>c.id)).size,cases.length);
  assert.ok(cases.length>=20);
  for (const c of cases){
    assert.ok(byId.has(c.scenarioId),c.id);
    assert.ok(['VERIFY','QUALIFY','WITHHOLD'].includes(c.expected),c.id);
    assert.ok(c.caption.length>10,c.id);
  }
});
test('evaluation harness has expected statuses for a clearly absent goal and a counted recovery',()=>{
  const goal = cases.find(c=>c.id==='E19');
  const recovery=cases.find(c=>c.id==='E08');
  assert.equal(verifyCaption(byId.get(goal.scenarioId),goal.caption).status,'WITHHOLD');
  assert.equal(verifyCaption(byId.get(recovery.scenarioId),recovery.caption).status,'VERIFY');
});
