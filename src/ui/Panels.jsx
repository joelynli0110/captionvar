import React, { useEffect, useRef, useState } from 'react';
import { LANGUAGES } from '../broadcast/render.js';

function Segmented({ label, value, options, onChange }) {
  return (
    <div className="control">
      <span className="control-label" id={`lbl-${label}`}>{label}</span>
      <div className="segmented" role="radiogroup" aria-labelledby={`lbl-${label}`}>
        {options.map(o => (
          <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Viewer options live behind one button so the broadcast stays the focus.
 * The button shows what is currently set, so nothing is hidden by surprise.
 */
export function ViewerSettings({ view, setView, teams, players, source }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = e => { if (e.key === 'Escape' || (e.type === 'pointerdown' && !ref.current?.contains(e.target))) setOpen(false); };
    window.addEventListener('keydown', close);
    window.addEventListener('pointerdown', close);
    return () => { window.removeEventListener('keydown', close); window.removeEventListener('pointerdown', close); };
  }, [open]);
  const set = key => value => setView(v => ({ ...v, [key]: value }));
  const lang = LANGUAGES.find(l => l.code === view.lang)?.label;
  const summary = [view.persona === 'analyst' ? 'Analyst' : 'Fan', lang, view.follow !== 'neutral' && teams[view.follow].short_name, view.player && players.find(p => p.id === view.player)?.short_name]
    .filter(Boolean).join(' · ');
  return (
    <div className="settings" ref={ref}>
      <button type="button" className="settings-toggle" aria-expanded={open} aria-controls="viewer-settings" onClick={() => setOpen(o => !o)}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4h7M13 4h1M2 12h1M7 12h7" /><circle cx="11" cy="4" r="2" /><circle cx="5" cy="12" r="2" /></svg>
        <span>{summary}</span>
      </button>
      {open && (
        <div className="settings-panel" id="viewer-settings" role="group" aria-label="Viewer settings">
          <Segmented label="Watching as" value={view.persona} onChange={set('persona')} options={[{ value: 'fan', label: 'Fan' }, { value: 'analyst', label: 'Analyst' }]} />
          <Segmented
            label="Supporting"
            value={view.follow}
            onChange={set('follow')}
            options={[{ value: 'neutral', label: 'Neutral' }, { value: 'home', label: teams.home.short_name }, { value: 'away', label: teams.away.short_name }]}
          />
          <div className="control">
            <label className="control-label" htmlFor="player-focus">Following</label>
            <select id="player-focus" value={view.player} onChange={e => set('player')(e.target.value)}>
              <option value="">No player</option>
              {['home', 'away'].map(side => (
                <optgroup key={side} label={teams[side].name}>
                  {players.filter(p => p.side === side).map(p => <option key={p.id} value={p.id}>{p.number} {p.name}</option>)}
                </optgroup>
              ))}
            </select>
          </div>
          <Segmented label="Language" value={view.lang} onChange={set('lang')} options={LANGUAGES.map(l => ({ value: l.code, label: l.label }))} />
          {source.agentTrace && (
            <Segmented
              label="Captions by"
              value={source.kind}
              onChange={source.onChange}
              options={[{ value: 'agents', label: source.agentTrace.source === 'foundry-agents' ? 'Foundry agents' : 'Agent workflow' }, { value: 'test', label: 'Test narrator' }]}
            />
          )}
        </div>
      )}
    </div>
  );
}

const ROWS = [
  ['Possession', s => `${s.possession.home ?? 0}%`, s => `${s.possession.away ?? 0}%`],
  ['xG', s => s.home.xg.toFixed(2), s => s.away.xg.toFixed(2)],
  ['Shots (on target)', s => `${s.home.shots} (${s.home.shots_on_target})`, s => `${s.away.shots} (${s.away.shots_on_target})`],
  ['Pass accuracy', s => (s.home.pass_accuracy == null ? '–' : `${s.home.pass_accuracy}%`), s => (s.away.pass_accuracy == null ? '–' : `${s.away.pass_accuracy}%`)],
  ['Final-third recoveries', s => s.home.attacking_third_recoveries, s => s.away.attacking_third_recoveries],
  ['Recoveries after a press', s => s.home.recoveries_after_pressure, s => s.away.recoveries_after_pressure],
  ['Pressures', s => s.home.pressures, s => s.away.pressures],
];

export function StatsPanel({ stats, teams }) {
  return (
    <table className="stats">
      <caption>Live match data, computed from events so far</caption>
      <thead>
        <tr><th scope="col">{teams.home.short_name}</th><th scope="col"><span className="sr-only">Statistic</span></th><th scope="col">{teams.away.short_name}</th></tr>
      </thead>
      <tbody>
        {ROWS.map(([label, h, a]) => (
          <tr key={label}><td>{h(stats)}</td><th scope="row">{label}</th><td>{a(stats)}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

export function PlayerCard({ player, stats, team, onClose }) {
  return (
    <aside className="player-card" aria-label={`Following ${player.name}`}>
      <div className="pc-head">
        <span className="pc-number" style={{ background: team.colors.primary }}>{player.number}</span>
        <div>
          <strong>{player.name}</strong>
          <span>{team.short_name}, {player.position}</span>
        </div>
        <button type="button" className="pc-close" onClick={onClose} aria-label="Stop following this player">×</button>
      </div>
      <dl>
        <div><dt>Touches</dt><dd>{stats.touches}</dd></div>
        <div><dt>Passes</dt><dd>{stats.passes_completed}/{stats.passes}</dd></div>
        <div><dt>Goals</dt><dd>{stats.goals}</dd></div>
        <div><dt>Shots</dt><dd>{stats.shots}</dd></div>
        <div><dt>Ball wins</dt><dd>{stats.recoveries}</dd></div>
        <div><dt>Pressures</dt><dd>{stats.pressures}</dd></div>
        {stats.top_speed_kmh != null && <div><dt>Top speed</dt><dd>{stats.top_speed_kmh} km/h</dd></div>}
        {stats.total_distance_km != null && <div><dt>Distance</dt><dd>{stats.total_distance_km} km</dd></div>}
      </dl>
    </aside>
  );
}
