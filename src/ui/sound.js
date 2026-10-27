/**
 * Cue sounds for the VAR moment, synthesised in the browser with Web Audio:
 * no recorded audio, nothing to license. Off until the viewer turns it on
 * (browsers only allow sound after a click anyway).
 */
let ctx = null;

function audio() {
  if (typeof window === 'undefined') return null;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!ctx) ctx = new AC();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

/** One enveloped tone: frequency (Hz), start offset and length (s), peak gain. */
function tone(a, { f, at = 0, len = 0.15, gain = 0.12, type = 'sine', slideTo = null }) {
  const t0 = a.currentTime + at;
  const osc = a.createOscillator();
  const env = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(f, t0);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + len);
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + len);
  osc.connect(env).connect(a.destination);
  osc.start(t0);
  osc.stop(t0 + len + 0.02);
}

const CUES = {
  // The check starts: two quick high tones, like a referee's earpiece alert.
  check: a => {
    tone(a, { f: 1320, len: 0.09, type: 'triangle' });
    tone(a, { f: 1320, at: 0.13, len: 0.09, type: 'triangle' });
  },
  // Tape rewinding: a short falling sweep.
  rewind: a => tone(a, { f: 900, slideTo: 260, len: 0.5, gain: 0.05, type: 'sawtooth' }),
  // Decision stamped: a low knock and a settled tone.
  stamp: a => {
    tone(a, { f: 110, slideTo: 60, len: 0.18, gain: 0.3 });
    tone(a, { f: 660, at: 0.05, len: 0.35, gain: 0.08, type: 'triangle' });
  },
  // Beat the VAR: the viewer's call was right / wrong.
  win: a => { tone(a, { f: 784, len: 0.12 }); tone(a, { f: 1046, at: 0.1, len: 0.2 }); },
  miss: a => tone(a, { f: 330, slideTo: 220, len: 0.3, gain: 0.08, type: 'triangle' }),
};

export function cue(name) {
  try {
    const a = audio();
    if (a && CUES[name]) CUES[name](a);
  } catch { /* no audio: stay silent */ }
}

/** Unlock audio inside the click that turns sound on. */
export function unlockAudio() {
  try { audio(); } catch { /* ignore */ }
}
