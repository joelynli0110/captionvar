import React, { useEffect, useState } from 'react';
import { VERDICT, firstDraft } from './data.js';

export function ScoreBug({ teams, score, clock }) {
  return (
    <div className="score-bug" aria-label={`${teams.home.name} ${score.home}, ${teams.away.name} ${score.away}, ${clock}`}>
      <span className="kit" style={{ background: teams.home.colors.primary }} />
      <span className="code">{teams.home.id}</span>
      <span className="goals">{score.home}–{score.away}</span>
      <span className="code">{teams.away.id}</span>
      <span className="kit" style={{ background: teams.away.colors.primary }} />
      <span className="clock">{clock}</span>
    </div>
  );
}

export const reduceMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** How long each phase of an on-air caption lasts, in real milliseconds. */
export const PHASE_MS = { checking: 900, review: 4400 };

/**
 * Every new caption gets a short VAR check: the draft sits in the lower third
 * while a scan line passes over it. When the check changed the caption, the
 * full VAR moment plays (VarCheck below): the picture freezes, the false words
 * are struck as the line reaches them, the evidence is drawn on the pitch, the
 * decision is stamped, and the caption that may air wipes in. The animation is
 * presentational: the decision was made from the data before it reached here.
 */
export function useOnAirPhase(decision) {
  const [phase, setPhase] = useState('aired');
  useEffect(() => {
    if (!decision || reduceMotion()) { setPhase('aired'); return undefined; }
    const changed = decision.verdict.status !== 'VERIFY';
    setPhase('checking');
    const timers = [setTimeout(() => setPhase(changed ? 'review' : 'aired'), PHASE_MS.checking)];
    if (changed) timers.push(setTimeout(() => setPhase('aired'), PHASE_MS.checking + PHASE_MS.review));
    return () => timers.forEach(clearTimeout);
    // Keyed on the decision object, not its id: the agent trace and the test
    // narrator reuse caption ids, and switching source must restart the check.
  }, [decision]);
  return phase;
}

/** The narrator's draft with the words the check rejected marked. */
export function Draft({ decision, className = 'candidate' }) {
  const status = Object.fromEntries(decision.verdict.claims.map(c => [c.id, c.status]));
  return (
    <p className={className}>
      {decision.segments.map((s, i) => (
        <span key={i} className={s.claim ? `seg seg-${status[s.claim]}` : 'seg'}>{s.text}</span>
      ))}
    </p>
  );
}

/** Timings inside the VAR moment (ms from its start); CSS reads them as delays. */
const SCAN_MS = 1500;
const STAMP_MS = 1750;
const SWAP_MS = 2700;

/**
 * The draft as the scan line passes over it: each rejected segment is struck
 * when the line reaches it (its delay is its position in the text).
 */
function ScannedDraft({ decision }) {
  const status = Object.fromEntries(decision.verdict.claims.map(c => [c.id, c.status]));
  const total = decision.segments.reduce((n, s) => n + s.text.length, 0) || 1;
  let at = 0;
  return (
    <p className="lt-text lt-draft">
      {decision.segments.map((s, i) => {
        const start = at;
        at += s.text.length;
        const st = s.claim ? status[s.claim] : null;
        const hit = st === 'contradicted' || st === 'unverifiable';
        return (
          <span key={i} className={hit ? `seg seg-hit seg-hit-${st}` : 'seg'}
            style={hit ? { animationDelay: `${Math.round((start / total) * SCAN_MS)}ms` } : undefined}>
            {s.text}
          </span>
        );
      })}
    </p>
  );
}

/** The VAR bug and the decision stamp, over a frozen, desaturated picture. */
export function VarCheck({ decision, clock }) {
  const v = VERDICT[decision.verdict.status];
  const why = firstDraft(decision).flags[0];
  return (
    <div className={`var-check tone-${v.tone}`} role="status" aria-live="assertive">
      <div className="var-bug"><span>VAR</span><b>CHECK</b><i>{clock}</i></div>
      <div className="var-stamp" style={{ animationDelay: `${STAMP_MS}ms` }}>
        <span className="vs-complete">Check complete</span>
        <strong>{v.decision}</strong>
        {why && <span className="vs-why">{why.note}</span>}
      </div>
    </div>
  );
}

export function LowerThird({ decision, text, lang, phase, insight, feed = 'production' }) {
  if (!decision) return null;
  const v = VERDICT[decision.verdict.status];
  // The viewer feed shows only what airs: no check, no verdict.
  if (feed === 'viewer') {
    return (
      <div className="lower-third tone-live" aria-live="polite" lang={lang}>
        <div className="lt-tag">Live<span className="lt-minute">{decision.display_minute}</span></div>
        <div className="lt-body">
          <p className="lt-text">{text}</p>
          {insight && <p className="lt-why" lang="en"><span>Why it matters</span>{insight}</p>}
        </div>
      </div>
    );
  }
  const checking = phase === 'checking';
  const review = phase === 'review';
  return (
    <div className={`lower-third ${checking || review ? 'is-checking' : `tone-${v.tone}`}${review ? ` is-review tone-${v.tone}` : ''}`} aria-live="polite" lang={lang}>
      <div className="lt-tag">
        {checking ? 'VAR check' : review ? <span className="lt-flip" style={{ animationDelay: `${SWAP_MS}ms` }}><span>VAR check</span><span>{v.air}</span></span> : v.air}
        <span className="lt-minute">{decision.display_minute}</span>
      </div>
      <div className="lt-body">
        {checking && <p className="lt-text lt-draft">{firstDraft(decision).text}</p>}
        {review && (
          <div className="lt-swap">
            <ScannedDraft decision={decision} />
            <p className="lt-text lt-aired" style={{ animationDelay: `${SWAP_MS}ms` }}>{text}</p>
          </div>
        )}
        {!checking && !review && <p className="lt-text">{text}</p>}
        {!checking && !review && insight && (
          <p className="lt-why" lang="en"><span>Why it matters</span>{insight}</p>
        )}
      </div>
      {(checking || review) && <span className="lt-scanline" style={{ animationDuration: `${checking ? PHASE_MS.checking - 100 : SCAN_MS}ms` }} aria-hidden="true" />}
    </div>
  );
}

/** A line of context or recap sentence as first written, with what the check rejected marked. */
export function LineDraft({ line, className = 'candidate' }) {
  const status = Object.fromEntries(line.verdict.claims.map(c => [c.id, c.framing ? 'framing' : c.status]));
  return (
    <p className={className}>
      {line.segments.map((s, i) => (
        <span key={i} className={s.claim ? `seg seg-${status[s.claim]}` : 'seg'}>{s.text}</span>
      ))}
    </p>
  );
}

/**
 * The recap at half-time and full time: the sentences that passed, and the
 * ones the check cut, struck through with the reason.
 */
export function RecapCard({ recap, onClose }) {
  const cut = recap.sentences.filter(s => !s.aired);
  return (
    <div className="recap-card" role="status" aria-live="polite">
      <div className="rc-head">
        <span className="rc-var">VAR</span>
        <span className="rc-decision recap-title">{recap.recap === 'HT' ? 'Half-time recap' : 'Full-time recap'}</span>
        <span className="rc-minute">{recap.sentences.length - cut.length}/{recap.sentences.length} checked</span>
        {onClose && <button type="button" className="recap-close" onClick={onClose} aria-label="Close recap">×</button>}
      </div>
      <ol className="recap-lines">
        {recap.sentences.map((s, i) => (
          <li key={i} className={s.aired ? 'is-aired' : 'is-cut'}>
            {s.aired ? <span>{s.aired.text}</span> : <LineDraft line={s} className="recap-cut" />}
            {!s.aired && <span className="recap-why">Cut: {s.attempts[0].flags[0]?.note ?? 'did not pass the check'}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}
