import test from 'node:test';
import assert from 'node:assert/strict';
import scenarios from './data/scenarios.json' with {type:'json'};
import {verifyCaption} from './verifyCaption.js';
import {auditMixedClaims} from './claimAudit.js';
import {eventById, replayWindow, visibleEvents} from './replay.js';

const showcase = scenarios.find(s=>s.id==='hidden-hat-trick');

test('the fifth scenario exists and is clearly labeled as curated, not model-generated',()=>{
 assert.ok(showcase);
 assert.equal(scenarios.length,5);
 assert.equal(showcase.origin,'curated_multiclaim_seed');
 assert.equal(showcase.showcase,'mixed_claims');
 assert.equal(scenarios.filter(s=>s.id==='hidden-hat-trick').length,1);
});
test('the original compound caption is withheld by the unchanged v0.7 verifier',()=>{
 const result=verifyCaption(showcase,showcase.claim_text);
 assert.equal(result.status,'WITHHOLD');
 assert.match(result.reason,/goal/i);
});
test('the narrow audit separately verifies the recovery subclaim with actual IDs',()=>{
 const [recovery,goal]=auditMixedClaims(showcase,showcase.claim_text);
 assert.equal(recovery.supported,true);
 assert.deepEqual(recovery.evidence,['R-711','R-712','R-713']);
 for(const id of recovery.evidence) assert.equal(eventById(showcase,id).type,'recovery');
 assert.equal(goal.supported,false);
 assert.equal(goal.evidence.length,0);
});
test('changing the stated count or team never approves recovery subclaim',()=>{
 for(const caption of [
  'Northbridge regained possession four times and scored a hat trick.',
  'Riverside regained possession three times and scored a hat trick.',
  'Northbridge regained the ball a few times and scored a hat trick.'
 ]){
  assert.equal(auditMixedClaims(showcase,caption)[0].supported,false,caption);
 }
});
test('hat-trick audit needs three confirmed goals attributed to the same player',()=>{
 const oneGoal={id:'G-901',type:'goal',minute:76,second:19,team:showcase.team,scorer_id:'P9',confirmed:true,x:89,y:42};
 const one={...showcase,events:[...showcase.events,oneGoal]};
 assert.equal(auditMixedClaims(one,showcase.claim_text)[1].supported,false);
 const three={...showcase,events:[...showcase.events,oneGoal,
  {...oneGoal,id:'G-902',minute:76,second:20},
  {...oneGoal,id:'G-903',minute:76,second:21}]};
 const audited=auditMixedClaims(three,showcase.claim_text)[1];
 assert.equal(audited.supported,true);
 assert.deepEqual(audited.evidence,['G-901','G-902','G-903']);
});
test('the separate audit cannot promote a goal claim based on a recovery',()=>{
 assert.equal(auditMixedClaims(showcase,'Northbridge regained possession three times and scored a hat trick.')[1].supported,false);
});
test('the synthetic replay includes no future or goal events',()=>{
 const {start,end}=replayWindow(showcase);
 assert.equal(end-start,90);
 assert.equal(visibleEvents(showcase,end).length,3);
 assert.equal(visibleEvents(showcase,start).length,0);
 assert.equal(showcase.events.some(e=>e.type==='goal'),false);
});
test('other scenes have no claim-by-claim showcase audit',()=>{
 assert.deepEqual(auditMixedClaims(scenarios[0],scenarios[0].claim_text),[]);
});
