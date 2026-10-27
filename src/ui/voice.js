/**
 * The commentary voice: reads out what airs, with the browser's own speech
 * synthesis (Web Speech API). It is handed only checked text, the caption
 * after its VAR check, so a draft the referee rejected is never spoken.
 */
const LOCALE = { en: 'en-GB', es: 'es-ES', de: 'de-DE', zh: 'zh-CN' };

export const voiceSupported = () => typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;

function pickVoice(locale) {
  const voices = window.speechSynthesis.getVoices();
  const lang = locale.slice(0, 2);
  return voices.find(v => v.lang === locale && /natural|neural|online/i.test(v.name))
    ?? voices.find(v => v.lang === locale)
    ?? voices.find(v => v.lang?.startsWith(lang))
    ?? null;
}

/** Say a line. `interrupt` cuts off whatever is being read (a new caption replaces the old). */
export function speak(text, lang = 'en', { interrupt = true } = {}) {
  if (!voiceSupported() || !text) return;
  try {
    const synth = window.speechSynthesis;
    if (interrupt) synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = LOCALE[lang] ?? 'en-GB';
    const v = pickVoice(u.lang);
    if (v) u.voice = v;
    u.rate = 1.05;
    synth.speak(u);
  } catch { /* no speech: stay silent */ }
}

export function hush() {
  try { if (voiceSupported()) window.speechSynthesis.cancel(); } catch { /* ignore */ }
}
