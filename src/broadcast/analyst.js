/**
 * The built-in test analyst and recap writer: deterministic "why it matters"
 * lines and recaps written straight from the context facts, with the claims
 * an extractor would report. Used for offline runs and tests (no model), the
 * same way narrator.js stands in for the narrator. A plant puts one wrong
 * number or name in, exactly as the red team asks the real agents to.
 */
import { indexPeople, observedFor } from './narrator.js';
import { recapFacts, recapSpot } from './context.js';
import { possessionShare, teamStats, playerStats, scoreAt } from '../sim/stats.js';

const ordinal = n => {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  return `${n}${teen ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] ?? 'th'}`;
};
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One line of context for a key moment. Returns null for moments without one. */
export function simulateInsight(match, spot, { plant = null } = {}) {
  const people = indexPeople(match);
  const observed = observedFor(match, spot.trigger);
  const side = spot.moment.side;
  const other = side === 'home' ? 'away' : 'home';
  const team = people.teams[side].short;
  const opp = people.teams[other].short;
  const s = teamStats(observed, side);
  const so = teamStats(observed, other);
  const bump = (n, by = 2) => (plant ? n + by : n);
  const claims = [];
  const claim = (span, x) => { claims.push({ span, ...x }); return span; };
  let text;

  switch (spot.moment.type) {
    case 'goal': {
      const id = spot.facts.scorer;
      const shots = playerStats(observed, id).shots;
      text = `${claim(`${people.name(id)}'s ${ordinal(bump(shots))} shot of the match`, { kind: 'player_total', player_id: id, metric: 'shots', number: bump(shots) })}, and ${claim(`${team} now have ${plural(s.shots_on_target, 'shot')} on target`, { kind: 'team_total', side, metric: 'shots_on_target', number: s.shots_on_target })}: their finishing is making the difference.`;
      break;
    }
    case 'chance': {
      const xg = Math.round(s.xg * 10) / 10;
      text = `${claim(`${team} have ${(plant ? xg + 0.4 : xg).toFixed(1)} xG`, { kind: 'team_total', side, metric: 'xg', number: Math.round((plant ? xg + 0.4 : xg) * 10) / 10 })} from ${claim(plural(s.shots, 'shot'), { kind: 'team_total', side, metric: 'shots', number: s.shots })}, so the chances keep coming.`;
      break;
    }
    case 'press': {
      const share = possessionShare(observed.filter(e => e.period === spot.trigger.period && e.t >= spot.trigger.t - 600))[side];
      const pct = Math.round(share ?? 50);
      text = `${claim(`${team} have won the ball back in the final third ${bump(s.attacking_third_recoveries)} times`, { kind: 'team_total', side, metric: 'final_third_recoveries', number: bump(s.attacking_third_recoveries) })} and ${claim(`had ${pct}% of the ball in the last 10 minutes`, { kind: 'recent_possession', side, number: pct })}: the press is pinning ${opp} back.`;
      break;
    }
    case 'stat': {
      const lead = s.shots >= so.shots ? side : other;
      const a = teamStats(observed, lead).shots;
      const b = teamStats(observed, lead === side ? other : side).shots;
      const ln = people.teams[lead].short;
      const on = people.teams[lead === side ? other : side].short;
      text = `${claim(`${ln} have ${plural(bump(a), 'shot')}`, { kind: 'team_total', side: lead, metric: 'shots', number: bump(a) })} to ${claim(`${on}'s ${b}`, { kind: 'team_total', side: lead === side ? other : side, metric: 'shots', number: b })}, so the ball is not the whole story.`;
      break;
    }
    default:
      return null;
  }
  return {
    text,
    extracted: claims,
    planted_error: plant ? { kind: plant, claim_index: 0 } : null,
  };
}

/** A recap as a list of sentences, each with the claims an extractor would report. */
export function simulateRecap(match, which, { plant = null } = {}) {
  const people = indexPeople(match);
  const { trigger } = recapSpot(match, which);
  const observed = match.events.filter(e => e.seq <= trigger.seq);
  const score = scoreAt(observed);
  const H = people.teams.home.short;
  const A = people.teams.away.short;
  const when = which === 'HT' ? 'at half-time' : 'at full time';
  const verb = which === 'HT' ? 'lead' : 'win';
  const sentences = [];
  const add = (text, extracted) => sentences.push({ text, extracted });

  const line = `${H} ${score.home}-${score.away} ${A}`;
  const state = score.home === score.away ? `It is ${line} ${when}` : `${score.home > score.away ? H : A} ${verb}: ${line} ${when}`;
  add(`${state}.`, [{ kind: 'score', span: line, home: score.home, away: score.away }]);

  const goals = observed.filter(e => e.type === 'goal');
  goals.forEach((g, i) => {
    let scorer = g.scorer_id;
    if (plant && i === 0) scorer = people.teammates(g.scorer_id)[0]?.id ?? scorer;
    const minute = Number(String(g.display_minute).replace(/\D.*$/, ''));
    add(`${people.name(scorer)} scored for ${people.teams[g.side].short} in the ${ordinal(minute)} minute.`,
      [{ kind: 'goal_event', span: `${people.name(scorer)} scored`, player_id: scorer, number: minute }]);
  });

  const sh = teamStats(observed, 'home').shots;
  const sa = teamStats(observed, 'away').shots;
  // With no goal to misattribute, the plant inflates the shots instead.
  const bumpShots = plant && !goals.length ? 3 : 0;
  add(`${H} had ${plural(sh + bumpShots, 'shot')} to ${A}'s ${sa}.`, [
    { kind: 'team_total', span: `${H} had ${plural(sh + bumpShots, 'shot')}`, side: 'home', metric: 'shots', number: sh + bumpShots },
    { kind: 'team_total', span: `${A}'s ${sa}`, side: 'away', metric: 'shots', number: sa },
  ]);

  const share = possessionShare(observed);
  const more = share.home >= share.away ? 'home' : 'away';
  add(`${people.teams[more].short} had ${Math.round(share[more])}% of the ball.`,
    [{ kind: 'possession', span: `${Math.round(share[more])}% of the ball`, side: more, number: Math.round(share[more]) }]);

  const planted = plant ? (goals.length ? 1 : sentences.length - 2) : null;
  return { sentences, planted_sentence: planted, planted_error: plant ? { kind: plant } : null, facts: recapFacts(match, which) };
}
