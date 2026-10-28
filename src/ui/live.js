/**
 * Live mode: when the page is served by agents/live_server.py (it adds a
 * <meta name="captionvar-live"> marker), the agents can run on Foundry while
 * the viewer watches, and each decision is streamed over Server-Sent Events
 * in the same shape as a recorded trace. On GitHub Pages there is no marker,
 * so nothing here runs and no request is made.
 */
import { globalT } from '../broadcast/narrator.js';

const api = path => `${import.meta.env.BASE_URL}api/live/${path}`;

export function liveServed() {
  try {
    return Boolean(document.querySelector('meta[name="captionvar-live"]'));
  } catch {
    return false;
  }
}

/** What the live server can do right now, or null when the page is not served by it. */
export async function liveStatus() {
  if (!liveServed()) return null;
  try {
    const res = await fetch(api('status'), { cache: 'no-store' });
    const status = res.ok ? await res.json() : null;
    return status?.live ? status : null;
  } catch {
    return null;
  }
}

/** Start a run, or join the one in progress. Resolves to the server's status, with `available`. */
export async function startLive() {
  try {
    const res = await fetch(api('start'), { method: 'POST', cache: 'no-store' });
    return await res.json();
  } catch {
    return { available: false, reason: 'The live server did not answer. This is the recorded run.' };
  }
}

/** A streamed decision, placed on the replay clock exactly as a recorded one (data.js loadAgentTrace). */
export function placeLiveDecision(d, endG) {
  const g = globalT(d) + (d.timing?.time_to_air_s ?? 2);
  const insight = d.insight ? { ...d.insight, g: Math.min(endG, globalT(d) + (d.insight.timing?.time_to_air_s ?? 6)) } : undefined;
  return { ...d, g, own_error: null, ...(insight ? { insight } : {}) };
}

/** Fold one stream event into the live state. */
export function liveReducer(state, event, endG) {
  switch (event.type) {
    case 'start':
      return { ...state, model: event.model, source: event.source, cached: Boolean(event.cached), moments: event.moments, maxCalls: event.max_calls, decisions: [], done: false, reason: null };
    case 'decision': {
      const d = placeLiveDecision(event.decision, endG);
      const decisions = [...state.decisions.filter(x => x.id !== d.id), d].sort((a, b) => a.seq - b.seq);
      return { ...state, decisions, calls: event.calls };
    }
    case 'end':
      return { ...state, done: true, reason: event.reason, calls: event.usage?.llm_calls ?? state.calls };
    case 'unavailable':
    case 'error':
      return { ...state, done: true, unavailable: event.reason };
    default:
      return state;
  }
}

/** The first moment of the run whose decision has not arrived yet. */
export function pendingMoment(state) {
  if (!state || state.done || !state.moments) return null;
  const have = new Set(state.decisions.map(d => d.seq));
  return state.moments.find(m => !have.has(m.seq)) ?? null;
}

/** Open the stream; returns a function that closes it. */
export function streamLive(onEvent) {
  const es = new EventSource(api('stream'));
  let finished = false;
  for (const type of ['start', 'decision', 'end', 'unavailable']) {
    es.addEventListener(type, msg => {
      let event;
      try { event = JSON.parse(msg.data); } catch { return; }
      if (type === 'end' || type === 'unavailable') { finished = true; es.close(); }
      onEvent(event);
    });
  }
  // The browser reconnects on its own after a dropped connection, and the
  // server sends the run again from the start; decisions are keyed by id.
  es.onerror = () => {
    if (!finished && es.readyState === EventSource.CLOSED) {
      finished = true;
      onEvent({ type: 'error', reason: 'The live stream was lost. Showing what arrived.' });
    }
  };
  return () => { finished = true; es.close(); };
}
