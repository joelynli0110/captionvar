import React, { useEffect, useState } from 'react';
import { VERDICT } from './data.js';

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

const reduceMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * The lower third. A new caption first shows the VAR check in progress, then
 * what is allowed to air. The check animation is purely presentational; the
 * decision itself was made from the data before the caption reached here.
 */
export function LowerThird({ decision, text, lang }) {
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    if (!decision || reduceMotion()) return undefined;
    setChecking(true);
    const timer = setTimeout(() => setChecking(false), 1100);
    return () => clearTimeout(timer);
  }, [decision?.id]);

  if (!decision) return null;
  const v = VERDICT[decision.verdict.status];
  const claims = decision.claims.length;
  return (
    <div className={`lower-third ${checking ? 'is-checking' : `tone-${v.tone}`}`} aria-live="polite" lang={lang}>
      <div className="lt-tag">
        {checking ? 'VAR check' : v.air}
        <span className="lt-minute">{decision.display_minute}</span>
      </div>
      <p className="lt-text">
        {checking ? `Checking ${claims} claim${claims === 1 ? '' : 's'} against the match data` : text}
      </p>
      {checking && <span className="lt-scan" aria-hidden="true" />}
    </div>
  );
}
