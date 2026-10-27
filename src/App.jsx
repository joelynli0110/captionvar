import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadBroadcast, loadAgentTrace, loadBenchmark, indexAt, clockLabel, placeLines, DEMO } from './ui/data.js';
import { buildTrace } from './broadcast/trace.js';
import { LANGUAGES, onAir as onAirLabels } from './broadcast/render.js';
import { cue, unlockAudio } from './ui/sound.js';
import { speak, hush, voiceSupported } from './ui/voice.js';
import { matchStats, playerStats } from './sim/stats.js';
import { renderCaption } from './broadcast/render.js';
import Pitch from './ui/Pitch.jsx';
import { ScoreBug, LowerThird, VarCheck, RecapCard, useOnAirPhase, scoreCall, reduceMotion, REWIND_MS, REPLAY_MS, STAMP_MS } from './ui/Broadcast.jsx';
import VarRoom from './ui/VarRoom.jsx';
import Timeline from './ui/Timeline.jsx';
import { ViewerSettings, StatsPanel, PlayerCard, FeedSwitch, Scoreboard, PlayAlong, FanSplit } from './ui/Panels.jsx';
import HowItWorks from './ui/HowItWorks.jsx';
import { tagFor, tagNote } from './broadcast/overlays.js';

const B = loadBroadcast();
const PEOPLE = B.trace.people;
const PLAYERS = [...PEOPLE.players.values()];
const ON_BALL = new Set(['pass', 'carry', 'shot', 'recovery', 'tackle', 'interception', 'clearance', 'save', 'block', 'foul']);
const CAPTION_HOLD_S = 45; // match seconds a caption stays in the lower third
const WITH_LINE_HOLD_S = 70; // longer when a line of context follows it
const SPEEDS = [2, 4, 8, 16, 32];
const TAG_REAL_S = 2.8; // real seconds a player tag stays on screen, whatever the playback speed
const SHAPE_WINDOW_S = 240; // match seconds a player's last touch still marks where he is

const teamColor = side => B.teams[side].colors.primary;

/** Tags shown without following a player: every shot, and the standout passes only. */
const STANDOUT_PASS = { difficulty: 0.8, distance_m: 55 };
const standout = e => e.type === 'shot'
  || (e.type === 'pass' && (e.difficulty >= STANDOUT_PASS.difficulty || e.distance_m >= STANDOUT_PASS.distance_m));

/**
 * One hint at a time, for a first-time viewer: after the first VAR check,
 * open its record; after that, go to the next call; then nothing.
 */
const HINT = { WAIT: 'wait', ROW: 'row', NEXT: 'next', DONE: 'done' };

/** First visit shows the explainer before play starts; ?intro=0 skips it. */
/** The page opens on the match itself; ?intro=1 opens the team sheet first. */
function introWanted() {
  try {
    return new URLSearchParams(window.location.search).get('intro') === '1';
  } catch {
    return false;
  }
}
const param = name => { try { return new URLSearchParams(window.location.search).get(name); } catch { return null; } };
const DEFAULT_RATE = 0.38; // the test narrator's default plant rate (narrate in narrator.js)
// Two fans watching the same checked caption, each in their own language.
const FANS = [
  { key: 'home', follow: 'home', lang: 'en' },
  { key: 'away', follow: 'away', lang: 'zh' },
];

function loadFlag(key) {
  try { return window.localStorage.getItem(key) === '1'; } catch { return false; }
}
function saveFlag(key, on) {
  try { window.localStorage.setItem(key, on ? '1' : '0'); } catch { /* storage unavailable */ }
}

/**
 * The VAR replay: while the decision is reviewed, the pitch runs back to the
 * first piece of evidence and plays the move again, slowed down. Returns the
 * match time to draw the pitch at, or null when the pitch shows live play.
 */
function useReplay(active, from, to) {
  const [state, setState] = useState(null);
  useEffect(() => {
    if (!active || reduceMotion() || !(to > from)) { setState(null); return undefined; }
    let frame;
    const t0 = performance.now();
    const tick = now => {
      const el = now - t0;
      if (el < REWIND_MS) {
        const f = 1 - (1 - el / REWIND_MS) ** 2;
        setState({ g: to + (from - to) * f, mode: 'rewind' });
      } else if (el < REWIND_MS + REPLAY_MS) {
        setState({ g: from + (to - from) * ((el - REWIND_MS) / REPLAY_MS), mode: 'replay' });
      } else { setState(null); return; }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active, from, to]);
  return state;
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

/**
 * Where each player last touched the ball in the last few minutes of this
 * half. Positions are not tracked in the feed, so this is an honest stand-in
 * for the team shapes: drawn faint, and only for players seen recently.
 */
function lastTouches(idx) {
  const now = B.events[Math.max(0, idx)];
  const seen = new Map();
  for (let i = idx; i >= 0 && i > idx - 700; i -= 1) {
    const e = B.events[i];
    if (e.period !== now.period || now.t - e.t > SHAPE_WINDOW_S) break;
    if (e.player_id && e.x != null && !seen.has(e.player_id)) {
      seen.set(e.player_id, { id: e.player_id, side: e.side, x: e.x, y: e.y, age: (now.t - e.t) / SHAPE_WINDOW_S, number: PEOPLE.players.get(e.player_id)?.number });
    }
  }
  return [...seen.values()];
}

/** Where to draw a tag: the event, or for events without a position the player's last touch. */
function placeOf(e, shape) {
  if (e.x != null) return { x: e.x, y: e.y };
  const p = shape.find(s => s.id === e.player_id);
  return p ? { x: p.x, y: p.y } : null;
}

export default function App() {
  const [explaining, setExplaining] = useState(introWanted);
  const held = useRef(false);
  const { g, setG, playing, setPlaying, speed, setSpeed } = usePlayback(!explaining, held);
  const [view, setView] = useState({ persona: 'fan', follow: 'neutral', player: '', lang: 'en', feed: 'production' });
  const [selectedId, setSelectedId] = useState(null);
  // Captions from the Foundry agent pipeline when a trace is published with
  // the site; otherwise (or on request) from the built-in test narrator.
  const [agentTrace, setAgentTrace] = useState(null);
  const [source, setSource] = useState('test');
  // The red team's plant rate rebuilds the test narrator's trace in the browser.
  const [testTrace, setTestTrace] = useState(B.trace);
  const [rate, setRate] = useState(DEFAULT_RATE);
  const rateTimer = useRef(null);
  const changeRate = useCallback(r => {
    setRate(r);
    clearTimeout(rateTimer.current);
    rateTimer.current = setTimeout(() => {
      const t = buildTrace(B.match, { seed: DEMO.narratorSeed, errorRate: r });
      placeLines(t, B.endG);
      setTestTrace(t);
      setSource('test');
      setSelectedId(null);
    }, 200);
  }, []);
  // Beat the VAR, and the cue sounds.
  const [game, setGame] = useState(() => param('game') === '1');
  const [flagged, setFlagged] = useState(() => new Set());
  const [calls, setCalls] = useState(() => new Map());
  const [sound, setSound] = useState(() => loadFlag('captionvar-sound'));
  const [voice, setVoice] = useState(() => voiceSupported() && loadFlag('captionvar-voice'));
  const spoken = useRef({ caption: null, insight: null, recap: null });
  const [benchmark, setBenchmark] = useState(null);
  useEffect(() => { loadBenchmark().then(setBenchmark); }, []);
  useEffect(() => {
    loadAgentTrace(B.match, B.endG).then(trace => {
      if (trace) { setAgentTrace(trace); setSource('agents'); }
    });
  }, []);
  const decisions = source === 'agents' && agentTrace ? agentTrace.decisions : testTrace.decisions;
  const recaps = (source === 'agents' && agentTrace ? agentTrace.recaps : testTrace.recaps) ?? [];
  const [closedRecap, setClosedRecap] = useState(null);
  const sourceControl = { kind: source, agentTrace, onChange: value => { setSource(value); setSelectedId(null); } };

  const idx = indexAt(B.eventG, g);
  const observed = useMemo(() => B.events.slice(0, idx + 1), [idx]);
  const stats = useMemo(() => matchStats(observed), [observed]);

  const aired = useMemo(() => decisions.filter(d => d.g <= g), [decisions, g]);
  const airedNewestFirst = useMemo(() => [...aired].reverse(), [aired]);
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
  const production = view.feed === 'production';
  // Beat the VAR: a fresh caption waits for the viewer's call before its check.
  const awaiting = game && production && Boolean(onAir) && !selected && !calls.has(onAir) && g - onAir.g < 8;
  const phase = useOnAirPhase(production ? onAir : null, awaiting);
  held.current = phase === 'review' || phase === 'guess';
  const varMoment = phase === 'review' && Boolean(onAir);
  useEffect(() => { setFlagged(new Set()); }, [onAir]);

  const [hint, setHint] = useState({ step: HINT.WAIT, id: null });
  const lastPhase = useRef(phase);
  useEffect(() => {
    if (lastPhase.current === 'review' && phase === 'aired' && onAir && hint.step === HINT.WAIT) setHint({ step: HINT.ROW, id: onAir.id });
    lastPhase.current = phase;
  }, [phase, onAir, hint.step]);
  const callResult = game && onAir ? calls.get(onAir) ?? null : null;
  const tally = useMemo(() => {
    const all = [...calls.values()];
    const sum = k => all.reduce((n, r) => n + r[k], 0);
    return { calls: all.length, right: all.filter(r => r.right).length, caught: sum('caught'), total: sum('total'), falseAlarms: sum('falseAlarms') };
  }, [calls]);
  const gameControls = awaiting ? {
    flagged,
    onToggle: id => setFlagged(f => { const n = new Set(f); if (n.has(id)) n.delete(id); else n.add(id); return n; }),
    onLock: () => setCalls(m => new Map(m).set(onAir, scoreCall(onAir, flagged))),
  } : null;

  // The replay runs from a few seconds before the first piece of evidence.
  const replayFrom = useMemo(() => {
    if (!varMoment) return 0;
    const gs = onAir.verdict.evidence.map(id => B.byId.get(id))
      .filter(e => e && e.x != null && e.period === onAir.period && Math.abs(e.t - onAir.t) <= 150)
      .map(e => B.eventG[e.seq - 1]);
    const first = gs.length ? Math.min(...gs) - 3 : g - 12;
    return Math.max(g - 40, Math.min(g - 6, first));
  }, [varMoment, onAir, g]);
  const replay = useReplay(varMoment, replayFrom, g);
  const pg = replay ? replay.g : g; // the time the pitch is drawn at
  const pidx = indexAt(B.eventG, pg);

  // Cue sounds: the check, the rewind, the stamp; and the viewer's result.
  useEffect(() => {
    if (!sound) return undefined;
    if (phase === 'review') {
      cue('check');
      const timers = [setTimeout(() => cue('rewind'), 250), setTimeout(() => cue('stamp'), STAMP_MS)];
      return () => timers.forEach(clearTimeout);
    }
    return undefined;
  }, [phase, sound]);
  useEffect(() => {
    if (sound && phase === 'aired' && callResult) cue(callResult.right ? 'win' : 'miss');
  }, [phase, sound, callResult]);

  // The voice reads only what airs: the caption once its check is done (never
  // the draft), then its line of context, and each recap's checked sentences.
  const airedText = onAir && phase === 'aired' ? renderCaption(onAir, onAir.verdict, PEOPLE, view) : null;
  useEffect(() => {
    if (!voice || !airedText || spoken.current.caption === airedText) return;
    spoken.current.caption = airedText;
    speak(airedText, view.lang);
  }, [voice, airedText, view.lang]);
  useEffect(() => {
    if (!voice || !insight || phase !== 'aired' || spoken.current.insight === insight) return;
    spoken.current.insight = insight;
    speak(insight, 'en', { interrupt: false });
  }, [voice, insight, phase]);
  useEffect(() => {
    if (!voice || !recapOnAir || spoken.current.recap === recapOnAir) return;
    spoken.current.recap = recapOnAir;
    speak(recapOnAir.aired_text, 'en');
  }, [voice, recapOnAir]);
  useEffect(() => { if (!voice) hush(); }, [voice]);

  const renderAired = useCallback(d => renderCaption(d, d.verdict, PEOPLE, view), [view]);

  const ball = ballAt(pidx, pg);
  const actorEvent = recent(pidx, e => ON_BALL.has(e.type) && e.player_id, 1, 6)[0];
  const actor = actorEvent ? { ...PEOPLE.players.get(actorEvent.player_id), side: actorEvent.side } : null;
  // The move in progress: every touch of the current possession, in order.
  const possession = ball?.event?.possession_id;
  const chain = useMemo(
    () => recent(pidx, e => ON_BALL.has(e.type) && e.x != null && e.possession_id === possession, view.persona === 'analyst' ? 14 : 8, 60),
    [pidx, possession, view.persona],
  );
  const trail = chain.length >= 2 ? chain : recent(pidx, e => ON_BALL.has(e.type) && e.x != null, 6, 40);
  const shape = useMemo(() => lastTouches(pidx), [pidx]);
  const focus = view.player ? recent(pidx, e => e.player_id === view.player && e.x != null, 6) : [];
  // Draw only the evidence that belongs to this moment (same half, within
  // 150 s); older supporting events, such as earlier goals behind a score
  // claim, stay in the VAR room list.
  const evidence = reviewed && production
    ? reviewed.verdict.evidence.map(id => B.byId.get(id))
      .filter(e => e && e.x != null && e.period === reviewed.period && Math.abs(e.t - reviewed.t) <= 150)
      .sort((a, b) => a.seq - b.seq)
    : [];
  // A player tag when an event crosses a threshold (sprint, long or difficult pass, shot, distance).
  const tagEvent = recent(idx, e => g - B.eventG[e.seq - 1] <= TAG_REAL_S * speed && tagFor(e, PEOPLE), 1, 30)[0];
  const tagWanted = tagEvent && production && !varMoment && (
    (view.player && tagEvent.player_id === view.player) || standout(tagEvent));
  const tagBase = tagWanted ? tagFor(tagEvent, PEOPLE) : null;
  const tag = tagBase ? { ...tagBase, note: tagNote(tagBase, view.lang), at: placeOf(tagEvent, shape) } : null;

  // Two fans: the caption on air, rendered for each from the same checked facts.
  const fans = FANS.map(f => ({
    ...f,
    label: onAirLabels(f.lang).fan(B.teams[f.follow].short_name),
    langName: LANGUAGES.find(l => l.code === f.lang)?.label ?? f.lang,
    color: teamColor(f.follow),
  }));
  const fanLines = onAir && view.feed === 'fans' ? FANS.map(f => renderCaption(onAir, onAir.verdict, PEOPLE, { ...view, persona: 'fan', follow: f.follow, lang: f.lang })) : null;

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
    <div className={`app${varMoment ? ' is-var-moment' : ''}`}>
      <header className="masthead">
        <div className="wordmark" aria-label="CaptionVAR">Caption<span>VAR</span></div>
        <p className="tagline">AI match commentary, checked against the data before it airs.</p>
        <div className="mast-controls">
          <FeedSwitch value={view.feed} onChange={feed => setView(v => ({ ...v, feed }))} />
          <ViewerSettings
            view={view} setView={setView} teams={B.teams} players={PLAYERS} source={sourceControl}
            speed={speed} speeds={SPEEDS} onSpeed={setSpeed}
            moments={keyMoments} onJump={m => { seek(m.g); setSelectedId(null); setPlaying(true); }}
          />
        </div>
      </header>
      {benchmark && <Scoreboard result={benchmark} />}

      <main className="stage">
        <div className="broadcast">
          <div className={`screen${varMoment ? ' is-var' : ''}${replay?.mode === 'rewind' ? ' is-rewind' : ''}${view.feed === 'fans' ? ' is-fans' : ''}`}>
            <Pitch ball={ball} actor={actor} trail={trail} shape={shape} evidence={evidence} evidenceLabels={Boolean(selected)} drawEvidence={varMoment} quiet={varMoment} people={PEOPLE} focus={focus} tag={tag} teamColor={teamColor} />
            <ScoreBug teams={B.teams} score={stats.score} clock={clockLabel(g, B.halfG)} />
            {focusPlayer && focusStats && !varMoment && (
              <PlayerCard player={focusPlayer} stats={focusStats} team={B.teams[focusPlayer.side]} onClose={() => setView(v => ({ ...v, player: '' }))} />
            )}
            {varMoment && <VarCheck decision={onAir} clock={clockLabel(g, B.halfG)} replay={replay?.mode ?? null} />}
            {recapOnAir && phase !== 'review' && <RecapCard recap={recapOnAir} onClose={() => setClosedRecap(recapOnAir.id)} />}
            {!recapOnAir && view.feed !== 'fans' && <LowerThird decision={onAir} text={onAir ? renderAired(onAir) : ''} lang={view.lang} phase={phase} insight={insight} feed={view.feed} game={gameControls} result={callResult} />}
            {!recapOnAir && fanLines && <FanSplit fans={fans} lines={fanLines} minute={onAir.display_minute} />}
            {production ? <span className="feed-bug">Production · not on air</span> : <span className="feed-bug is-viewer">{view.feed === 'fans' ? 'Two viewer feeds' : 'Viewer feed'}</span>}
          </div>

          <div className="transport">
            <button type="button" className="play" onClick={() => setPlaying(p => !p)} aria-label={playing ? 'Pause' : 'Play'}>
              {playing ? <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="2" width="3.5" height="12" /><rect x="9.5" y="2" width="3.5" height="12" /></svg>
                : <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2l10 6-10 6z" /></svg>}
            </button>
            <button
              type="button"
              className="next-call"
              disabled={!nextCall}
              onClick={() => { seek(nextCall.g - 4); setSelectedId(null); setPlaying(true); if (hint.step !== HINT.DONE) setHint({ step: HINT.DONE, id: null }); }}
            >
              Next VAR call<span aria-hidden="true"> ›</span>
            </button>
            {hint.step === HINT.NEXT && nextCall && <span className="hint hint-next" role="note">← See the next error it stops</span>}
          </div>

          <Timeline events={B.events} eventG={B.eventG} endG={B.endG} halfG={B.halfG} decisions={aired} g={g} onSeek={seek} teamColor={teamColor} />

          <PlayAlong
            game={game}
            onGame={on => { setGame(on); if (on) setView(v => ({ ...v, feed: 'production' })); }}
            tally={tally}
            rate={rate}
            onRate={changeRate}
            sound={sound}
            onSound={on => { if (on) unlockAudio(); setSound(on); saveFlag('captionvar-sound', on); }}
            voice={voice}
            onVoice={voiceSupported() ? on => { setVoice(on); saveFlag('captionvar-voice', on); if (on) speak('Commentary on. Only checked captions are read out.', 'en'); } : null}
            agentsOn={source === 'agents' && Boolean(agentTrace)}
          />

          {view.persona === 'analyst' && <StatsPanel stats={stats} teams={B.teams} />}
        </div>

        <VarRoom
          decisions={airedNewestFirst}
          recaps={recapsAired}
          liveId={onAir?.id}
          onExplain={() => { setPlaying(false); setExplaining(true); }}
          selectedId={selectedId}
          onSelect={id => { setSelectedId(id); if (id) setPlaying(false); if (id && hint.step === HINT.ROW) setHint({ step: HINT.NEXT, id: null }); }}
          hintId={hint.step === HINT.ROW ? hint.id : null}
          people={PEOPLE}
          view={view}
          renderAired={renderAired}
          onInspect={inspect}
        />
      </main>

      {explaining && (
        <HowItWorks trace={agentTrace} result={benchmark} onClose={() => { setExplaining(false); markIntroSeen(); setPlaying(true); }} />
      )}

      <footer className="colophon">
        <p>Built for the Microsoft × Premier League Inside the Game hackathon. All clubs, players and events are synthetic.</p>
        <p><a href="https://github.com/joelynli0110/captionvar">Source on GitHub</a></p>
      </footer>
    </div>
  );
}
