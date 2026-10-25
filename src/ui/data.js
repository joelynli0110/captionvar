/**
 * Builds everything the broadcast UI needs once, at load: the synthetic match
 * (generated in the browser from its seed), the VAR trace, and indexes for
 * fast lookup during playback.
 */
import { generateMatch } from '../sim/generateMatch.js';
import { buildTrace } from '../broadcast/trace.js';
import { globalT } from '../broadcast/narrator.js';
import adjudication from '../../docs/eval-adjudication.json';

export const DEMO = {
  matchSeed: 'captionvar-demo-6',
  narratorSeed: 'narrator-10',
  startAt: { period: 2, t: 72 * 60 + 30 },
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
export async function loadAgentTrace(match, url = `${import.meta.env.BASE_URL}traces/foundry-demo.json`) {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) return null;
    const trace = await res.json();
    if (trace.match_id !== match.meta.match_id || !Array.isArray(trace.decisions)) return null;
    const seed = trace.settings?.match_seed;
    // Each caption airs as late as it did in the recorded run, when the run
    // measured it; older traces fall back to a fixed two seconds.
    trace.decisions = trace.decisions.map(d => ({
      ...d,
      g: globalT(d) + (d.timing?.time_to_air_s ?? 2),
      own_error: ownError(seed, d.id),
    }));
    return trace;
  } catch {
    return null;
  }
}

/**
 * The narrator's own (unplanted) errors in a Foundry run, as checked by hand
 * against the raw events (docs/eval-adjudication.json). Only cases judged
 * "real" count; extractor mix-ups the referee flagged are false alarms.
 */
function ownError(seed, id) {
  const entry = seed ? adjudication[`${seed} ${id}`] : null;
  return entry?.[0] === 'real' ? entry[1] : null;
}

export function loadBroadcast() {
  const match = generateMatch({ seed: DEMO.matchSeed });
  const trace = buildTrace(match, { seed: DEMO.narratorSeed });
  const events = match.events;
  const eventG = events.map(globalT);
  const byId = new Map(events.map(e => [e.id, e]));
  const endG = eventG.at(-1);
  const halfG = { start2: globalT({ period: 2, t: 2700 }), end1: eventG[events.findIndex(e => e.type === 'period_end')] };
  const moments = events.filter(e => e.type === 'goal' || e.type === 'card');
  return {
    match, trace, events, eventG, byId, endG, halfG, moments,
    startG: globalT(DEMO.startAt),
    teams: match.squads,
  };
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
