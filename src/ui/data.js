/**
 * Builds everything the broadcast UI needs once, at load: the synthetic match
 * (generated in the browser from its seed), the VAR trace, and indexes for
 * fast lookup during playback.
 */
import { generateMatch } from '../sim/generateMatch.js';
import { buildTrace } from '../broadcast/trace.js';
import { globalT } from '../broadcast/narrator.js';
import adjudication from '../../docs/demo-adjudication.json';

export const DEMO = {
  matchSeed: 'captionvar-demo-6',
  narratorSeed: 'narrator-10',
  // Cold open: a few seconds before the 24' goal, whose first draft says 0-2.
  startAt: { period: 1, t: 23 * 60 + 25 },
  speed: 8,
};

export const VERDICT = {
  VERIFY: { label: 'Verified', air: 'VAR checked', decision: 'Checked', tone: 'ok' },
  QUALIFY: { label: 'Trimmed', air: 'VAR trimmed', decision: 'Detail removed', tone: 'trim' },
  WITHHOLD: { label: 'Withheld', air: 'VAR corrected', decision: 'Caption corrected', tone: 'stop' },
};

/**
 * The narrator's first draft and what the check flagged in it, false claims
 * first. Agent traces record this per attempt; for the built-in test narrator
 * it is read from the verdict.
 */
export function firstDraft(decision) {
  const rank = { contradicted: 0, unverifiable: 1 };
  const recorded = decision.attempts?.[0];
  const spanOf = c => c.span ?? decision.segments.filter(s => s.claim === c.id).map(s => s.text.trim()).join(' ');
  const flags = recorded?.flags
    ?? decision.verdict.claims.filter(c => c.status !== 'supported').map(c => ({ span: spanOf(c), status: c.status, note: c.note }));
  return {
    text: recorded?.text ?? decision.segments.map(s => s.text).join(''),
    flags: [...flags].sort((a, b) => (rank[a.status] ?? 2) - (rank[b.status] ?? 2)),
  };
}

/**
 * Load a trace produced by the agent pipeline (agents/run_match.py) if one is
 * published with the site. Returns null when absent or for a different match.
 */
/**
 * The headline result of the five-match comparison, read from the published
 * summary so the page and the file can never disagree: how many of the
 * narrator's own errors (confirmed by hand) each set-up kept off air.
 */
export async function loadBenchmark(url = `${import.meta.env.BASE_URL}traces/baselines-summary.json`) {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) return null;
    const r = (await res.json()).reported;
    if (!r) return null;
    const stopped = s => r[s].own_real - r[s].own_real_on_air;
    return {
      own: r.captionvar.own_real,
      judge: stopped('llm_judge'),
      selfCheck: stopped('self_check'),
      captionvar: stopped('captionvar'),
      matches: null,
    };
  } catch {
    return null;
  }
}

/** ?trace=<file> replays another trace from public/traces (for example an offline run). */
function traceUrl() {
  let name = 'foundry-demo.json';
  try {
    const asked = new URLSearchParams(window.location.search).get('trace');
    if (asked && /^[\w.-]+\.json$/.test(asked)) name = asked;
  } catch { /* no window */ }
  return `${import.meta.env.BASE_URL}traces/${name}`;
}

/**
 * When lines of context and recaps air on the replay clock: as late as they did
 * in the recorded run. The full-time recap airs at the final whistle, where
 * playback stops.
 */
export function placeLines(trace, endG) {
  for (const d of trace.decisions) {
    if (d.insight) d.insight.g = globalT(d) + (d.insight.timing?.time_to_air_s ?? 6);
  }
  for (const r of trace.recaps ?? []) {
    r.g = Math.min(endG, globalT(r) + (r.timing?.time_to_air_s ?? 4));
  }
  return trace;
}

export async function loadAgentTrace(match, endG, url = traceUrl()) {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) return null;
    const trace = await res.json();
    if (trace.match_id !== match.meta.match_id || !Array.isArray(trace.decisions)) return null;
    // Each caption airs as late as it did in the recorded run, when the run
    // measured it; older traces fall back to a fixed two seconds.
    trace.decisions = trace.decisions.map(d => ({
      ...d,
      g: globalT(d) + (d.timing?.time_to_air_s ?? 2),
      own_error: ownError(trace, d.id),
      insight: d.insight && plantNotPresent(trace, d.id) ? { ...d.insight, planted_error: { ...d.insight.planted_error, not_present: true } } : d.insight,
    }));
    return placeLines(trace, endG);
  } catch {
    return null;
  }
}

/**
 * The narrator's own (unplanted) errors in the published Foundry run, as
 * checked by hand against the raw events (docs/demo-adjudication.json). Only
 * cases judged "real" count; extractor mix-ups the referee flagged are false
 * alarms.
 */
function ownError(trace, id) {
  // A new run of the same match has different drafts, so its captions are not
  // tagged until it is checked again.
  const run = adjudication.run;
  if (trace.source !== 'foundry-agents' || trace.settings?.match_seed !== run.match_seed || trace.generated_at !== run.generated_at) return null;
  const entry = adjudication.cases[id];
  return entry?.[0] === 'real' ? entry[1] : null;
}

/**
 * Red-team instructions the Analyst did not follow (checked by hand): the line
 * it wrote has no planted error in it, so it is not counted as caught or missed.
 */
function plantNotPresent(trace, id) {
  const run = adjudication.run;
  if (trace.generated_at !== run.generated_at) return false;
  return Boolean(adjudication.lines?.planted_not_present?.[id]);
}

export function loadBroadcast() {
  const match = generateMatch({ seed: DEMO.matchSeed });
  const trace = buildTrace(match, { seed: DEMO.narratorSeed });
  const events = match.events;
  const eventG = events.map(globalT);
  const byId = new Map(events.map(e => [e.id, e]));
  const endG = eventG.at(-1);
  placeLines(trace, endG);
  const halfG = { start2: globalT({ period: 2, t: 2700 }), end1: eventG[events.findIndex(e => e.type === 'period_end')] };
  const moments = events.filter(e => e.type === 'goal' || e.type === 'card');
  return {
    match, trace, events, eventG, byId, endG, halfG, moments,
    startG: startAt(halfG, endG),
    teams: match.squads,
  };
}

/**
 * Where playback starts: the demo default, or ?at=<minute>, ?at=HT (the break)
 * or ?at=FT (just before the final whistle), for recording or linking a moment.
 */
function startAt(halfG, endG) {
  let at = null;
  try { at = new URLSearchParams(window.location.search).get('at'); } catch { /* no window */ }
  if (at === 'HT') return halfG.end1 + 1;
  if (at === 'FT') return endG - 20;
  const minute = Number(at);
  if (at && Number.isFinite(minute) && minute >= 0 && minute <= 95) {
    return globalT(minute < 45 ? { period: 1, t: minute * 60 } : { period: 2, t: minute * 60 });
  }
  return globalT(DEMO.startAt);
}

/** Index of the last event at or before global time g. */
export function indexAt(eventG, g) {
  let lo = 0;
  let hi = eventG.length - 1;
  if (g < eventG[0]) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (eventG[mid] <= g) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** Match clock for a global time (inverse of globalT); 'HT' during the break. */
export function clockLabel(g, halfG) {
  if (g <= halfG.end1) return formatClock(Math.max(0, g), 1);
  if (g < halfG.start2) return 'HT';
  return formatClock(g - 600, 2);
}

export function formatClock(t, period) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const regular = period === 1 ? 45 : 90;
  if (m >= regular) return `${regular}+${m - regular + 1}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
