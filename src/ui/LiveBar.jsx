import React from 'react';

/**
 * Says whether the captions are a live run or the recorded one, and offers a
 * live run. Shown only when the page is served by the live server.
 */
export default function LiveBar({ status, live, on, waiting, onStart, onReplay }) {
  const engine = model => (status?.offline ? 'offline test model, no Azure' : `Microsoft Foundry · ${model || status?.model}`);
  if (on && live && !live.unavailable) {
    const got = live.decisions.length;
    const total = live.moments?.length ?? 0;
    const state = !live.moments ? 'starting the agents'
      : live.done ? `${live.cached ? 'run from the last few minutes' : 'run finished'} · ${got} of ${total} captions${live.calls != null ? ` · ${live.calls} model calls` : ''}${live.reason && live.reason !== 'done' ? ` · ${live.reason}` : ''}`
        : waiting ? `agents at work on ${live.moments.find(m => !live.decisions.some(d => d.seq === m.seq))?.display_minute ?? ''} · ${got} of ${total}`
          : `${got} of ${total} captions`;
    return (
      <div className="live-bar is-live" role="status">
        <span className="live-tag"><span className="live-dot" aria-hidden="true" />Live</span>
        <span className="live-engine">{engine(live.model)}</span>
        <span className="live-state">{state}</span>
        <button type="button" className="live-switch" onClick={onReplay}>Back to the replay</button>
      </div>
    );
  }
  const reason = live?.unavailable ?? (status && !status.available ? status.reason : null);
  return (
    <div className="live-bar" role="status">
      <span className="live-tag is-replay">Replay</span>
      <span className="live-engine">the recorded Foundry run</span>
      {reason ? <span className="live-state">{reason}</span>
        : (
          <button type="button" className="live-go" onClick={onStart}>
            Run it live on {status?.offline ? 'the test model' : 'Foundry'}<span aria-hidden="true"> ›</span>
          </button>
        )}
      {!reason && <span className="live-state">{status.window.moments} moments from {status.window.from_minute}&prime;, one at a time</span>}
    </div>
  );
}
