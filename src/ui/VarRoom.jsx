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
      <Attempts decision={decision} />
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

function SourceNote({ source, summary }) {
  const t = source.agentTrace;
  if (source.kind === 'agents' && t) {
    const own = summary.unprompted_errors;
    const unconfirmed = summary.unconfirmed_details;
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    return (
      <>
        <p className="vr-summary">
          {summary.planted_errors > 0 && <><b>{summary.caught} of {summary.planted_errors}</b> red-team errors caught. </>}
          {own > 0 && <>Also caught <b>{plural(own, 'mistake')}</b> the narrator made on its own. </>}
          {unconfirmed > 0 && <>Trimmed {plural(unconfirmed, 'caption')} where it added details the data cannot confirm. </>}
          {summary.captions} captions checked so far.
        </p>
        <p className="vr-note">
          {t.source === 'foundry-agents' ? `Written by agents on Microsoft Foundry (${t.model}).` : 'Agent workflow run offline with a scripted client, no model.'} A red team told the narrator to slip one error into some captions; the extractor and the VAR check are not told which.
          {t.usage?.estimated_cost_usd != null && ` Whole match: ${t.usage.llm_calls} model calls, about $${t.usage.estimated_cost_usd.toFixed(2)}.`}
        </p>
      </>
    );
  }
  return (
    <>
      <p className="vr-summary">
        {summary.planted_errors > 0
          ? <><b>{summary.caught} of {summary.planted_errors}</b> planted errors caught, {summary.false_alarms === 0 ? 'no false alarms' : `${summary.false_alarms} false alarms`}, {summary.captions} captions checked so far.</>
          : <>{summary.captions} captions checked so far.</>}
      </p>
      <p className="vr-note">A test narrator writes these captions and makes deliberate mistakes. The checks are real.</p>
    </>
  );
}

const AUTHOR = { narrator: 'Narrator', editor: 'Editor', template: 'Template from match data' };

function Attempts({ decision }) {
  if (!decision.attempts || decision.attempts.length < 2 && decision.aired?.by !== 'template') return null;
  return (
    <ol className="attempts" aria-label="How the aired caption was produced">
      {decision.attempts.map(a => (
        <li key={a.attempt}>
          <span className={`att-status tone-${VERDICT[a.status].tone}`}>{VERDICT[a.status].label}</span>
          <span className="att-who">{a.attempt === 0 ? 'Narrator' : `Editor rewrite ${a.attempt}`}</span>
          {a.attempt > 0 && <span className="att-text">{a.text}</span>}
        </li>
      ))}
      {decision.aired?.by === 'template' && (
        <li><span className="att-status tone-ok">Aired</span><span className="att-who">{AUTHOR.template}</span></li>
      )}
    </ol>
  );
}

export default function VarRoom({ decisions, selectedId, onSelect, summary, people, view, renderAired, onInspect, source }) {
  return (
    <section className="var-room" aria-label="VAR room">
      <header className="vr-head">
        <div className="vr-title">
          <h2>VAR room</h2>
          {source.agentTrace && (
            <div className="segmented small" role="radiogroup" aria-label="Who writes the captions">
              {[['agents', source.agentTrace.source === 'foundry-agents' ? 'Foundry agents' : 'Agent workflow'], ['test', 'Test narrator']].map(([v, label]) => (
                <button key={v} type="button" role="radio" aria-checked={source.kind === v} className={source.kind === v ? 'on' : ''} onClick={() => source.onChange(v)}>{label}</button>
              ))}
            </div>
          )}
        </div>
        <SourceNote source={source} summary={summary} />
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
