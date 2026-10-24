/**
 * Live replay of a generated match.
 *
 * The match is generated up front (so it is reproducible), then released
 * event by event on the match clock, which is what the "Ingest" stage of the
 * pipeline consumes. Works in Node and in the browser (no dependencies).
 *
 *   for await (const ev of liveFeed(match, { speed: 20 })) { ... }
 *
 * speed = match seconds per wall-clock second (1 = real time, 0 = no waiting).
 * Half-time is compressed to `halfTimePauseMs`.
 */

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (ms <= 0) return resolve();
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason ?? new Error('aborted')); }, { once: true });
});

export async function* liveFeed(match, { speed = 20, fromSeq = 1, toSeq = Infinity, halfTimePauseMs = 1500, signal } = {}) {
  let prev = null;
  for (const ev of match.events) {
    if (ev.seq < fromSeq) continue;
    if (ev.seq > toSeq) return;
    if (signal?.aborted) return;
    if (prev && speed > 0) {
      const gap = ev.period === prev.period ? ev.t - prev.t : halfTimePauseMs / 1000 * speed;
      await sleep((Math.max(0, gap) / speed) * 1000, signal);
    }
    prev = ev;
    yield ev;
  }
}

/**
 * Group the stream into fixed match-clock windows (e.g. every 60 s), the unit
 * at which narrator agents are asked for a new caption. Each window carries
 * the events inside it plus every event observed so far.
 */
export async function* windowedFeed(feed, { windowSeconds = 60 } = {}) {
  const seen = [];
  let bucket = [];
  let windowStart = null;
  let period = null;
  for await (const ev of feed) {
    if (windowStart === null || ev.period !== period) {
      if (bucket.length) yield { period, from: windowStart, to: bucket.at(-1).t, events: bucket, observed: [...seen] };
      bucket = [];
      period = ev.period;
      windowStart = Math.floor(ev.t / windowSeconds) * windowSeconds;
    }
    while (ev.t >= windowStart + windowSeconds) {
      if (bucket.length) yield { period, from: windowStart, to: windowStart + windowSeconds, events: bucket, observed: [...seen] };
      bucket = [];
      windowStart += windowSeconds;
    }
    seen.push(ev);
    bucket.push(ev);
  }
  if (bucket.length) yield { period, from: windowStart, to: bucket.at(-1).t, events: bucket, observed: [...seen] };
}
