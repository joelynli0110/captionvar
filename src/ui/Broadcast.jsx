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
export const PHASE_MS = { checking: 1100, review: 3600 };

/**
 * A new caption first shows the VAR check in progress. When the check changed
 * the caption, a review card takes over the screen for a moment, like a VAR
 * decision on a stadium screen; then the caption that is allowed to air shows
 * in the lower third. The animation is presentational: the decision itself
 * was made from the data before the caption reached here.
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

export function ReviewCard({ decision, text }) {
  const v = VERDICT[decision.verdict.status];
  const why = firstDraft(decision).flags[0];
  return (
    <div className={`review-card tone-${v.tone}`} role="status" aria-live="assertive">
      <div className="rc-head">
        <span className="rc-var">VAR</span>
        <span className="rc-decision">{v.decision}</span>
        <span className="rc-minute">{decision.display_minute}</span>
      </div>
      <Draft decision={decision} className="rc-draft" />
      {why && <p className="rc-why">{why.note}</p>}
      <p className="rc-air"><span>On air</span>{text}</p>
    </div>
  );
}

export function LowerThird({ decision, text, lang, phase, insight }) {
  if (!decision || phase === 'review') return null;
  const v = VERDICT[decision.verdict.status];
  const checking = phase === 'checking';
  const claims = decision.claims.length;
  return (
    <div className={`lower-third ${checking ? 'is-checking' : `tone-${v.tone}`}`} aria-live="polite" lang={lang}>
      <div className="lt-tag">
        {checking ? 'VAR check' : v.air}
        <span className="lt-minute">{decision.display_minute}</span>
      </div>
      <div className="lt-body">
        <p className="lt-text">
          {checking ? `Checking ${claims} claim${claims === 1 ? '' : 's'} against the match data` : text}
        </p>
        {!checking && insight && (
          <p className="lt-why" lang="en"><span>Why it matters</span>{insight}</p>
        )}
      </div>
      {checking && <span className="lt-scan" aria-hidden="true" />}
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
