import React, { useEffect, useRef } from 'react';

/** The agents as a team sheet: who plays where, and which one is not a model. */
const SHEET = [
  { n: 1, name: 'Narrator', kind: 'LLM', text: 'Writes the caption for each moment.' },
  { n: 2, name: 'Claim Extractor', kind: 'LLM', text: 'Lists what a line claims, without ever seeing the facts.' },
  { n: 3, name: 'VAR Referee', kind: 'Code', text: 'Checks every claim against the match events so far, and cites them. Served over MCP.' },
  { n: 4, name: 'Editor', kind: 'LLM', text: 'Rewrites a failed caption; the rewrite is checked again, at most twice, else the moment airs from the data.' },
  { n: 5, name: 'Analyst', kind: 'LLM', text: 'Adds why a key moment matters, from the running numbers.' },
  { n: 6, name: 'Recap writer', kind: 'LLM', text: 'Sums up each half, sentence by sentence.' },
  { n: 7, name: 'Line editor', kind: 'LLM', text: 'Gives a failed line one rewrite; otherwise it is cut.' },
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
      <p className="how-kicker">Team sheet</p>
      <h2 id="how-title">Every line gets a VAR check before it airs</h2>
      <ol className="how-sheet">
        {SHEET.map(s => (
          <li key={s.name} className={s.kind === 'Code' ? 'is-code' : ''}>
            <span className="how-n">{s.n}</span>
            <strong>{s.name}</strong>
            <span className="how-kind">{s.kind}</span>
            <p>{s.text}</p>
          </li>
        ))}
      </ol>
      <p className="how-note">
        A red team tells the agents to slip an error into about a third of what they write. The extractor and the referee are not told which.
        {usage && trace.source === 'foundry-agents' && ` This match ran on Microsoft Foundry (${trace.model}): ${usage.llm_calls} model calls, about $${usage.estimated_cost_usd.toFixed(2)}.`}
        {' '}Clubs, players and events are synthetic.
      </p>
      <button type="button" className="how-close" onClick={onClose} autoFocus>Kick off</button>
    </dialog>
  );
}
