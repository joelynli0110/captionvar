import React, { useEffect, useRef } from 'react';

const STEPS = [
  { name: 'Narrator', kind: 'LLM', text: 'Writes one broadcast line about the moment.' },
  { name: 'Claim Extractor', kind: 'LLM', text: 'Lists what the line claims. It never sees the facts, so it cannot quietly fix them.' },
  { name: 'VAR Referee', kind: 'Code', text: 'Checks every claim against the match events recorded so far, and cites them.' },
  { name: 'Editor', kind: 'LLM', text: 'Rewrites a failed line from the verdict. The rewrite is checked again, at most twice; otherwise the moment airs straight from the data.' },
];

export default function HowItWorks({ trace, onClose }) {
  const ref = useRef(null);
  // No close() on cleanup: closing fires the dialog's close event, which would
  // count as the viewer dismissing it (React runs effects twice in dev).
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal?.();
  }, []);
  const usage = trace?.usage;
  return (
    <dialog ref={ref} className="how" aria-labelledby="how-title" onClose={onClose} onClick={e => { if (e.target === ref.current) onClose(); }}>
      <h2 id="how-title">Every caption gets a VAR check before it airs</h2>
      <ol className="how-steps">
        {STEPS.map((s, i) => (
          <li key={s.name} className={s.kind === 'Code' ? 'is-code' : ''}>
            <span className="how-n">{i + 1}</span>
            <div>
              <strong>{s.name}</strong> <span className="how-kind">{s.kind}</span>
              <p>{s.text}</p>
            </div>
          </li>
        ))}
      </ol>
      <p className="how-more">
        After key moments the <strong>Analyst</strong> <span className="how-kind">LLM</span> adds why it matters, and the <strong>Recap writer</strong> <span className="how-kind">LLM</span> sums up each half.
        Every line they write goes through steps 2 and 3; one that fails is cut.
      </p>
      <p className="how-note">
        A red team tells the agents to slip an error into about a third of what they write. The extractor and the referee are not told which.
        {usage && trace.source === 'foundry-agents' && ` This match ran on Microsoft Foundry (${trace.model}): ${usage.llm_calls} model calls, about $${usage.estimated_cost_usd.toFixed(2)}.`}
        {' '}Clubs, players and events are synthetic.
      </p>
      <button type="button" className="how-close" onClick={onClose} autoFocus>Watch the match</button>
    </dialog>
  );
}
