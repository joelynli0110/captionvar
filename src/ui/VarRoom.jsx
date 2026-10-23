import React, { useState } from 'react';
import { VERDICT } from './data.js';
import { overlayRecord } from '../broadcast/trace.js';

const STATUS_MARK = { supported: '✓', contradicted: '✕', unverifiable: '?' };
const STATUS_TEXT = { supported: 'Holds', contradicted: 'False', unverifiable: 'Cannot be checked' };

function CandidateText({ decision }) {
  const status = Object.fromEntries(decision.verdict.claims.map(c => [c.id, c.status]));
  return (
    <p className="candidate">
      {decision.segments.map((s, i) => (
        <span key={i} className={s.claim ? `seg seg-${status[s.claim]}` : 'seg'}>{s.text}</span>
      ))}
    </p>
  );
}

function Detail({ decision, people, view, onInspect }) {
  const [showData, setShowData] = useState(false);
  const record = overlayRecord(decision, people, view);
  return (
    <div className="detail">
      <ul className="claims">
        {decision.verdict.claims.map(c => (
          <li key={c.id} className={`claim claim-${c.status}`}>
            <span className="claim-mark" aria-hidden="true">{STATUS_MARK[c.status]}</span>
            <span className="claim-body">
              <strong>{STATUS_TEXT[c.status]}{c.role === 'core' ? '' : ', detail'}</strong> {c.note}
            </span>
          </li>
        ))}
      </ul>
      {decision.verdict.evidence.length > 0 && (
        <div className="evidence">
          <span>Evidence</span>
          {decision.verdict.evidence.map(id => (
            <button key={id} type="button" className="ev-id" onClick={() => onInspect(id)}>{id}</button>
          ))}
        </div>
      )}
      <button type="button" className="link" onClick={() => setShowData(v => !v)} aria-expanded={showData}>
        {showData ? 'Hide overlay data' : 'Show overlay data'}
      </button>
      {showData && <pre className="overlay-json">{JSON.stringify(record, null, 2)}</pre>}
    </div>
  );
}

export default function VarRoom({ decisions, selectedId, onSelect, summary, people, view, renderAired, onInspect }) {
  return (
    <section className="var-room" aria-label="VAR room">
      <header className="vr-head">
        <h2>VAR room</h2>
        <p className="vr-summary">
          {summary.planted_errors > 0
            ? <><b>{summary.caught} of {summary.planted_errors}</b> planted errors caught, {summary.false_alarms === 0 ? 'no false alarms' : `${summary.false_alarms} false alarms`}, {summary.captions} captions checked so far.</>
            : <>{summary.captions} captions checked so far.</>}
        </p>
        <p className="vr-note">In this build a test narrator writes the captions and makes deliberate mistakes. The checks are real.</p>
      </header>
      {decisions.length === 0 && <p className="vr-empty">Captions appear here as the narrator writes them. Press play.</p>}
      <ol className="vr-list">
        {decisions.map(d => {
          const v = VERDICT[d.verdict.status];
          const open = d.id === selectedId;
          return (
            <li key={d.id} className={`vr-item tone-${v.tone} ${open ? 'is-open' : ''}`}>
              <button type="button" className="vr-row" onClick={() => onSelect(open ? null : d.id)} aria-expanded={open}>
                <span className="vr-minute">{d.display_minute}</span>
                <span className="vr-verdict">{v.label}</span>
              </button>
              <CandidateText decision={d} />
              {d.verdict.status !== 'VERIFY' && (
                <p className="aired"><span>On air instead</span> {renderAired(d)}</p>
              )}
              {open && <Detail decision={d} people={people} view={view} onInspect={onInspect} />}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
