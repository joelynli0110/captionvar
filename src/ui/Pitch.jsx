import React from 'react';

// Event coordinates are 0..100 on both axes; the SVG uses metres (105 x 68).
const X = x => (x / 100) * 105;
const Y = y => (y / 100) * 68;
const STRIPES = 12;

/** Events at (nearly) the same spot share one marker and one label. */
function groupByPlace(events) {
  const groups = [];
  for (const e of events) {
    const g = groups.find(([f]) => Math.abs(f.x - e.x) < 2 && Math.abs(f.y - e.y) < 3);
    if (g) g.push(e); else groups.push([e]);
  }
  return groups;
}

function Markings() {
  const line = { fill: 'none', stroke: 'var(--pitch-line)', strokeWidth: 0.28 };
  return (
    <g>
      {Array.from({ length: STRIPES }, (_, i) => (
        <rect key={i} x={(105 / STRIPES) * i} y="0" width={105 / STRIPES} height="68" fill={i % 2 ? 'var(--turf-a)' : 'var(--turf-b)'} />
      ))}
      <rect x="0.4" y="0.4" width="104.2" height="67.2" {...line} />
      <line x1="52.5" y1="0.4" x2="52.5" y2="67.6" {...line} />
      <circle cx="52.5" cy="34" r="9.15" {...line} />
      <circle cx="52.5" cy="34" r="0.35" fill="var(--pitch-line)" />
      <rect x="0.4" y="13.84" width="16.5" height="40.32" {...line} />
      <rect x="88.1" y="13.84" width="16.5" height="40.32" {...line} />
      <rect x="0.4" y="24.84" width="5.5" height="18.32" {...line} />
      <rect x="99.1" y="24.84" width="5.5" height="18.32" {...line} />
      <circle cx="11" cy="34" r="0.35" fill="var(--pitch-line)" />
      <circle cx="94" cy="34" r="0.35" fill="var(--pitch-line)" />
      <path d="M16.9 26.7 A9.15 9.15 0 0 1 16.9 41.3" {...line} />
      <path d="M88.1 26.7 A9.15 9.15 0 0 0 88.1 41.3" {...line} />
    </g>
  );
}

/**
 * The broadcast pitch: ball, recent touches, the acting player and — when a
 * caption is under review — its evidence drawn as VAR lines.
 */
export default function Pitch({ ball, actor, trail, evidence, evidenceLabels, focus, pop, teamColor, analyst }) {
  return (
    <svg className="pitch" viewBox="0 0 105 68" role="img" aria-label="Live pitch view of the synthetic match">
      <Markings />

      {trail.map((e, i) => (
        e.end_x != null && e.type === 'pass' && (analyst || i >= trail.length - 4)
          ? <line key={`l${e.id}`} x1={X(e.x)} y1={Y(e.y)} x2={X(e.end_x)} y2={Y(e.end_y)} stroke={teamColor(e.side)} strokeOpacity={0.15 + (i / trail.length) * 0.45} strokeWidth="0.35" />
          : null
      ))}
      {trail.map((e, i) => (
        <circle key={e.id} cx={X(e.x)} cy={Y(e.y)} r="0.75" fill={teamColor(e.side)} opacity={0.15 + (i / trail.length) * 0.55} />
      ))}

      {focus.map(e => (
        <circle key={`f${e.id}`} cx={X(e.x)} cy={Y(e.y)} r="1.1" fill="none" stroke="var(--focus)" strokeWidth="0.3" opacity="0.7" />
      ))}

      {evidence.length > 0 && (
        <g className="var-lines">
          <polyline
            points={evidence.map(e => `${X(e.x)},${Y(e.y)}`).join(' ')}
            fill="none" stroke="var(--var)" strokeWidth="0.35" strokeDasharray="1.2 0.8"
          />
          {groupByPlace(evidence).map(group => (
            <g key={`v${group[0].id}`}>
              <circle cx={X(group[0].x)} cy={Y(group[0].y)} r="1.6" fill="none" stroke="var(--var)" strokeWidth="0.35" />
              {evidenceLabels && <text x={X(group[0].x) + 2.2} y={Y(group[0].y) - 1.8} className="var-label">{group.map(e => e.id).join(', ')}</text>}
            </g>
          ))}
        </g>
      )}

      {ball && (
        <g>
          {actor && (
            <g>
              <circle cx={X(ball.x)} cy={Y(ball.y)} r="2.1" fill={teamColor(actor.side)} opacity="0.35" />
              <text x={X(ball.x)} y={Y(ball.y) - 3} textAnchor="middle" className="actor-label">{actor.number} {actor.short_name}</text>
            </g>
          )}
          <circle cx={X(ball.x)} cy={Y(ball.y)} r="0.85" fill="#fff" stroke="#0d1320" strokeWidth="0.22" />
        </g>
      )}

      {pop && ball && (
        <g className="pop">
          <rect x={X(ball.x) + 2.4} y={Y(ball.y) + 1} width={pop.length * 1.15 + 2.4} height="3.6" rx="0.6" />
          <text x={X(ball.x) + 3.6} y={Y(ball.y) + 3.65}>{pop}</text>
        </g>
      )}
    </svg>
  );
}
