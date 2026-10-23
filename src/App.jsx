import React,{useEffect,useMemo,useState} from 'react';
import scenarios from './data/scenarios.json';
import drafts from './data/model_drafts.json';
import {verifyScenario} from './verifier.js';
import {verifyCaption} from './verifyCaption.js';
import {auditMixedClaims} from './claimAudit.js';
import {eventTime,scenarioTime,sortedEvents,visibleEvents,replayWindow,eventById,eventPosition,evidenceGroups,timeLabel} from './replay.js';

const colors={VERIFY:'#4ee7a7', QUALIFY:'#f8c966',WITHHOLD:'#f67878'};
const eventColors={pass:'#9cecae',recovery:'#80e9ff',shot:'#ffca70',goal:'#ff8686'};

function FootballPitch({events,selectedId,onSelect}){
 return <svg viewBox="0 0 540 290" role="img" aria-label="Synthetic pitch, with actual event positions and selectable markers" className="pitch">
  <rect x="6" y="6" width="528" height="278" rx="14" fill="#0c3935"/>
  <rect x="27" y="24" width="486" height="241" fill="none" stroke="#75ab9e" strokeWidth="1.4"/>
  <path d="M270 24V265" stroke="#75ab9e" strokeWidth="1.4"/>
  <circle cx="270" cy="145" r="44" stroke="#75ab9e" fill="none" strokeWidth="1.4"/>
  <rect x="27" y="87" width="80" height="116" stroke="#75ab9e" fill="none"/>
  <rect x="433" y="87" width="80" height="116" stroke="#75ab9e" fill="none"/>
  <text x="35" y="47" fill="#b6d0c7" fontSize="11" letterSpacing="2">SYNTHETIC EVENT LOCATIONS</text>
  <text x="452" y="251" fill="#b6d0c7" fontSize="11">REPLAY</text>
  {events.map(e=>{const p=eventPosition(e);if(!p)return null;const selected=selectedId===e.id;return <g key={e.id} role="button" tabIndex="0" aria-label={`${e.id}, ${e.type}, ${timeLabel(eventTime(e))}`} onClick={()=>onSelect(e.id)} onKeyDown={ev=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();onSelect(e.id)}}} style={{cursor:'pointer'}}>
   {selected&&<circle cx={p.x} cy={p.y} r="16" fill="none" stroke="#fff7cc" strokeWidth="2"/>}
   <circle cx={p.x} cy={p.y} r="8" fill={eventColors[e.type]||'#ddd'} stroke="#10413e" strokeWidth="2"/>
   <text x={p.x+11} y={p.y-10} fill="#e8fff5" fontSize="10" fontWeight="700">{e.id}</text>
   <title>{`${e.id}: ${e.team}, ${e.type}, ${timeLabel(eventTime(e))}`}</title>
  </g>})}
 </svg>;
}

function ClaimAudit({claims,onInspect}) {
 if (!claims.length) return null;
 return <div className="claim-audit" aria-label="Claim-by-claim evidence audit">
   <div className="claim-audit-heading"><span>CLAIM-BY-CLAIM AUDIT</span><small>Curated adversarial example · limited grammar</small></div>
   {claims.map(claim=><div className="audit-row" key={claim.key}>
     <div className="audit-row-head"><strong>{claim.label}</strong><span className={claim.supported?'audit-supported':'audit-unsupported'}>{claim.supported?'✓ SUPPORTED':'× NOT SUPPORTED'}</span></div>
     <p>{claim.detail}</p>
     {claim.evidence.length>0&&<div className="audit-events">{claim.evidence.map(id=><button key={id} className="evidence-button" onClick={()=>onInspect(id)}>{id} ↗</button>)}</div>}
   </div>)}
   <p className="audit-note">The original caption remains WITHHELD. A supported subclaim never authorizes its unsupported companion.</p>
 </div>;
}

function EventInspector({event,scenario}){
 if(!event)return <div className="inspect-empty">Select a pitch marker, event row or evidence ID to inspect its source record.</div>;
 const fields=[['Timestamp',timeLabel(eventTime(event))],['Team',event.team],['Action',event.type],['Pitch location',`${event.x}%, ${event.y}%`]];
 if(event.zone)fields.push(['Zone',event.zone.replaceAll('_',' ')]);
 if(typeof event.successful==='boolean')fields.push(['Pass outcome',event.successful?'Completed':'Unsuccessful']);
 if(typeof event.on_target==='boolean')fields.push(['Shot on target',event.on_target?'Yes':'No']);
 return <div className="event-inspector"><div className="inspector-heading"><strong>{event.id} · {event.type.toUpperCase()}</strong><span>SYNTHETIC SOURCE</span></div><div className="detail-grid">{fields.map(([label,value])=><div key={label}><small>{label}</small><span>{value}</span></div>)}</div><div className="inspector-note">Only fields shown here are recorded; no pressing cause, xG or goal is inferred.</div></div>;
}

export default function App(){
 const [index,setIndex]=useState(0);
 const [audience,setAudience]=useState('fan');
 const [reviewed,setReviewed]=useState({});
 const [progressById,setProgressById]=useState({});
 const [selectedById,setSelectedById]=useState({});
 const [playing,setPlaying]=useState(false);
 const scenario=scenarios[index];
 const {start,end}=replayWindow(scenario);
 const progress=progressById[scenario.id]??end;
 const selectedId=selectedById[scenario.id]||null;
 const currentEvents=useMemo(()=>visibleEvents(scenario,progress),[scenario,progress]);
 const draft=drafts[scenario.id];
 const candidate=draft?.caption || scenario.claim_text;
 const checkGenerated=Boolean(draft || scenario.origin==='locally_generated_replayed_output' || scenario.origin==='curated_multiclaim_seed');
 const result=useMemo(()=>checkGenerated?verifyCaption(scenario,candidate):verifyScenario(scenario),[scenario,candidate,checkGenerated]);
 const groups=useMemo(()=>evidenceGroups(scenario,result),[scenario,result]);
 const claimAudit=useMemo(()=>scenario.showcase==='mixed_claims'?auditMixedClaims(scenario,candidate):[],[scenario,candidate]);
 const isReviewed=!!reviewed[scenario.id];
 const selectedEvent=selectedId?eventById(scenario,selectedId):null;
 useEffect(()=>{
  if(!playing)return;
  const timer=setInterval(()=>setProgressById(p=>({...p,[scenario.id]:Math.min(end,(p[scenario.id]??start)+3)})),200);
  return ()=>clearInterval(timer);
 },[playing,scenario.id,start,end]);
 useEffect(()=>{if(playing&&progress>=end)setPlaying(false)},[playing,progress,end]);
 const changeScenario=i=>{setPlaying(false);setIndex(i)};
 const inspect=id=>{
  const target=eventById(scenario,id);if(!target)return;
  setPlaying(false);setSelectedById(s=>({...s,[scenario.id]:id}));
  setProgressById(p=>({...p,[scenario.id]:Math.max(p[scenario.id]??end,eventTime(target))}));
 };
 const togglePlay=()=>{
  if(playing){setPlaying(false);return}
  if(progress>=end)setProgressById(p=>({...p,[scenario.id]:start}));
  setSelectedById(p=>({...p,[scenario.id]:null}));setPlaying(true);
 };
 return <div className="app">
  <header className="header"><div className="brand"><div className="brand-icon">CV<span>↗</span></div><div><div className="brand-name">Caption<span>VAR</span> <b>LIVE</b></div><div className="subbrand">THE AI REFEREE FOR FOOTBALL INTELLIGENCE</div></div></div><div className="topright"><span className="status-dot"/> SYNTHETIC REPLAY <span className="divider-v"/> MICROSOFT FOUNDRY LOCAL · OFFLINE DRAFTS</div></header>
  <main>
   <div className="hero"><div><div className="eyebrow">MATCH INTELLIGENCE / TRUST LAYER / V0.8</div><h1>Every AI insight deserves a <em>VAR check.</em></h1><p>Inspect an actual synthetic event on the pitch, replay the source timeline, and decide whether an AI-written claim deserves the screen.</p></div><div className="hero-stat"><div>{String(scenarios.length).padStart(2,'0')}</div><span>REVIEW SCENARIOS</span><small>No Azure account required</small></div></div>
   <div className="workbench"><section className="left"><div className="sectiontop"><span><i className="dot"/> EVENT REPLAY</span><strong>Northbridge FC <span>vs</span> Riverside United</strong></div>
    <FootballPitch events={currentEvents} selectedId={selectedId} onSelect={inspect}/>
    <div className="replay-controls"><button className="replay-button" onClick={togglePlay}>{playing?'Ⅱ PAUSE':'▶ PLAY REPLAY'}</button><span className="replay-clock">{timeLabel(progress)}</span><span className="replay-observations">{currentEvents.length}/{sortedEvents(scenario).length} observed</span></div>
    <div className="timeline"><span>{timeLabel(start)}</span><input aria-label="Replay time" type="range" min={start} max={end} value={progress} onChange={e=>{setPlaying(false);setProgressById(p=>({...p,[scenario.id]:Number(e.target.value)}))}}/><span>{timeLabel(end)}</span></div>
    <div className="match-meta">90-SECOND SYNTHETIC WINDOW · EVENT POSITION MARKERS ARE ILLUSTRATIVE</div>
    <div className="event-stream"><div className="stream-head">Events observed by this point <small>{currentEvents.length}</small></div>
      {currentEvents.length?currentEvents.map(e=><button key={e.id} className={'event-row '+(selectedId===e.id?'selected':'')} onClick={()=>inspect(e.id)}><span className="event-time">{timeLabel(eventTime(e))}</span><span className="event-title">{e.team} · {e.type.replaceAll('_',' ')}<small>{e.id}{e.zone?' · '+e.zone.replaceAll('_',' '):''}</small></span><span className="chev">↗</span></button>):<div className="inspect-empty">No events at this point in the replay. Press Play or scrub forward.</div>}
    </div>
    <EventInspector event={selectedEvent} scenario={scenario}/>
    <div className="scenario-title">Editorial scenarios</div><div className="scene-list">{scenarios.map((s,i)=><button className={'scene '+(i===index?'selected':'')} key={s.id} onClick={()=>changeScenario(i)}><span className="minute">{s.minute}'</span><span className="scene-copy"><strong>{s.title}</strong><small>{s.tag}</small></span><span className="chev">↗</span></button>)}</div></section>
    <section className="right"><div className="sectiontop"><span><i className="dot amber"/> EDITORIAL QUEUE</span><div className="refcode">CANDIDATE {String(index+1).padStart(2,'0')} / {String(scenarios.length).padStart(2,'0')}</div></div>
     <div className="candidate"><div className="candidate-label">UNVERIFIED CAPTION · {timeLabel(scenarioTime(scenario))}</div><blockquote>“{candidate}”</blockquote><div className="candidate-source">{draft?'SOURCE: FOUNDRY LOCAL · REAL GENERATED DRAFT · LIMITED TEXT GATE':scenario.origin==='locally_generated_replayed_output'?'SOURCE: OBSERVED QWEN2.5-1.5B OUTPUT · REPLAY · LIMITED TEXT GATE':scenario.origin==='curated_multiclaim_seed'?'SOURCE: CURATED ADVERSARIAL CAPTION · NO LLM CALL':'SOURCE: STRUCTURED SEED CLAIM · NO LLM CALL'}</div></div>
     <div className="action-line"><button className="primary" onClick={()=>setReviewed(v=>({...v,[scenario.id]:true}))}>{isReviewed?'RUN VAR AGAIN':'RUN VAR CHECK'} <span>→</span></button><span>{scenario.showcase==='mixed_claims'?'Narrow text gate checks a curated mixed-claim challenge':checkGenerated?'Narrow, fail-closed parser checks generated text':'Checks the scenario’s structured seed claim'}</span></div>
     {isReviewed?<div className="verdict"><div className="verdict-head"><div className="verdict-pill" style={{color:colors[result.status],borderColor:colors[result.status]}}>{result.status==='VERIFY'?'✓ VERIFIED':result.status==='QUALIFY'?'! QUALIFIED':'× WITHHELD'}</div><div className="evidence-count">{groups.supporting.length} SUPPORTING · {groups.related.length} RELATED</div></div>
      <p className="reason">{result.reason}</p>{scenario.showcase==='mixed_claims'&&<ClaimAudit claims={claimAudit} onInspect={inspect}/>}<div className="audience-picker"><span>BROADCAST MODE</span><div><button className={audience==='fan'?'active':''} onClick={()=>setAudience('fan')}>Casual fan</button><button className={audience==='analyst'?'active':''} onClick={()=>setAudience('analyst')}>Tactical analyst</button></div></div>
      <div className="output"><span>{result.status==='WITHHOLD'?'SAFE FALLBACK — NOT APPROVED':'APPROVED / QUALIFIED OUTPUT'}</span><p>“{result[audience]}”</p></div>
      <div className="evidence evidence-v05"><strong>SUPPORTING EVIDENCE</strong><div>{groups.supporting.length?groups.supporting.map(e=><button key={e.id} className="evidence-button" onClick={()=>inspect(e.id)}>{e.id} ↗</button>):<small>None for the rejected claim</small>}</div></div>
      {groups.related.length>0&&<div className="evidence evidence-v05"><strong>RELATED SOURCE EVENTS</strong><div>{groups.related.map(e=><button key={e.id} className="evidence-button related" onClick={()=>inspect(e.id)}>{e.id} ↗</button>)}</div></div>}
      <p className="evidence-explainer">Supporting IDs substantiate the permitted claim. Related events are observed data, not proof of rejected assertions. Click an ID to inspect it on the pitch.</p>
      </div>:<div className="awaiting"><span className="orbit">◎</span><strong>Awaiting verification</strong><p>Candidate claims don't reach viewers without checking their supporting events.</p></div>}
    </section></div>
    <footer><span>CaptionVAR Live · Hackathon prototype</span><span>Event replay is client-side and synthetic. Local-model captions are pre-generated; the fifth caption is a curated adversarial test, not a new model response. The text gate is narrow and not general-purpose fact checking.</span></footer>
  </main></div>;
}
