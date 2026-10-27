import React, { useEffect, useRef, useState } from 'react';
import { LANGUAGES } from '../broadcast/render.js';
import { THRESHOLDS } from '../broadcast/overlays.js';

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
export function ViewerSettings({ view, setView, teams, players, source, speed, speeds = [], onSpeed, moments = [], onJump }) {
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
  const summary = [view.persona === 'analyst' ? 'Analyst' : 'Fan', lang, view.follow !== 'neutral' && teams[view.follow].short_name, view.player && players.find(p => p.id === view.player)?.short_name, speed && `${speed}×`]
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
          {onSpeed && <Segmented label="Speed" value={speed} onChange={onSpeed} options={speeds.map(s => ({ value: s, label: `${s}×` }))} />}
          {onJump && moments.length > 0 && (
            <div className="control">
              <span className="control-label">Jump to</span>
              <div className="jumps">
                {moments.map(m => <button key={m.label} type="button" onClick={() => { onJump(m); setOpen(false); }}>{m.label}</button>)}
              </div>
            </div>
          )}
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

/**
 * Production shows the VAR at work; the viewer feed shows only what airs.
 */
export function FeedSwitch({ value, onChange }) {
  return (
    <div className="feed-switch" role="radiogroup" aria-label="Picture">
      {[['production', 'Production'], ['viewer', 'Viewer feed'], ['fans', 'Two fans']].map(([v, label]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>{label}</button>
      ))}
    </div>
  );
}

/**
 * The five-match result as a full-time score: of the errors the narrator
 * made on its own (confirmed by hand), how many each checker kept off air.
 */
export function Scoreboard({ result }) {
  return (
    <section className="scoreboard" aria-label={`Result over five matches: of ${result.own} errors the narrator made on its own, an LLM judge stopped ${result.judge}, CaptionVAR stopped ${result.captionvar}.`}>
      <span className="sb-label">Own errors stopped</span>
      <span className="sb-team">LLM judge</span>
      <span className="sb-score"><b>{result.judge}</b><i>–</i><b className="win">{result.captionvar}</b></span>
      <span className="sb-team win">CaptionVAR</span>
    </section>
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
  [`Long passes (≥ ${THRESHOLDS.long_pass_m} m)`, s => s.home.long_passes, s => s.away.long_passes],
  ['Difficult passes completed', s => s.home.difficult_passes, s => s.away.difficult_passes],
  ['Fastest shot', s => (s.home.fastest_shot_kmh ? `${s.home.fastest_shot_kmh} km/h` : '–'), s => (s.away.fastest_shot_kmh ? `${s.away.fastest_shot_kmh} km/h` : '–')],
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

/**
 * Play along: Beat the VAR (call the false words before the check), the red
 * team's plant rate for the in-browser test narrator, and cue sounds.
 */
export function PlayAlong({ game, onGame, tally, rate, onRate, sound, onSound, voice, onVoice, agentsOn }) {
  const pct = Math.round(rate * 100);
  const [open, setOpen] = useState(game);
  if (!open) {
    return (
      <button type="button" className="play-along-open" aria-expanded="false" onClick={() => setOpen(true)}>
        Play along<span> · Beat the VAR · red team · voice</span><b aria-hidden="true">+</b>
      </button>
    );
  }
  return (
    <section className="play-along" aria-label="Play along">
      <button type="button" className="pa-close" aria-label="Hide play along" onClick={() => setOpen(false)}>×</button>
      <div className="pa-block">
        <button type="button" className={`pa-toggle${game ? ' on' : ''}`} aria-pressed={game} onClick={() => onGame(!game)}>Beat the VAR</button>
        <span className="pa-note">
          {game
            ? tally.calls ? <><b>{tally.right}/{tally.calls}</b> calls spot on · <b>{tally.caught}/{tally.total}</b> false claims spotted{tally.falseAlarms ? ` · ${tally.falseAlarms} called false wrongly` : ''}</> : 'Each caption waits for your call before the check.'
            : 'Call the false words before the referee does.'}
        </span>
      </div>
      <label className="pa-block pa-red">
        <span className="pa-label">Red team</span>
        <input type="range" min="0" max="100" step="5" value={pct} onChange={e => onRate(Number(e.target.value) / 100)} aria-describedby="pa-red-note" />
        <span className="pa-value">{pct}%</span>
        <span className="pa-note" id="pa-red-note">{agentsOn ? 'Showing the Foundry run as recorded. Move this to replay the match with the test narrator in your browser, with that share of captions planted wrong.' : 'of the test narrator\'s captions are planted wrong, then checked by the same referee in your browser.'}</span>
      </label>
      {onVoice && (
        <button type="button" className={`pa-toggle pa-voice${voice ? ' on' : ''}`} aria-pressed={voice} onClick={() => onVoice(!voice)}
          title="Reads out each caption after its VAR check, in the caption language">{voice ? 'Voice on' : 'Voice off'}</button>
      )}
      <button type="button" className={`pa-toggle pa-sound${sound ? ' on' : ''}`} aria-pressed={sound} onClick={() => onSound(!sound)}>{sound ? 'Sound on' : 'Sound off'}</button>
    </section>
  );
}

/** Two fans, one checked caption: each in their own language, from the same verified facts. */
export function FanSplit({ fans, lines, minute }) {
  return (
    <div className="fan-split">
      {fans.map((f, i) => (
        <div key={f.key} className="fan-panel" style={{ '--kit': f.color }} lang={f.lang}>
          <div className="fan-tag"><b>{f.label}</b><span>{f.langName}{minute ? ` · ${minute}` : ''}</span></div>
          <p className="lt-text">{lines[i]}</p>
        </div>
      ))}
    </div>
  );
}
