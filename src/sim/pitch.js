/**
 * Pitch geometry.
 *
 * Two coordinate systems are used:
 *   - "attack" coordinates (ax, ay) in 0..100, relative to the team on the ball:
 *     ax = 0 is its own goal line, ax = 100 the goal it attacks.
 *   - "absolute" coordinates (x, y) in 0..100, fixed to the broadcast camera:
 *     the home team attacks towards x = 100 in the first half and x = 0 in
 *     the second. Published events always carry absolute coordinates so they
 *     can be drawn directly as an overlay.
 */

export const PITCH_LENGTH_M = 105;
export const PITCH_WIDTH_M = 68;

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const round = (v, digits = 1) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

/** Which way a side attacks in a given period: +1 towards x=100, -1 towards x=0. */
export function attackDirection(side, period) {
  const homeRight = period === 1;
  return (side === 'home') === homeRight ? 1 : -1;
}

export function toAbsolute(ax, ay, side, period) {
  const dir = attackDirection(side, period);
  return {
    x: round(dir === 1 ? ax : 100 - ax),
    y: round(dir === 1 ? ay : 100 - ay),
  };
}

/** Convert a point from one team's attack frame into the opponent's. */
export const flip = (ax, ay) => ({ ax: 100 - ax, ay: 100 - ay });

export function zoneOf(ax) {
  if (ax < 100 / 3) return 'defensive_third';
  if (ax < 200 / 3) return 'middle_third';
  return 'attacking_third';
}

/** Coarse channel used by narrators: left / centre / right from the attacker's view. */
export function channelOf(ay) {
  if (ay < 30) return 'left';
  if (ay > 70) return 'right';
  return 'centre';
}

/** Distance in metres between two attack-frame points. */
export function metres(a, b) {
  const dx = ((b.ax - a.ax) / 100) * PITCH_LENGTH_M;
  const dy = ((b.ay - a.ay) / 100) * PITCH_WIDTH_M;
  return Math.hypot(dx, dy);
}

/** Inside the opponent's penalty area (16.5 m deep, 40.3 m wide). */
export function inBox(ax, ay) {
  const depth = (16.5 / PITCH_LENGTH_M) * 100;
  const half = (20.15 / PITCH_WIDTH_M) * 100;
  return ax >= 100 - depth && Math.abs(ay - 50) <= half;
}

/** Distance (m) and opening angle (radians) of the goal from a shooting spot. */
export function shotGeometry(ax, ay) {
  const dx = ((100 - ax) / 100) * PITCH_LENGTH_M;
  const dy = ((ay - 50) / 100) * PITCH_WIDTH_M;
  const distance = Math.hypot(dx, dy);
  const halfGoal = 7.32 / 2;
  const angle = Math.abs(Math.atan2(halfGoal - dy, dx) - Math.atan2(-halfGoal - dy, dx));
  return { distance, angle };
}

/**
 * Simple, transparent expected-goals model (logistic on distance and angle,
 * with adjustments). Coefficients are hand-tuned so that typical open-play
 * shots land in public xG ranges: ~0.76 penalty, ~0.3-0.5 close central,
 * ~0.03 from 25 m. It is documented as a synthetic estimator, not Opta xG.
 */
export function expectedGoals({ ax, ay, bodyPart = 'foot', situation = 'open_play', underPressure = false }) {
  if (situation === 'penalty') return 0.76;
  const { distance, angle } = shotGeometry(ax, ay);
  let logit = -1.1 - 0.11 * distance + 1.9 * angle;
  if (bodyPart === 'head') logit -= 0.8;
  if (situation === 'free_kick') logit -= 0.6;
  if (situation === 'counter') logit += 0.35;
  if (underPressure) logit -= 0.35;
  return round(clamp(1 / (1 + Math.exp(-logit)), 0.01, 0.95), 2);
}
