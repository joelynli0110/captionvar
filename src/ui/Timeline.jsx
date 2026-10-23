import React, { useMemo, useRef } from 'react';

const H = 64;
const MID = 30;

/**
 * Match rhythm and scrubber. Bars show each team's on-ball actions in the
 * opponent's final third per minute (home above the line, away below), with
 * goals, cards and VAR interventions marked. Click or drag to move through
 * the match.
 */
export default function Timeline({ events, eventG, endG, halfG, decisions, g, onSeek, teamColor }) {
  const ref = useRef(null);

  const bars = useMemo(() => {
    const buckets = new Map();
    events.forEach((e, i) => {
      if (!['pass', 'carry', 'shot'].includes(e.type) || e.zone !== 'attacking_third') return;
      const key = Math.floor(eventG[i] / 60);
      const b = buckets.get(key) || { home: 0, away: 0 };
      b[e.side] += e.type === 'shot' ? 4 : 1;
      buckets.set(key, b);
    });
    const max = Math.max(...[...buckets.values()].flatMap(b => [b.home, b.away]), 1);
    return [...buckets.entries()].map(([m, b]) => ({ m, home: b.home / max, away: b.away / max }));
  }, [events, eventG]);

  const marks = useMemo(() => events
    .map((e, i) => ({ e, g: eventG[i] }))
    .filter(({ e }) => e.type === 'goal' || e.type === 'card'), [events, eventG]);

  const pct = v => `${(v / endG) * 100}%`;
  const seekFromPointer = ev => {
    const r = ref.current.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
    onSeek(f * endG);
  };
  const onKey = ev => {
    if (ev.key === 'ArrowRight') onSeek(Math.min(endG, g + 30));
    if (ev.key === 'ArrowLeft') onSeek(Math.max(0, g - 30));
  };

  return (
    <div className="timeline">
      <div
        ref={ref}
        className="tl-track"
        role="slider"
        tabIndex={0}
        aria-label="Match time"
        aria-valuemin={0}
        aria-valuemax={Math.round(endG)}
        aria-valuenow={Math.round(g)}
        onPointerDown={ev => { ev.currentTarget.setPointerCapture(ev.pointerId); seekFromPointer(ev); }}
        onPointerMove={ev => { if (ev.buttons === 1) seekFromPointer(ev); }}
        onKeyDown={onKey}
      >
        <svg viewBox={`0 0 ${endG} ${H}`} preserveAspectRatio="none" aria-hidden="true">
          <rect x={halfG.end1} y="0" width={halfG.start2 - halfG.end1} height={H} className="tl-break" />
          {bars.map(b => (
            <g key={b.m}>
              <rect x={b.m * 60 + 6} y={MID - b.home * (MID - 4)} width="48" height={b.home * (MID - 4)} fill={teamColor('home')} opacity="0.8" />
              <rect x={b.m * 60 + 6} y={MID + 1} width="48" height={b.away * (MID - 4)} fill={teamColor('away')} opacity="0.7" />
            </g>
          ))}
          <line x1="0" x2={endG} y1={MID + 0.5} y2={MID + 0.5} className="tl-axis" />
          {decisions.filter(d => d.verdict.status !== 'VERIFY').map(d => (
            <rect key={d.id} x={d.g - 12} y={H - 5} width="24" height="5" className={d.verdict.status === 'WITHHOLD' ? 'tl-stop' : 'tl-trim'} />
          ))}
        </svg>
        {marks.map(({ e, g: mg }) => (
          <span
            key={e.id}
            className={`tl-mark tl-${e.type}`}
            style={{ left: pct(mg), ...(e.type === 'goal' ? { background: teamColor(e.side) } : {}) }}
            title={`${e.display_minute} ${e.type === 'goal' ? `Goal, ${e.player}` : `Yellow card, ${e.player}`}`}
          />
        ))}
        <span className="tl-head" style={{ left: pct(g) }} />
      </div>
      <div className="tl-scale" aria-hidden="true">
        <span style={{ left: 0 }}>0'</span>
        <span style={{ left: pct(halfG.end1 / 2) }}>23'</span>
        <span style={{ left: pct((halfG.end1 + halfG.start2) / 2) }}>HT</span>
        <span style={{ left: pct(halfG.start2 + (endG - halfG.start2) / 2) }}>68'</span>
        <span style={{ left: '100%' }}>90'</span>
      </div>
    </div>
  );
}
