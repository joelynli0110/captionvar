import React, { useState } from 'react';
import { VERDICT, firstDraft } from './data.js';
import { Draft } from './Broadcast.jsx';
import { overlayRecord } from '../broadcast/trace.js';

const STATUS_MARK = { supported: '✓', contradicted: '✕', unverifiable: '?' };
const STATUS_TEXT = { supported: 'Holds', contradicted: 'False', unverifiable: 'Cannot be checked' };

function Detail({ decision, people, view, aired, onInspect }) {
  const [showData, setShowData] = useState(false);
  const changed = decision.verdict.status !== 'VERIFY';
  return (
    <div className="detail">
      <p className="detail-label">{changed ? 'Narrator wrote' : 'On air'}</p>
      <Draft decision={decision} />
      {changed && <p className="aired"><span>On air instead</span>{aired}</p>}
      {decision.own_error && (
        <p className="own-note"><span className="vr-origin is-own">Narrator's own</span> {decision.planted_error ? 'Besides the planted error, the narrator got a detail wrong on its own.' : 'The narrator got this wrong on its own.'} Checked by hand against the events: {decision.own_error}</p>
      )}
      <Attempts decision={decision} />
      {decision.timing && (
        <p className="timing">
          On air {decision.timing.time_to_air_s.toFixed(1)} s after the moment · {decision.timing.model_calls} model call{decision.timing.model_calls === 1 ? '' : 's'} · referee {decision.timing.referee_ms.toFixed(0)} ms
        </p>
      )}
      <ul className="claims" aria-label="Claims checked">
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
      {showData && <pre className="overlay-json">{JSON.stringify(overlayRecord(decision, people, view), null, 2)}</pre>}
    </div>
  );
}

/** Which agent produced each draft and how the check judged it. */
function Attempts({ decision }) {
  const attempts = decision.attempts ?? [];
  if (attempts.length < 2 && decision.aired?.by !== 'template') return null;
  return (
    <ol className="attempts" aria-label="How the aired caption was produced">
      {attempts.map(a => (
        <li key={a.attempt} className={`tone-${VERDICT[a.status].tone}`}>
          <span className="att-who">{a.attempt === 0 ? 'Narrator' : `Editor ${a.attempt}`}</span>
          <span className="att-status">{VERDICT[a.status].label}</span>
        </li>
      ))}
      {decision.aired?.by === 'template' && (
        <li className="tone-ok"><span className="att-who">From the data</span><span className="att-status">Aired</span></li>
      )}
    </ol>
  );
}

/** One line per caption: what the check objected to, or what aired. */
function Gist({ decision, aired }) {
  if (decision.verdict.status === 'VERIFY') return <span className="vr-gist">{aired}</span>;
  const flag = firstDraft(decision).flags[0];
  if (!flag) return <span className="vr-gist">{aired}</span>;
  return (
    <span className="vr-gist">
      <span className={`seg seg-${flag.status}`}>{flag.span.replace(/^[\s,;:.!—–-]+/, '')}</span>
    </span>
  );
}

/**
 * Who made the error the check stopped: the red team planted it on purpose,
 * or the narrator made it unprompted. Without this, a list of struck-through
 * captions reads as a bad narrator rather than a working check.
 */
function Origin({ decision }) {
  return (
    <>
      {decision.planted_error && <span className="vr-origin is-planted" title="The red team planted this error on purpose to test the check">Planted</span>}
      {decision.own_error && <span className="vr-origin is-own" title="An error the narrator made unprompted, checked by hand against the events">Narrator's own</span>}
    </>
  );
}

/** Three numbers at most: VAR calls are counted on the tab when space is short. */
function Kpis({ summary, own }) {
  const calls = summary.qualified + summary.withheld;
  return (
    <dl className="kpis">
      {summary.planted_errors > 0 && (
        <div className="kpi-main">
          <dd>{summary.caught}<small>/{summary.planted_errors}</small></dd>
          <dt>planted errors caught</dt>
        </div>
      )}
      {own > 0 && <div className="kpi-own"><dd>{own}</dd><dt>of its own errors stopped</dt></div>}
      {!(own > 0) && <div><dd>{calls}</dd><dt>VAR calls</dt></div>}
      <div><dd>{summary.captions}</dd><dt>captions checked</dt></div>
    </dl>
  );
}

function sourceLine(source) {
  const t = source.kind === 'agents' ? source.agentTrace : null;
  if (!t) return 'Test narrator with deliberate mistakes. The checks are real.';
  if (t.source !== 'foundry-agents') return 'Agent workflow run offline, no model.';
  const cost = t.usage?.estimated_cost_usd;
  const air = t.summary?.time_to_air;
  return `Foundry agents · ${t.model}${cost != null ? ` · $${cost.toFixed(2)} for the whole match` : ''}${air ? ` · ${air.p50_s.toFixed(1)} s median to air` : ''}`;
}

export default function VarRoom({ decisions, liveId, selectedId, onSelect, summary, people, view, renderAired, onInspect, source, onExplain }) {
  const [filter, setFilter] = useState('calls');
  const calls = decisions.filter(d => d.verdict.status !== 'VERIFY');
  const shown = filter === 'calls' ? calls : decisions;
  return (
    <section className="var-room" aria-label="VAR room">
      <header className="vr-head">
        <div className="vr-title">
          <h2>VAR room</h2>
          <button type="button" className="link" onClick={onExplain}>How it works</button>
        </div>
        <Kpis summary={summary} own={decisions.filter(d => d.own_error && d.verdict.status !== 'VERIFY').length} />
        <p className="vr-source">{sourceLine(source)}</p>
        <div className="vr-tabs" role="tablist" aria-label="Captions to show">
          {[['calls', `VAR calls · ${calls.length}`], ['all', `All captions · ${decisions.length}`]].map(([value, label]) => (
            <button key={value} type="button" role="tab" aria-selected={filter === value} className={filter === value ? 'on' : ''} onClick={() => setFilter(value)}>{label}</button>
          ))}
        </div>
        {calls.some(d => d.planted_error) && (
          <p className="vr-legend">
            <span><span className="vr-origin is-planted">Planted</span> by the red team</span>
            {calls.some(d => d.own_error) && <span><span className="vr-origin is-own">Narrator's own</span> unprompted, checked by hand</span>}
          </p>
        )}
      </header>
      {shown.length === 0 && (
        <p className="vr-empty">{decisions.length === 0 ? 'Captions appear here as the narrator writes them.' : 'No VAR calls yet: every caption so far checked out.'}</p>
      )}
      <ol className="vr-list">
        {shown.map(d => {
          const v = VERDICT[d.verdict.status];
          const open = d.id === selectedId;
          const aired = renderAired(d);
          return (
            <li key={d.id} className={`vr-item tone-${v.tone}${open ? ' is-open' : ''}${d.id === liveId ? ' is-live' : ''}`}>
              <button type="button" className="vr-row" onClick={() => onSelect(open ? null : d.id)} aria-expanded={open}>
                <span className="vr-minute">{d.display_minute}</span>
                <span className="vr-verdict">
                  {v.label}
                  <Origin decision={d} />
                </span>
                <Gist decision={d} aired={aired} />
              </button>
              {open && <Detail decision={d} people={people} view={view} aired={aired} onInspect={onInspect} />}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
