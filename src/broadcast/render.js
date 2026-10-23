/**
 * Render what airs.
 *
 * A verified caption airs as the narrator wrote it (English, fan view).
 * Everything else — other languages, the analyst view, trimmed or corrected
 * captions — is rendered from the *verified facts* with fixed templates, so
 * translation and personalisation can never introduce a new number or name.
 */

export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'de', label: 'Deutsch' },
  { code: 'zh', label: '中文' },
];

/** Facts the screen may show: actual values, minus any context claim that failed. */
export function airFacts(caption, verdict) {
  const r = Object.fromEntries(verdict.claims.map(c => [c.id, c]));
  const ok = id => r[id]?.status === 'supported';
  const actual = id => r[id]?.actual;
  switch (caption.type) {
    case 'goal':
      return {
        scorer: actual('scorer'), score: actual('score'),
        assist: ok('assist') ? actual('assist') : null,
        cause: ok('cause'), tally: ok('tally') ? actual('tally') : null,
      };
    case 'chance':
      return { shooter: actual('shooter'), outcome: actual('outcome'), xg: ok('xg') ? actual('xg') : null };
    case 'card':
      return { player: actual('booked') };
    case 'sub':
      return actual('change');
    case 'sprint':
      return actual('speed');
    case 'milestone':
      return actual('distance');
    case 'press':
      return { count: actual('count'), pressed: ok('pressed') ? actual('pressed') : null };
    case 'stat': {
      const poss = actual('possession');
      const acc = ok('accuracy') && actual('accuracy').side === poss.side ? actual('accuracy').pct : null;
      return { side: poss.side, pct: poss.pct, accuracy: acc };
    }
    default:
      return {};
  }
}

export function renderCaption(caption, verdict, people, { lang = 'en', persona = 'fan', follow = 'neutral' } = {}) {
  if (verdict.status === 'VERIFY' && lang === 'en' && persona === 'fan') {
    return prefix(caption, null, people, lang, persona, follow) + caption.segments.map(s => s.text).join('');
  }
  const f = airFacts(caption, verdict);
  const T = TEMPLATES[lang] || TEMPLATES.en;
  const ctx = {
    f,
    P: people,
    n: id => people.name(id),
    team: side => people.teams[side].short,
    side: caption.type === 'stat' ? f.side : caption.side,
    minute: caption.display_minute,
    halfTime: caption.type === 'stat' && caption.trigger_event_id.startsWith('END'),
  };
  const body = T[caption.type]?.[persona]?.(ctx) ?? '';
  return prefix(caption, f, people, lang, persona, follow) + body;
}

function prefix(caption, f, people, lang, persona, follow) {
  if (persona !== 'fan' || follow === 'neutral' || caption.type !== 'goal') return '';
  const ours = follow === caption.side;
  return (FOLLOW_PREFIX[lang] || FOLLOW_PREFIX.en)[ours ? 'ours' : 'theirs'];
}

const FOLLOW_PREFIX = {
  en: { ours: 'Yes! ', theirs: 'Setback. ' },
  es: { ours: '¡Sí! ', theirs: 'Golpe duro. ' },
  de: { ours: 'Ja! ', theirs: 'Rückschlag. ' },
  zh: { ours: '好球！', theirs: '遗憾，' },
};

const score = (c, sep = '–') => `${c.team('home')} ${c.f.score.home}${sep}${c.f.score.away} ${c.team('away')}`;
const outcomeWord = {
  en: { saved: 'saved', off_target: 'off target', blocked: 'blocked', woodwork: 'hit the woodwork', goal: 'scored' },
  es: { saved: 'atajado', off_target: 'desviado', blocked: 'bloqueado', woodwork: 'al palo', goal: 'gol' },
  de: { saved: 'gehalten', off_target: 'vorbei', blocked: 'geblockt', woodwork: 'Aluminium', goal: 'Tor' },
  zh: { saved: '被扑出', off_target: '偏出', blocked: '被封堵', woodwork: '击中门框', goal: '破门' },
};

const TEMPLATES = {
  en: {
    goal: {
      fan: c => `${c.n(c.f.scorer)} scores for ${c.team(c.side)}!${c.f.assist ? ` Set up by ${c.n(c.f.assist)}.` : ''}${c.f.cause ? ' It started with the press winning the ball back.' : ''}${c.f.tally === 2 ? ' His second of the game.' : c.f.tally >= 3 ? ' A hat-trick!' : ''} ${score(c)}.`,
      analyst: c => `${c.minute} Goal ${c.team(c.side)}: ${c.n(c.f.scorer)}${c.f.assist ? `, assist ${c.n(c.f.assist)}` : ''}.${c.f.cause ? ' Possession began with a pressure-linked recovery.' : ''}${c.f.tally ? ` Goals for scorer: ${c.f.tally}.` : ''} ${score(c)}.`,
    },
    chance: {
      fan: c => ({ saved: `${c.n(c.f.shooter)} forces a save.`, off_target: `${c.n(c.f.shooter)} goes close, just wide.`, blocked: `${c.n(c.f.shooter)}'s shot is blocked.`, woodwork: `${c.n(c.f.shooter)} hits the woodwork!` }[c.f.outcome] ?? `Chance for ${c.n(c.f.shooter)}.`),
      analyst: c => `${c.minute} Shot ${c.team(c.side)}: ${c.n(c.f.shooter)}, ${outcomeWord.en[c.f.outcome]}${c.f.xg != null ? `, xG ${c.f.xg.toFixed(2)}` : ''}.`,
    },
    card: {
      fan: c => `Yellow card for ${c.n(c.f.player)} (${c.team(c.side)}).`,
      analyst: c => `${c.minute} Booking: ${c.n(c.f.player)}, ${c.team(c.side)}.`,
    },
    sub: {
      fan: c => `${c.team(c.side)} change: ${c.n(c.f.on)} on for ${c.n(c.f.off)}.`,
      analyst: c => `${c.minute} Substitution ${c.team(c.side)}: ${c.n(c.f.on)} for ${c.n(c.f.off)}.`,
    },
    sprint: {
      fan: c => `${c.n(c.f.player)} at full speed: ${c.f.kmh.toFixed(1)} km/h.`,
      analyst: c => `${c.minute} Top speed ${c.n(c.f.player)}: ${c.f.kmh.toFixed(1)} km/h.`,
    },
    milestone: {
      fan: c => `${c.n(c.f.player)} has run ${c.f.km} km.`,
      analyst: c => `${c.minute} Distance covered, ${c.n(c.f.player)}: ${c.f.km} km.`,
    },
    press: {
      fan: c => `${c.team(c.side)} keep winning it back high up: ${c.f.count} times in five minutes${c.f.pressed ? `, ${c.f.pressed} straight after pressing` : ''}.`,
      analyst: c => `${c.minute} ${c.team(c.side)}: ${c.f.count} attacking-third recoveries in the last 300 s${c.f.pressed != null ? `, ${c.f.pressed} within 5 s of a pressure` : ''}.`,
    },
    stat: {
      fan: c => `${c.halfTime ? 'Half-time. ' : ''}${c.team(c.side)} have had ${c.f.pct}% of the ball${c.f.accuracy != null ? ` and completed ${c.f.accuracy}% of their passes` : ''}.`,
      analyst: c => `${c.halfTime ? 'Half-time. ' : `${c.minute} `}Possession ${c.team(c.side)} ${c.f.pct}%${c.f.accuracy != null ? `, pass accuracy ${c.f.accuracy}%` : ''}.`,
    },
  },
  es: {
    goal: {
      fan: c => `¡Gol de ${c.n(c.f.scorer)} para el ${c.team(c.side)}!${c.f.assist ? ` Asistencia de ${c.n(c.f.assist)}.` : ''}${c.f.cause ? ' Nació de una recuperación tras presión.' : ''}${c.f.tally === 2 ? ' Su segundo del partido.' : c.f.tally >= 3 ? ' ¡Triplete!' : ''} ${score(c)}.`,
      analyst: c => `${c.minute} Gol ${c.team(c.side)}: ${c.n(c.f.scorer)}${c.f.assist ? `, asistencia de ${c.n(c.f.assist)}` : ''}.${c.f.cause ? ' La posesión empezó con una recuperación tras presión.' : ''} ${score(c)}.`,
    },
    chance: {
      fan: c => ({ saved: `${c.n(c.f.shooter)} obliga al portero a intervenir.`, off_target: `${c.n(c.f.shooter)} roza el gol: fuera por poco.`, blocked: `Disparo de ${c.n(c.f.shooter)} bloqueado.`, woodwork: `¡${c.n(c.f.shooter)} estrella el balón en la madera!` }[c.f.outcome] ?? `Ocasión para ${c.n(c.f.shooter)}.`),
      analyst: c => `${c.minute} Disparo ${c.team(c.side)}: ${c.n(c.f.shooter)}, ${outcomeWord.es[c.f.outcome]}${c.f.xg != null ? `, xG ${c.f.xg.toFixed(2)}` : ''}.`,
    },
    card: {
      fan: c => `Tarjeta amarilla para ${c.n(c.f.player)} (${c.team(c.side)}).`,
      analyst: c => `${c.minute} Amonestado: ${c.n(c.f.player)}, ${c.team(c.side)}.`,
    },
    sub: {
      fan: c => `Cambio en el ${c.team(c.side)}: entra ${c.n(c.f.on)}, sale ${c.n(c.f.off)}.`,
      analyst: c => `${c.minute} Cambio ${c.team(c.side)}: ${c.n(c.f.on)} por ${c.n(c.f.off)}.`,
    },
    sprint: {
      fan: c => `${c.n(c.f.player)} a toda velocidad: ${c.f.kmh.toFixed(1)} km/h.`,
      analyst: c => `${c.minute} Velocidad máxima de ${c.n(c.f.player)}: ${c.f.kmh.toFixed(1)} km/h.`,
    },
    milestone: {
      fan: c => `${c.n(c.f.player)} ya ha recorrido ${c.f.km} km.`,
      analyst: c => `${c.minute} Distancia recorrida por ${c.n(c.f.player)}: ${c.f.km} km.`,
    },
    press: {
      fan: c => `El ${c.team(c.side)} recupera arriba una y otra vez: ${c.f.count} veces en cinco minutos${c.f.pressed ? `, ${c.f.pressed} justo después de presionar` : ''}.`,
      analyst: c => `${c.minute} ${c.team(c.side)}: ${c.f.count} recuperaciones en el último tercio en 300 s${c.f.pressed != null ? `, ${c.f.pressed} a menos de 5 s de una presión` : ''}.`,
    },
    stat: {
      fan: c => `${c.halfTime ? 'Descanso. ' : ''}El ${c.team(c.side)} ha tenido el ${c.f.pct}% del balón${c.f.accuracy != null ? ` y ha acertado el ${c.f.accuracy}% de sus pases` : ''}.`,
      analyst: c => `${c.halfTime ? 'Descanso. ' : `${c.minute} `}Posesión ${c.team(c.side)} ${c.f.pct}%${c.f.accuracy != null ? `, precisión de pase ${c.f.accuracy}%` : ''}.`,
    },
  },
  de: {
    goal: {
      fan: c => `Tor für ${c.team(c.side)} durch ${c.n(c.f.scorer)}!${c.f.assist ? ` Vorlage von ${c.n(c.f.assist)}.` : ''}${c.f.cause ? ' Entstanden aus einem Ballgewinn im Pressing.' : ''}${c.f.tally === 2 ? ' Sein zweites Tor heute.' : c.f.tally >= 3 ? ' Ein Hattrick!' : ''} ${score(c, ':')}.`,
      analyst: c => `${c.minute} Tor ${c.team(c.side)}: ${c.n(c.f.scorer)}${c.f.assist ? `, Vorlage ${c.n(c.f.assist)}` : ''}.${c.f.cause ? ' Ballbesitz begann mit einem Ballgewinn nach Pressing.' : ''} ${score(c, ':')}.`,
    },
    chance: {
      fan: c => ({ saved: `${c.n(c.f.shooter)} prüft den Torwart.`, off_target: `${c.n(c.f.shooter)} knapp vorbei.`, blocked: `Schuss von ${c.n(c.f.shooter)} geblockt.`, woodwork: `${c.n(c.f.shooter)} trifft nur das Aluminium!` }[c.f.outcome] ?? `Chance für ${c.n(c.f.shooter)}.`),
      analyst: c => `${c.minute} Schuss ${c.team(c.side)}: ${c.n(c.f.shooter)}, ${outcomeWord.de[c.f.outcome]}${c.f.xg != null ? `, xG ${c.f.xg.toFixed(2)}` : ''}.`,
    },
    card: {
      fan: c => `Gelbe Karte für ${c.n(c.f.player)} (${c.team(c.side)}).`,
      analyst: c => `${c.minute} Verwarnung: ${c.n(c.f.player)}, ${c.team(c.side)}.`,
    },
    sub: {
      fan: c => `Wechsel bei ${c.team(c.side)}: ${c.n(c.f.on)} kommt für ${c.n(c.f.off)}.`,
      analyst: c => `${c.minute} Wechsel ${c.team(c.side)}: ${c.n(c.f.on)} für ${c.n(c.f.off)}.`,
    },
    sprint: {
      fan: c => `${c.n(c.f.player)} mit Vollgas: ${c.f.kmh.toFixed(1).replace('.', ',')} km/h.`,
      analyst: c => `${c.minute} Höchstgeschwindigkeit ${c.n(c.f.player)}: ${c.f.kmh.toFixed(1).replace('.', ',')} km/h.`,
    },
    milestone: {
      fan: c => `${c.n(c.f.player)} hat bereits ${c.f.km} km zurückgelegt.`,
      analyst: c => `${c.minute} Laufdistanz ${c.n(c.f.player)}: ${c.f.km} km.`,
    },
    press: {
      fan: c => `${c.team(c.side)} erobert den Ball immer wieder hoch: ${c.f.count}-mal in fünf Minuten${c.f.pressed ? `, ${c.f.pressed}-mal direkt nach Pressing` : ''}.`,
      analyst: c => `${c.minute} ${c.team(c.side)}: ${c.f.count} Ballgewinne im letzten Drittel in 300 s${c.f.pressed != null ? `, ${c.f.pressed} innerhalb von 5 s nach Pressing` : ''}.`,
    },
    stat: {
      fan: c => `${c.halfTime ? 'Halbzeit. ' : ''}${c.team(c.side)} hatte ${c.f.pct} % Ballbesitz${c.f.accuracy != null ? ` und ${c.f.accuracy} % angekommene Pässe` : ''}.`,
      analyst: c => `${c.halfTime ? 'Halbzeit. ' : `${c.minute} `}Ballbesitz ${c.team(c.side)} ${c.f.pct} %${c.f.accuracy != null ? `, Passquote ${c.f.accuracy} %` : ''}.`,
    },
  },
  zh: {
    goal: {
      fan: c => `${c.n(c.f.scorer)}破门，${c.team(c.side)}进球！${c.f.assist ? `${c.n(c.f.assist)}送出助攻。` : ''}${c.f.cause ? '这次进攻源于高位逼抢断球。' : ''}${c.f.tally === 2 ? '这是他本场第二球。' : c.f.tally >= 3 ? '帽子戏法！' : ''}${score(c, ':')}。`,
      analyst: c => `${c.minute} ${c.team(c.side)}进球：${c.n(c.f.scorer)}${c.f.assist ? `，助攻 ${c.n(c.f.assist)}` : ''}。${c.f.cause ? '本次控球始于逼抢后的抢回球权。' : ''}${score(c, ':')}。`,
    },
    chance: {
      fan: c => ({ saved: `${c.n(c.f.shooter)}的射门被门将扑出。`, off_target: `${c.n(c.f.shooter)}射门稍稍偏出。`, blocked: `${c.n(c.f.shooter)}的射门被封堵。`, woodwork: `${c.n(c.f.shooter)}击中门框！` }[c.f.outcome] ?? `${c.n(c.f.shooter)}获得机会。`),
      analyst: c => `${c.minute} ${c.team(c.side)}射门：${c.n(c.f.shooter)}，${outcomeWord.zh[c.f.outcome]}${c.f.xg != null ? `，xG ${c.f.xg.toFixed(2)}` : ''}。`,
    },
    card: {
      fan: c => `${c.team(c.side)}的${c.n(c.f.player)}吃到黄牌。`,
      analyst: c => `${c.minute} 黄牌：${c.n(c.f.player)}（${c.team(c.side)}）。`,
    },
    sub: {
      fan: c => `${c.team(c.side)}换人：${c.n(c.f.on)}替下${c.n(c.f.off)}。`,
      analyst: c => `${c.minute} ${c.team(c.side)}换人：${c.n(c.f.on)} 换 ${c.n(c.f.off)}。`,
    },
    sprint: {
      fan: c => `${c.n(c.f.player)}全速冲刺：${c.f.kmh.toFixed(1)} 公里/小时。`,
      analyst: c => `${c.minute} ${c.n(c.f.player)} 最高速度：${c.f.kmh.toFixed(1)} km/h。`,
    },
    milestone: {
      fan: c => `${c.n(c.f.player)}已经跑了 ${c.f.km} 公里。`,
      analyst: c => `${c.minute} ${c.n(c.f.player)} 跑动距离：${c.f.km} km。`,
    },
    press: {
      fan: c => `${c.team(c.side)}不断在前场抢回球权：五分钟内 ${c.f.count} 次${c.f.pressed ? `，其中 ${c.f.pressed} 次紧随逼抢` : ''}。`,
      analyst: c => `${c.minute} ${c.team(c.side)}：近 300 秒前场三区抢回球权 ${c.f.count} 次${c.f.pressed != null ? `，其中 ${c.f.pressed} 次发生在逼抢后 5 秒内` : ''}。`,
    },
    stat: {
      fan: c => `${c.halfTime ? '半场结束。' : ''}${c.team(c.side)}控球率 ${c.f.pct}%${c.f.accuracy != null ? `，传球成功率 ${c.f.accuracy}%` : ''}。`,
      analyst: c => `${c.halfTime ? '半场结束。' : `${c.minute} `}${c.team(c.side)}控球 ${c.f.pct}%${c.f.accuracy != null ? `，传球成功率 ${c.f.accuracy}%` : ''}。`,
    },
  },
};
