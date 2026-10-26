import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadBroadcast, loadAgentTrace, indexAt, clockLabel, DEMO } from './ui/data.js';
import { matchStats, playerStats } from './sim/stats.js';
import { renderCaption } from './broadcast/render.js';
import { summarise } from './broadcast/trace.js';
import Pitch from './ui/Pitch.jsx';
import { ScoreBug, LowerThird, ReviewCard, RecapCard, useOnAirPhase } from './ui/Broadcast.jsx';
import VarRoom from './ui/VarRoom.jsx';
import Timeline from './ui/Timeline.jsx';
import { ViewerSettings, StatsPanel, PlayerCard } from './ui/Panels.jsx';
import HowItWorks from './ui/HowItWorks.jsx';

const B = loadBroadcast();
const PEOPLE = B.trace.people;
const PLAYERS = [...PEOPLE.players.values()];
const ON_BALL = new Set(['pass', 'carry', 'shot', 'recovery', 'tackle', 'interception', 'clearance', 'save', 'block', 'foul']);
const CAPTION_HOLD_S = 45; // match seconds a caption stays in the lower third
const WITH_LINE_HOLD_S = 70; // longer when a line of context follows it
const SPEEDS = [2, 4, 8, 16, 32];

const teamColor = side => B.teams[side].colors.primary;

/** First visit shows the explainer before play starts; ?intro=0 skips it. */
function introWanted() {
  try {
    if (new URLSearchParams(window.location.search).get('intro') === '0') return false;
    return window.localStorage.getItem('captionvar-intro-seen') !== '1';
  } catch {
    return false;
  }
}
function markIntroSeen() {
  try { window.localStorage.setItem('captionvar-intro-seen', '1'); } catch { /* storage unavailable */ }
}

/** Playback clock. While held (a VAR review on screen) the match clock waits. */
function usePlayback(startPlaying, held) {
  const [g, setG] = useState(B.startG);
  const [playing, setPlaying] = useState(startPlaying);
  const [speed, setSpeed] = useState(DEMO.speed);
  useEffect(() => {
    if (!playing) return undefined;
    let frame;
    let last = performance.now();
    const tick = now => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (held.current) { frame = requestAnimationFrame(tick); return; }
      setG(prev => {
        const next = prev + dt * speed;
        if (next >= B.endG) { setPlaying(false); return B.endG; }
        return next;
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, speed, held]);
  return { g, setG, playing, setPlaying, speed, setSpeed };
}

/** Ball position between two located events, so the ball travels instead of jumping. */
function ballAt(idx, g) {
  let i = idx;
  while (i > 0 && B.events[i].x == null) i -= 1;
  const e = B.events[i];
  if (!e || e.x == null) return null;
  let j = idx + 1;
  while (j < B.events.length && B.events[j].x == null) j += 1;
  const next = B.events[j];
  const to = e.end_x != null ? { x: e.end_x, y: e.end_y } : next && next.period === e.period ? { x: next.x, y: next.y } : { x: e.x, y: e.y };
  const span = next ? B.eventG[j] - B.eventG[i] : 1;
  const f = span > 0 ? Math.min(1, Math.max(0, (g - B.eventG[i]) / span)) : 1;
  return { x: e.x + (to.x - e.x) * f, y: e.y + (to.y - e.y) * f, event: e };
}

function recent(idx, pick, limit, lookback = 400) {
  const out = [];
  for (let i = idx; i >= 0 && i > idx - lookback && out.length < limit; i -= 1) {
    if (pick(B.events[i])) out.push(B.events[i]);
  }
  return out.reverse();
}

export default function App() {
  const [explaining, setExplaining] = useState(introWanted);
  const held = useRef(false);
  const { g, setG, playing, setPlaying, speed, setSpeed } = usePlayback(!explaining, held);
  const [view, setView] = useState({ persona: 'fan', follow: 'neutral', player: '', lang: 'en' });
  const [selectedId, setSelectedId] = useState(null);
  // Captions from the Foundry agent pipeline when a trace is published with
  // the site; otherwise (or on request) from the built-in test narrator.
  const [agentTrace, setAgentTrace] = useState(null);
  const [source, setSource] = useState('test');
  useEffect(() => {
    loadAgentTrace(B.match, B.endG).then(trace => {
      if (trace) { setAgentTrace(trace); setSource('agents'); }
    });
  }, []);
  const decisions = source === 'agents' && agentTrace ? agentTrace.decisions : B.trace.decisions;
  const recaps = (source === 'agents' && agentTrace ? agentTrace.recaps : B.trace.recaps) ?? [];
  const [closedRecap, setClosedRecap] = useState(null);
  const sourceControl = { kind: source, agentTrace, onChange: value => { setSource(value); setSelectedId(null); } };

  const idx = indexAt(B.eventG, g);
  const observed = useMemo(() => B.events.slice(0, idx + 1), [idx]);
  const stats = useMemo(() => matchStats(observed), [observed]);

  const aired = useMemo(() => decisions.filter(d => d.g <= g), [decisions, g]);
  const airedNewestFirst = useMemo(() => [...aired].reverse(), [aired]);
  const summary = useMemo(() => summarise(aired), [aired]);
  const latest = aired.at(-1);
  const hold = latest?.insight?.aired ? WITH_LINE_HOLD_S : CAPTION_HOLD_S;
  const onAir = latest && g - latest.g <= hold ? latest : null;
  // The line of context airs after its caption, in English only: the other
  // languages are rendered from checked facts, and a line is free text.
  const insight = onAir?.insight?.aired && g >= onAir.insight.g && view.lang === 'en' ? onAir.insight.aired.text : null;
  const recapsAired = useMemo(() => recaps.filter(r => r.g <= g), [recaps, g]);
  const lastRecap = recapsAired.at(-1);
  const recapOnAir = lastRecap && lastRecap.id !== closedRecap
    && (lastRecap.recap === 'HT' ? g < B.halfG.start2 : g >= B.endG - 1) ? lastRecap : null;
  const selected = selectedId ? decisions.find(d => d.id === selectedId) : null;
  const reviewed = selected || onAir;
  const phase = useOnAirPhase(onAir);
  held.current = phase === 'review';

  const renderAired = useCallback(d => renderCaption(d, d.verdict, PEOPLE, view), [view]);

  const ball = ballAt(idx, g);
  const actorEvent = recent(idx, e => ON_BALL.has(e.type) && e.player_id, 1, 6)[0];
  const actor = actorEvent ? { ...PEOPLE.players.get(actorEvent.player_id), side: actorEvent.side } : null;
  const trail = recent(idx, e => ON_BALL.has(e.type) && e.x != null, view.persona === 'analyst' ? 14 : 6, 40);
  const focus = view.player ? recent(idx, e => e.player_id === view.player && e.x != null, 6) : [];
  // Draw only the evidence that belongs to this moment (same half, within
  // 150 s); older supporting events, such as earlier goals behind a score
  // claim, stay in the VAR room list.
  const evidence = reviewed
    ? reviewed.verdict.evidence.map(id => B.byId.get(id))
      .filter(e => e && e.x != null && e.period === reviewed.period && Math.abs(e.t - reviewed.t) <= 150)
      .sort((a, b) => a.seq - b.seq)
    : [];
  const popEvent = recent(idx, e => (e.type === 'sprint' || e.type === 'shot') && g - B.eventG[e.seq - 1] < 4, 1, 4)[0];
  const pop = popEvent ? (popEvent.type === 'sprint' ? `${popEvent.top_speed_kmh} km/h` : `xG ${popEvent.xg.toFixed(2)}, ${popEvent.shot_speed_kmh} km/h`) : null;

  const focusPlayer = view.player ? PEOPLE.players.get(view.player) : null;
  const focusStats = useMemo(() => (view.player ? playerStats(observed, view.player) : null), [observed, view.player]);

  const keyMoments = useMemo(() => B.events.map((e, i) => ({ e, g: B.eventG[i] })).filter(({ e }) => e.type === 'goal')
    .map(({ e, g: eg }) => ({ label: `${e.display_minute} Goal, ${PEOPLE.name(e.scorer_id)}`, g: eg - 30 })), []);
  const nextCall = decisions.find(d => d.verdict.status !== 'VERIFY' && d.g > g + 1);

  const seek = useCallback(value => setG(Math.max(0, Math.min(B.endG, value))), [setG]);
  const inspect = useCallback(id => {
    const i = B.events.findIndex(e => e.id === id);
    if (i >= 0) { setPlaying(false); seek(B.eventG[i]); }
  }, [seek, setPlaying]);

  useEffect(() => {
    const onKey = e => {
      if (e.code === 'Space' && !['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(document.activeElement?.tagName)) {
        e.preventDefault();
        setPlaying(p => !p);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setPlaying]);

  return (
    <div className="app">
      <header className="masthead">
        <div className="wordmark" aria-label="CaptionVAR">Caption<span>VAR</span></div>
        <p className="tagline">AI match commentary, checked against the data before it airs.</p>
        <ViewerSettings view={view} setView={setView} teams={B.teams} players={PLAYERS} source={sourceControl} />
      </header>

      <main className="stage">
        <div className="broadcast">
          <div className="screen">
            <Pitch ball={ball} actor={actor} trail={trail} evidence={evidence} evidenceLabels={Boolean(selected)} focus={focus} pop={pop} teamColor={teamColor} analyst={view.persona === 'analyst'} />
            <ScoreBug teams={B.teams} score={stats.score} clock={clockLabel(g, B.halfG)} />
            {focusPlayer && focusStats && (
              <PlayerCard player={focusPlayer} stats={focusStats} team={B.teams[focusPlayer.side]} onClose={() => setView(v => ({ ...v, player: '' }))} />
            )}
            {phase === 'review' && onAir && <ReviewCard decision={onAir} text={renderAired(onAir)} />}
            {recapOnAir && phase !== 'review' && <RecapCard recap={recapOnAir} onClose={() => setClosedRecap(recapOnAir.id)} />}
            {!recapOnAir && <LowerThird decision={onAir} text={onAir ? renderAired(onAir) : ''} lang={view.lang} phase={phase} insight={insight} />}
          </div>

          <div className="transport">
            <button type="button" className="play" onClick={() => setPlaying(p => !p)} aria-label={playing ? 'Pause' : 'Play'}>
              {playing ? <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="2" width="3.5" height="12" /><rect x="9.5" y="2" width="3.5" height="12" /></svg>
                : <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2l10 6-10 6z" /></svg>}
            </button>
            <label className="speed">
              <span className="sr-only">Playback speed</span>
              <select value={speed} onChange={e => setSpeed(Number(e.target.value))}>
                {SPEEDS.map(s => <option key={s} value={s}>{s}× speed</option>)}
              </select>
            </label>
            <button
              type="button"
              className="next-call"
              disabled={!nextCall}
              onClick={() => { seek(nextCall.g - 4); setSelectedId(null); setPlaying(true); }}
            >
              Next VAR call<span aria-hidden="true"> ›</span>
            </button>
            <nav className="jumps" aria-label="Key moments">
              {keyMoments.map(m => (
                <button key={m.label} type="button" onClick={() => { seek(m.g); setSelectedId(null); setPlaying(true); }}>{m.label}</button>
              ))}
            </nav>
          </div>

          <Timeline events={B.events} eventG={B.eventG} endG={B.endG} halfG={B.halfG} decisions={aired} g={g} onSeek={seek} teamColor={teamColor} />

          {view.persona === 'analyst' && <StatsPanel stats={stats} teams={B.teams} />}
        </div>

        <VarRoom
          decisions={airedNewestFirst}
          recaps={recapsAired}
          liveId={onAir?.id}
          onExplain={() => { setPlaying(false); setExplaining(true); }}
          selectedId={selectedId}
          onSelect={id => { setSelectedId(id); if (id) setPlaying(false); }}
          summary={summary}
          people={PEOPLE}
          view={view}
          renderAired={renderAired}
          source={sourceControl}
          onInspect={inspect}
        />
      </main>

      {explaining && (
        <HowItWorks trace={agentTrace} onClose={() => { setExplaining(false); markIntroSeen(); setPlaying(true); }} />
      )}

      <footer className="colophon">
        <p>Built for the Microsoft × Premier League Inside the Game hackathon. All clubs, players and events are synthetic.</p>
        <p><a href="https://github.com/joelynli0110/captionvar-live-starter">Source on GitHub</a></p>
      </footer>
    </div>
  );
}
