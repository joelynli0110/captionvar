/**
 * Builds everything the broadcast UI needs once, at load: the synthetic match
 * (generated in the browser from its seed), the VAR trace, and indexes for
 * fast lookup during playback.
 */
import { generateMatch } from '../sim/generateMatch.js';
import { buildTrace } from '../broadcast/trace.js';
import { globalT } from '../broadcast/narrator.js';

export const DEMO = {
  matchSeed: 'captionvar-demo-6',
  narratorSeed: 'narrator-10',
  startAt: { period: 2, t: 72 * 60 + 30 },
  speed: 8,
};

export const VERDICT = {
  VERIFY: { label: 'Verified', air: 'VAR checked', tone: 'ok' },
  QUALIFY: { label: 'Trimmed', air: 'VAR trimmed', tone: 'trim' },
  WITHHOLD: { label: 'Withheld', air: 'VAR corrected', tone: 'stop' },
};

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
