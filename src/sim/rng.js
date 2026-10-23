/**
 * Seeded pseudo-random helpers. Every generated match is reproducible from
 * its seed, which lets evaluation fixtures and demo videos refer to the
 * exact same event IDs on every run.
 */

/** mulberry32: small, fast, good enough for simulation (not for crypto). */
export function createRng(seed) {
  let a = hashSeed(seed) >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    /** Uniform float in [0, 1). */
    next,
    /** Uniform float in [min, max). */
    range: (min, max) => min + (max - min) * next(),
    /** Uniform integer in [min, max]. */
    int: (min, max) => Math.floor(min + (max - min + 1) * next()),
    /** True with probability p. */
    chance: p => next() < p,
    /** Approximately normal sample (Box-Muller). */
    normal: (mean = 0, sd = 1) => {
      const u = 1 - next();
      const v = next();
      return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    /** Pick one item uniformly. */
    pick: items => items[Math.floor(next() * items.length)],
    /**
     * Pick a key from {key: weight}. Zero or negative weights are ignored.
     * Returns null when no positive weight exists.
     */
    weighted: weights => {
      const entries = Object.entries(weights).filter(([, w]) => w > 0);
      const total = entries.reduce((sum, [, w]) => sum + w, 0);
      if (!total) return null;
      let r = next() * total;
      for (const [key, w] of entries) {
        r -= w;
        if (r < 0) return key;
      }
      return entries[entries.length - 1][0];
    },
    /** Like weighted(), but over an array with a weight function. */
    weightedItem: (items, weightOf) => {
      const weights = items.map(weightOf);
      const total = weights.reduce((sum, w) => sum + Math.max(0, w), 0);
      if (!total) return items[0];
      let r = next() * total;
      for (let i = 0; i < items.length; i += 1) {
        r -= Math.max(0, weights[i]);
        if (r < 0) return items[i];
      }
      return items[items.length - 1];
    },
  };
}

/** Accept numeric or string seeds ("demo-final" and 42 both work). */
function hashSeed(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return seed;
  let h = 2166136261;
  for (const ch of String(seed)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return h;
}
