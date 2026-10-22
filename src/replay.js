/** CaptionVAR v0.5: browser-side, deterministic replay of synthetic events. */
export const eventTime = event => event.minute * 60 + event.second;
export const scenarioTime = scenario => scenario.minute * 60 + scenario.second;
export const timeLabel = t => `${String(Math.floor(t / 60)).padStart(2,'0')}:${String(Math.floor(t % 60)).padStart(2,'0')}`;

export function replayWindow(scenario) {
  const end = scenarioTime(scenario);
  return {start: Math.max(0, end - 90), end};
}

export function sortedEvents(scenario) {
  return [...(scenario.events || [])].sort((a,b) => eventTime(a)-eventTime(b) || a.id.localeCompare(b.id));
}

export function visibleEvents(scenario, currentTime) {
  const {start,end} = replayWindow(scenario);
  const limitedTime = Math.min(end, Math.max(start, currentTime));
  return sortedEvents(scenario).filter(e=>eventTime(e)>=start && eventTime(e)<=limitedTime);
}

export function eventById(scenario, id) {
  return (scenario.events || []).find(e=>e.id===id) || null;
}

export function evidenceGroups(scenario, result) {
  const ids = new Set(result.evidence || []);
  const supporting = sortedEvents(scenario).filter(e=>ids.has(e.id));
  const related = sortedEvents(scenario).filter(e=>!ids.has(e.id));
  return {supporting,related};
}

export function eventPosition(event) {
  if (!Number.isFinite(event.x) || !Number.isFinite(event.y) ||
      event.x < 0 || event.x > 100 || event.y < 0 || event.y > 100) return null;
  return {x:27 + 486 * event.x/100, y:24 + 241 * event.y/100};
}
