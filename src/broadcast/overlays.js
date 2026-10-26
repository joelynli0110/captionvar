/**
 * Threshold-triggered player tags: the on-screen graphics a broadcast shows
 * when a moment crosses a predefined line (a sprint over 33 km/h, a 40 m
 * pass, a shot with its speed and xG, a distance milestone).
 *
 * They come straight from the event feed, not from a model, so they need no
 * VAR check. Each tag is machine-readable (kind, player, values, the
 * threshold that fired it) so a graphics renderer could draw it as an overlay
 * on the match feed; the demo draws it on the pitch.
 */
export const THRESHOLDS = {
  sprint_kmh: 33,
  long_pass_m: 40,
  difficult_pass: 0.6,
};

/** The tag an event triggers, or null. */
export function tagFor(e, people) {
  const name = id => people.name(id);
  switch (e.type) {
    case 'sprint':
      if (e.top_speed_kmh < THRESHOLDS.sprint_kmh) return null;
      return {
        kind: 'speed', event_id: e.id, player_id: e.player_id, side: e.side,
        title: name(e.player_id), value: `${e.top_speed_kmh.toFixed(1)} km/h`, note: 'top speed',
        threshold: `sprint ≥ ${THRESHOLDS.sprint_kmh} km/h`,
      };
    case 'shot':
      return {
        kind: 'shot', event_id: e.id, player_id: e.player_id, side: e.side,
        title: name(e.player_id), value: `xG ${e.xg.toFixed(2)}`, note: `${e.shot_speed_kmh} km/h shot`,
        threshold: 'every shot',
      };
    case 'pass': {
      if (!e.successful) return null;
      const long = e.distance_m >= THRESHOLDS.long_pass_m;
      const hard = e.difficulty >= THRESHOLDS.difficult_pass;
      if (!long && !hard) return null;
      return {
        kind: 'pass', event_id: e.id, player_id: e.player_id, side: e.side,
        title: `${name(e.player_id)} → ${name(e.recipient_id)}`,
        value: `${Math.round(e.distance_m)} m`,
        note: `${hard ? `difficult pass (${Math.round(e.difficulty * 100)}/100)` : 'long pass'} · ${e.ball_speed_kmh} km/h`,
        threshold: hard ? `difficulty ≥ ${THRESHOLDS.difficult_pass * 100}/100` : `pass ≥ ${THRESHOLDS.long_pass_m} m`,
      };
    }
    case 'physical_milestone':
      return {
        kind: 'distance', event_id: e.id, player_id: e.player_id, side: e.side,
        title: name(e.player_id), value: `${e.milestone_km} km`, note: 'covered so far',
        threshold: 'every km from 10 km',
      };
    default:
      return null;
  }
}

/** Every tag in a match, timed, for a renderer (or a test). */
export function overlayFeed(match, people) {
  return match.events.map(e => {
    const tag = tagFor(e, people);
    return tag && { period: e.period, t: e.t, display_minute: e.display_minute, x: e.x, y: e.y, ...tag };
  }).filter(Boolean);
}
