import React, { useState } from 'react';
import { VERDICT, firstDraft } from './data.js';
import { Draft, LineDraft } from './Broadcast.jsx';
import { overlayRecord } from '../broadcast/trace.js';

const STATUS_MARK = { supported: '✓', contradicted: '✕', unverifiable: '?' };
const STATUS_TEXT = { supported: 'Holds', contradicted: 'False', unverifiable: 'Cannot be checked' };

function Detail({ decision, people, view, aired, onInspect }) {
  const [showData, setShowData] = useState(false);
  const changed = decision.verdict.status !== 'VERIFY';
  return (
    <div className="detail">
      <p className="detail-origin"><Origin decision={decision} /></p>
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
      {decision.insight && <InsightDetail line={decision.insight} />}
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

const AUTHOR = { narrator: 'Narrator', editor: 'Editor', analyst: 'Analyst', line_editor: 'Line editor', recap_writer: 'Recap writer' };

/** The Analyst's line on why the moment matters: what it wrote, how the check judged it, what aired. */
function InsightDetail({ line }) {
  const changed = line.verdict.status !== 'VERIFY';
  return (
    <section className="insight-detail" aria-label="Why it matters">
      <p className="detail-label">Why it matters{line.planted_error ? (line.planted_error.not_present ? ' · red team ignored: no error in the line' : ' · planted') : ''}</p>
      <LineDraft line={line} />
      {changed && (line.aired
        ? <p className="aired"><span>On air after one rewrite</span>{line.aired.text}</p>
        : <p className="aired is-cut"><span>Cut</span>Still failed after one rewrite, so no line aired.</p>)}
      <ul className="claims" aria-label="Claims in the line">
        {line.verdict.claims.map(c => (
          <li key={c.id} className={`claim claim-${c.framing ? 'framing' : c.status}`}>
            <span className="claim-mark" aria-hidden="true">{c.framing ? '~' : STATUS_MARK[c.status]}</span>
            <span className="claim-body"><strong>{c.framing ? 'Framing' : STATUS_TEXT[c.status]}</strong> {c.note}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Half-time and full-time recaps, sentence by sentence. */
function RecapList({ recaps }) {
  if (!recaps.length) return <p className="vr-empty">The half-time recap appears at the break.</p>;
  return (
    <div className="vr-recaps">
      {[...recaps].reverse().map(r => (
        <section key={r.id} className="vr-recap" aria-label={r.recap === 'HT' ? 'Half-time recap' : 'Full-time recap'}>
          <h3>{r.recap === 'HT' ? 'Half-time recap' : 'Full-time recap'} <span>{r.sentences.filter(x => x.aired).length}/{r.sentences.length} sentences aired</span></h3>
          <ol>
            {r.sentences.map((x, i) => (
              <li key={i} className={x.aired ? 'is-aired' : 'is-cut'}>
                {x.aired && x.attempts.length === 1 ? <p className="candidate">{x.aired.text}</p> : <LineDraft line={x} />}
                {x.aired && x.attempts.length > 1 && <p className="aired"><span>On air after one rewrite</span>{x.aired.text}</p>}
                {!x.aired && <p className="recap-why">Cut: {x.attempts[0].flags[0]?.note ?? 'did not pass the check'}</p>}
                {x.planted_error && <span className="vr-origin is-planted">Planted</span>}
              </li>
            ))}
          </ol>
        </section>
      ))}
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

const lineFlagged = d => Boolean(d.insight) && d.insight.verdict.status !== 'VERIFY';
const isCall = d => d.verdict.status !== 'VERIFY' || lineFlagged(d);

/** One line per caption: what the check objected to, or what aired. */
function Gist({ decision, aired }) {
  if (decision.verdict.status === 'VERIFY' && lineFlagged(decision)) {
    const flag = decision.insight.attempts[0].flags[0];
    if (flag?.span) return <span className="vr-gist"><span className={`seg seg-${flag.status}`}>{flag.span}</span></span>;
  }
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
      {(decision.planted_error || (decision.insight?.planted_error && !decision.insight.planted_error.not_present)) && <span className="vr-origin is-planted" title="The red team planted this error on purpose to test the check">Planted</span>}
      {decision.own_error && <span className="vr-origin is-own" title="An error the narrator made unprompted, checked by hand against the events">Narrator's own</span>}
      {lineFlagged(decision) && <span className="vr-origin is-line" title="The line on why it matters failed the check">{decision.insight.aired ? 'Why: fixed' : 'Why: cut'}</span>}
    </>
  );
}

export default function VarRoom({ decisions, recaps = [], liveId, selectedId, onSelect, hintId = null, people, view, renderAired, onInspect, onExplain }) {
  const [filter, setFilter] = useState('calls');
  const calls = decisions.filter(isCall);
  const shown = filter === 'calls' ? calls : decisions;
  const tabs = [['calls', `VAR calls · ${calls.length}`], ['all', `All captions · ${decisions.length}`]];
  if (recaps.length) tabs.push(['recaps', `Recaps · ${recaps.length}`]);
  return (
    <section className="var-room" aria-label="VAR room">
      <header className="vr-head">
        <div className="vr-title">
          <h2>VAR room <span className="rec">REC</span></h2>
          <button type="button" className="link" onClick={onExplain}>How it works</button>
        </div>
        <div className="vr-tabs" role="tablist" aria-label="Captions to show">
          {tabs.map(([value, label]) => (
            <button key={value} type="button" role="tab" aria-selected={filter === value} className={filter === value ? 'on' : ''} onClick={() => setFilter(value)}>{label}</button>
          ))}
        </div>
      </header>
      {filter === 'recaps' && <RecapList recaps={recaps} />}
      {filter !== 'recaps' && shown.length === 0 && (
        <p className="vr-empty">{decisions.length === 0 ? 'Captions appear here as the narrator writes them.' : 'No VAR calls yet: every caption so far checked out.'}</p>
      )}
      {filter !== 'recaps' && <ol className="vr-list">
        {shown.map(d => {
          const v = VERDICT[d.verdict.status];
          const open = d.id === selectedId;
          const aired = renderAired(d);
          return (
            <li key={d.id} className={`vr-item tone-${v.tone}${open ? ' is-open' : ''}${d.id === liveId ? ' is-live' : ''}`}>
              <button type="button" className="vr-row" onClick={() => onSelect(open ? null : d.id)} aria-expanded={open}>
                <span className="vr-minute">{d.display_minute}</span>
                <span className="vr-verdict">{v.label}</span>
                <Gist decision={d} aired={aired} />
              </button>
              {d.id === hintId && !open && <span className="hint hint-inline" role="note">↑ Click to see why it was stopped</span>}
              {open && <Detail decision={d} people={people} view={view} aired={aired} onInspect={onInspect} />}
            </li>
          );
        })}
      </ol>}
    </section>
  );
}
