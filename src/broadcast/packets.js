/**
 * What each agent is allowed to see.
 *
 *   narratorPacket  the true facts of the moment plus recent play, in words
 *   extractorPacket the caption and the roster only — no facts, so the
 *                   extractor reports what was said, not what is true
 *   editorPacket    the verdict on each claim and the true facts to correct with
 */
import { indexPeople } from './narrator.js';

const NOTABLE = new Set(['pass', 'carry', 'shot', 'recovery', 'tackle', 'interception', 'pressure', 'save', 'block', 'foul', 'card', 'goal']);

export function namedFacts(spot, people) {
  const F = spot.facts;
  const t = side => people.teams[side].name;
  const n = id => people.full(id);
  const side = spot.moment.side;
  switch (spot.moment.type) {
    case 'goal':
      return {
        what: 'goal', team: t(side), scorer: n(F.scorer), assist: F.assist ? n(F.assist) : null,
        score_after: `${t('home')} ${F.score.home}-${F.score.away} ${t('away')}`,
        move_started_with_press: Boolean(F.cause), scorer_goals_this_match: F.tally || 1,
      };
    case 'chance':
      return { what: 'big chance, no goal', team: t(side), shooter: n(F.shooter), outcome: F.outcome.replace('_', ' '), xg: F.xg ?? null };
    case 'card':
      return { what: 'yellow card', team: t(side), player: n(F.booked) };
    case 'sub':
      return { what: 'substitution', team: t(side), coming_on: n(F.change.on), going_off: n(F.change.off) };
    case 'sprint':
      return { what: 'top speed reading', team: t(side), player: n(F.speed.player), top_speed_kmh: F.speed.kmh };
    case 'milestone':
      return { what: 'distance milestone', team: t(side), player: n(F.distance.player), distance_km: F.distance.km };
    case 'press':
      return { what: 'pressing spell', team: t(side), final_third_recoveries_last_5_min: F.count, of_which_straight_after_pressing: F.pressed ?? 0 };
    case 'stat':
      return {
        what: spot.moment.halfTime ? 'half-time possession report' : 'possession report',
        team: t(F.possession.side), possession_pct: F.possession.pct, pass_accuracy_pct: F.accuracy?.pct ?? null,
      };
    default:
      return {};
  }
}

export function describeEvent(e, people) {
  const who = e.player_id ? people.name(e.player_id) : e.team;
  const to = e.recipient_id ? ` to ${people.name(e.recipient_id)}` : '';
  const verbs = {
    pass: () => (e.successful ? `passes${to}` : 'gives the ball away'),
    carry: () => 'carries the ball forward',
    shot: () => `shoots (${e.outcome.replace('_', ' ')})`,
    recovery: () => (e.after_pressure ? 'wins the ball back after pressing' : 'wins the ball back'),
    tackle: () => (e.won ? 'wins a tackle' : 'tries a tackle'),
    interception: () => 'intercepts',
    pressure: () => `presses ${e.target ? e.target.split(' ').at(-1) : 'the ball carrier'}`,
    save: () => 'makes a save',
    block: () => 'blocks a shot',
    foul: () => 'commits a foul',
    card: () => 'is booked',
    goal: () => 'scores',
  };
  return `${e.display_minute} ${who} (${e.team}) ${verbs[e.type]?.() ?? e.type}`;
}

function roster(match) {
  return ['home', 'away'].flatMap(side => match.squads[side].players.map(p => ({
    id: p.id, name: p.name, team: match.squads[side].name, side,
  })));
}

export function narratorPacket(match, spot, index) {
  const people = indexPeople(match);
  const before = match.events.filter(e => e.seq < spot.trigger.seq && NOTABLE.has(e.type)).slice(-8);
  return {
    index,
    minute: spot.trigger.display_minute,
    moment_type: spot.moment.type,
    facts: namedFacts(spot, people),
    recent_play: before.map(e => describeEvent(e, people)),
    // Only used when a red-team instruction asks for a wrong player.
    team_players: match.squads[spot.moment.side === 'away' ? 'away' : 'home'].players.map(p => p.name),
    home: match.squads.home.name,
    away: match.squads.away.name,
  };
}

export function extractorPacket(match, spot, text) {
  return {
    caption: text,
    moment_type: spot.moment.type,
    home: { side: 'home', name: match.squads.home.name },
    away: { side: 'away', name: match.squads.away.name },
    roster: roster(match),
  };
}

export function editorPacket(match, spot, text, verdict) {
  const people = indexPeople(match);
  return {
    original_caption: text,
    verdict: verdict.status,
    claims: verdict.claims.map(c => ({
      quoted: c.span ?? null,
      kind: c.extracted_kind ?? c.kind,
      status: c.status,
      why: c.note,
    })),
    true_facts: namedFacts(spot, people),
  };
}
