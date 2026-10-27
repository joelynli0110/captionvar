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

/** Players at their last touch, faint and fading with age: the shape of both teams. */
/** Dark or light shirt numbers, whichever reads on the kit colour. */
function ink(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  if (Number.isNaN(n)) return '#fff';
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? '#0d1320' : '#fff';
}

function Shape({ shape, teamColor }) {
  return (
    <g className="shape" aria-hidden="true">
      {shape.map(p => (
        <g key={p.id} opacity={0.55 - p.age * 0.35}>
          <circle cx={X(p.x)} cy={Y(p.y)} r="1.25" fill={teamColor(p.side)} stroke="#0d132099" strokeWidth="0.15" />
          <text x={X(p.x)} y={Y(p.y) + 0.48} textAnchor="middle" className="shape-number" fill={ink(teamColor(p.side))}>{p.number}</text>
        </g>
      ))}
    </g>
  );
}

/** The move in progress, touch by touch, in the team's colour. */
function Chain({ trail, teamColor }) {
  if (trail.length < 2) return null;
  const points = trail.map(e => `${X(e.x)},${Y(e.y)}`).join(' ');
  return (
    <g className="chain" aria-hidden="true">
      <polyline points={points} fill="none" stroke={teamColor(trail.at(-1).side)} strokeWidth="0.4" strokeOpacity="0.7" strokeLinejoin="round" />
      {trail.map((e, i) => (
        <circle key={e.id} cx={X(e.x)} cy={Y(e.y)} r={i === trail.length - 1 ? 0.8 : 0.55} fill={teamColor(e.side)} opacity={0.35 + (i / trail.length) * 0.6} />
      ))}
    </g>
  );
}

/** A threshold tag (sprint, long or difficult pass, shot, distance) beside the player. */
function Tag({ tag, teamColor }) {
  if (!tag?.at) return null;
  const width = Math.max(tag.title.length * 1.05, (tag.value.length + tag.note.length) * 0.82) + 4;
  const right = X(tag.at.x) > 105 - width - 4;
  const x = right ? X(tag.at.x) - width - 2.4 : X(tag.at.x) + 2.4;
  // Above the player, unless that would sit under the score bug (top left): then below.
  let y = Y(tag.at.y) - 7.5;
  if (y < 0.8 || (y < 8.5 && x < 36)) y = Y(tag.at.y) + 2.4;
  y = Math.min(y, 68 - 7.4);
  return (
    <g className={`tag tag-${tag.kind}`} role="img" aria-label={`${tag.title}: ${tag.value}, ${tag.note}`}>
      <rect x={x} y={y} width={width} height="6.4" rx="0.6" className="tag-box" />
      <rect x={x} y={y} width="0.8" height="6.4" fill={teamColor(tag.side)} />
      <text x={x + 1.8} y={y + 2.5} className="tag-title">{tag.title}</text>
      <text x={x + 1.8} y={y + 5.2} className="tag-line"><tspan className="tag-value">{tag.value}</tspan> {tag.note}</text>
    </g>
  );
}

/**
 * The broadcast pitch: the teams' shape at their last touches, the move in
 * progress, the ball and the acting player, threshold tags, and, when a
 * caption is under review, its evidence drawn as VAR lines.
 */
export default function Pitch({ ball, actor, trail, shape = [], evidence, evidenceLabels, drawEvidence = false, quiet = false, people, focus, tag, teamColor }) {
  return (
    <svg className="pitch" viewBox="0 0 105 68" role="img" aria-label="Live pitch view of the synthetic match">
      <Markings />
      <Shape shape={shape} teamColor={teamColor} />
      <Chain trail={trail} teamColor={teamColor} />

      {focus.map(e => (
        <circle key={`f${e.id}`} cx={X(e.x)} cy={Y(e.y)} r="1.1" fill="none" stroke="var(--focus)" strokeWidth="0.3" opacity="0.7" />
      ))}

      {evidence.length > 0 && (
        <g className={`var-lines${drawEvidence ? ' is-drawing' : ''}`}>
          <polyline
            points={evidence.map(e => `${X(e.x)},${Y(e.y)}`).join(' ')}
            pathLength={drawEvidence ? 1 : undefined} fill="none" stroke="var(--var)" strokeWidth={drawEvidence ? 0.45 : 0.35}
            strokeDasharray={drawEvidence ? '1 1' : '1.2 0.8'} className="var-path"
          />
          {groupByPlace(evidence).map((group, i) => (
            <g key={`v${group[0].id}`} className="var-node" style={drawEvidence ? { animationDelay: `${300 + i * 260}ms` } : undefined}>
              <circle cx={X(group[0].x)} cy={Y(group[0].y)} r="1.6" fill="none" stroke="var(--var)" strokeWidth="0.35" />
              {evidenceLabels && (
                <text x={X(group[0].x) + 2.2} y={Y(group[0].y) - 1.8} className="var-label">
                  {group.map(e => e.id).join(', ')}
                  {people && group[0].player_id ? ` · ${people.name(group[0].player_id)}` : ''}
                </text>
              )}
            </g>
          ))}
        </g>
      )}

      {ball && (
        <g>
          {actor && (
            <g>
              <circle cx={X(ball.x)} cy={Y(ball.y)} r="2.1" fill={teamColor(actor.side)} opacity="0.35" />
              {!quiet && <text x={X(ball.x)} y={Y(ball.y) - 3} textAnchor="middle" className="actor-label">{actor.number} {actor.short_name}</text>}
            </g>
          )}
          <circle cx={X(ball.x)} cy={Y(ball.y)} r="0.85" fill="#fff" stroke="#0d1320" strokeWidth="0.22" />
        </g>
      )}

      <Tag tag={tag} teamColor={teamColor} />
    </svg>
  );
}
