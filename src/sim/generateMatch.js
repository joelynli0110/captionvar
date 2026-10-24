/**
 * CaptionVAR synthetic match generator.
 *
 * A seeded, possession-based simulation of a full 90-minute match between two
 * fictional clubs. It produces a single ordered event stream (passes, carries,
 * pressures, tackles, interceptions, recoveries, shots with xG, saves, goals,
 * set pieces, fouls, cards, substitutions, sprints and physical milestones)
 * that the rest of the pipeline ingests "live".
 *
 * Design goals
 *   - Reproducible: same seed + config => byte-identical output.
 *   - Football-realistic totals (pass volume/accuracy, shots, xG, possession).
 *   - Causally linked: a recovery records the pressure that preceded it, a goal
 *     records its shot and assisting pass. Claims such as "the press won the
 *     ball back" can therefore be verified, not just guessed.
 *   - Story beats: a director can inject scripted moments (a goal, a pressing
 *     spell) whose event IDs are returned as ground truth for evaluation.
 *
 * See docs/SYNTHETIC_DATA.md for the event schema.
 */
import { createRng } from './rng.js';
import { DEFAULT_TEAMS } from './teams.js';
import {
  clamp, round, toAbsolute, flip, zoneOf, channelOf, metres, inBox, shotGeometry, expectedGoals,
} from './pitch.js';

export const SCHEMA_VERSION = '1.0';

const SPRINT_THRESHOLD_KMH = 30;
const PRESSURE_LINK_WINDOW_S = 5;
const MILESTONES_KM = [10, 11, 12];

/** The default demo storyline (all minutes are match clock). */
export const DEFAULT_STORY = [
  { kind: 'goal', side: 'away', at: '23:10', scorer: 'RVU-09', assist: 'RVU-10', via: 'counter', label: 'Riverside open the scoring on the break' },
  { kind: 'press_spell', side: 'home', from: '69:00', to: '77:00', intensity: 2.2, label: 'Northbridge high-press spell' },
  { kind: 'goal', side: 'home', at: '74:20', scorer: 'NBR-09', assist: 'NBR-08', via: 'press', label: 'Northbridge equalise from a high turnover' },
  { kind: 'goal', side: 'home', at: '88:30', scorer: 'NBR-11', assist: 'NBR-16', via: 'build_up', label: 'Late Northbridge winner' },
];

const DEFAULT_CONFIG = {
  seed: 'captionvar-demo-6',
  matchId: null,
  teams: DEFAULT_TEAMS,
  story: DEFAULT_STORY,
  naturalGoalFactor: 0.3, // scales unscripted conversion; 0 => only scripted goals
  venue: 'Harbourline Stadium (fictional)',
  competition: 'Synthetic League (fictional)',
  kickoffUtc: '2026-10-24T14:00:00Z',
};

const parseClock = v => {
  if (typeof v === 'number') return v;
  const [m, s] = String(v).split(':').map(Number);
  return m * 60 + (s || 0);
};

const other = side => (side === 'home' ? 'away' : 'home');

/** Public entry point. */
export function generateMatch(userConfig = {}) {
  const config = { ...DEFAULT_CONFIG, ...userConfig };
  const engine = new MatchEngine(config);
  return engine.run();
}

class MatchEngine {
  constructor(config) {
    this.config = config;
    this.rng = createRng(config.seed);
    this.events = [];
    this.seq = 0;
    this.period = 1;
    this.t = 0;
    this.score = { home: 0, away: 0 };
    this.possessionId = 0;
    this.possession = null; // {side, id, startT, startAx, how, passes}
    this.ball = { ax: 50, ay: 50 }; // attack frame of the side in possession
    this.carrier = null;
    this.pending = null; // dead-ball restart to execute next
    this.lastPressure = null; // {side, id, t}
    this.lastPass = null; // last completed pass by the side in possession
    this.forced = null; // active scripted beat
    this.momentum = { home: 1, away: 1 };
    this.nextMomentumT = 0;

    this.teams = {};
    for (const side of ['home', 'away']) {
      const team = config.teams[side];
      this.teams[side] = {
        ...team,
        side,
        onPitch: team.starters.map(p => this.initPlayer(p)),
        bench: team.bench.map(p => this.initPlayer(p)),
        subsMade: 0,
        subPlan: [],
      };
    }
    this.playersById = new Map();
    for (const side of ['home', 'away']) {
      for (const p of [...this.teams[side].onPitch, ...this.teams[side].bench]) this.playersById.set(p.id, p);
    }

    this.story = (config.story || []).map((beat, i) => ({
      ...beat,
      index: i,
      at: beat.at != null ? parseClock(beat.at) : null,
      from: beat.from != null ? parseClock(beat.from) : null,
      to: beat.to != null ? parseClock(beat.to) : null,
      done: false,
      event_ids: [],
    }));

    this.stoppage = { 1: this.rng.int(1, 3) * 60 + this.rng.int(0, 50), 2: this.rng.int(3, 6) * 60 + this.rng.int(0, 50) };
    this.planSubstitutions();
  }

  initPlayer(p) {
    // Running volume per minute on the pitch (~10-12.5 km over 90' for outfield players).
    const work = p.role_group === 'goalkeeper' ? 0.5 : p.role_group === 'midfielder' ? 1.12 : p.role_group === 'forward' ? 1.0 : 0.95;
    return {
      ...p,
      slot: p.base,
      distance_m: 0,
      metres_per_min: (p.role_group === 'goalkeeper' ? 116 : 108) * work * this.rng.range(0.94, 1.06),
      milestones: new Set(),
      yellow: 0,
      sent_off: false,
    };
  }

  planSubstitutions() {
    for (const side of ['home', 'away']) {
      const team = this.teams[side];
      const count = this.rng.int(3, 5);
      const times = Array.from({ length: count }, () => this.rng.int(56 * 60, 86 * 60)).sort((a, b) => a - b);
      team.subPlan = times;
    }
  }

  // ---------------------------------------------------------------- clock ---

  get periodStart() { return this.period === 1 ? 0 : 45 * 60; }
  get periodEnd() { return (this.period === 1 ? 45 * 60 : 90 * 60) + this.stoppage[this.period]; }

  advance(seconds) {
    const dt = Math.max(0.2, seconds);
    this.t += dt;
    for (const side of ['home', 'away']) {
      for (const p of this.teams[side].onPitch) {
        p.distance_m += (dt / 60) * p.metres_per_min * (this.forced ? 1.1 : 1);
        for (const km of MILESTONES_KM) {
          if (p.distance_m >= km * 1000 && !p.milestones.has(km)) {
            p.milestones.add(km);
            this.emit({
              type: 'physical_milestone', side, player: p,
              milestone_km: km, total_distance_km: round(p.distance_m / 1000, 2),
            }, { noLocation: true });
          }
        }
      }
    }
  }

  clockFields(rawT = this.t) {
    const t = round(rawT, 1); // publish one decimal; derive minute/second from the published value
    const minute = Math.floor(t / 60);
    const second = Math.floor(t % 60);
    const regular = this.period === 1 ? 45 : 90;
    const display = minute >= regular
      ? `${regular}+${minute - regular + 1}'`
      : `${minute + 1}'`;
    return { period: this.period, t, minute, second, display_minute: display, stoppage_time: minute >= regular };
  }

  // --------------------------------------------------------------- events ---

  /**
   * Append an event. `ev` uses attack-frame coordinates (ax, ay) of `ev.side`;
   * they are converted to absolute pitch coordinates here.
   */
  emit(ev, { noLocation = false } = {}) {
    this.seq += 1;
    const { type, side, player, ax, ay, endAx, endAy, ...rest } = ev;
    const team = side ? this.teams[side] : null;
    const prefix = ID_PREFIX[type] || 'E';
    const out = {
      id: `${prefix}-${String(this.seq).padStart(4, '0')}`,
      seq: this.seq,
      type,
      ...this.clockFields(),
    };
    if (team) {
      out.team = team.name;
      out.team_id = team.id;
      out.side = side;
    }
    if (player) {
      out.player_id = player.id;
      out.player = player.name;
    }
    if (!noLocation && ax != null) {
      const abs = toAbsolute(ax, ay, side, this.period);
      out.x = abs.x;
      out.y = abs.y;
      out.zone = zoneOf(ax);
      out.channel = channelOf(ay);
    }
    if (endAx != null) {
      const end = toAbsolute(endAx, endAy, side, this.period);
      out.end_x = end.x;
      out.end_y = end.y;
      out.end_zone = zoneOf(endAx);
    }
    if (this.possession && type !== 'period_start' && type !== 'period_end' && type !== 'substitution' && type !== 'physical_milestone') {
      out.possession_id = this.possession.id;
      out.possession_team_id = this.teams[this.possession.side].id;
    }
    for (const [k, v] of Object.entries(rest)) {
      if (v !== undefined && v !== null) out[k] = v;
    }
    this.events.push(out);
    // Ground truth for evaluation: every event from the scripted turnover to the goal.
    if (this.forced?.ballWon && type !== 'physical_milestone' && type !== 'substitution') this.forced.event_ids.push(out.id);
    return out;
  }

  setPossession(side, how, ax = this.ball.ax) {
    if (!this.possession || this.possession.side !== side) {
      this.possessionId += 1;
      this.possession = { side, id: this.possessionId, startT: this.t, startAx: ax, how, passes: 0 };
      this.lastPass = null;
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------- players ---

  /** Dynamic position of a player in his own team's attack frame. */
  positionOf(player, side) {
    const own = this.possession && this.possession.side === side;
    const ballAx = own ? this.ball.ax : 100 - this.ball.ax;
    const ballAy = own ? this.ball.ay : 100 - this.ball.ay;
    const shift = (ballAx - 50) * (own ? 0.5 : 0.4);
    if (player.role_group === 'goalkeeper') {
      return { ax: clamp(5 + shift * 0.12, 2, 16), ay: 50 };
    }
    const width = this.teams[side].style.width;
    const baseAy = 50 + (player.slot.ay - 50) * (own ? 0.8 + width * 0.3 : 0.75);
    // Attackers cannot stand behind the opposition back line (~edge of the box),
    // defenders do not drop behind their own six-yard area.
    const maxAx = own ? 86 + (player.role_group === 'forward' ? 2 : 0) : 70;
    const minAx = own ? 3 : 7;
    return {
      ax: clamp(player.slot.ax + shift, minAx, maxAx),
      ay: clamp(baseAy * 0.78 + ballAy * 0.22, 3, 97),
    };
  }

  /** Defender most likely to engage the ball (attack frame of the possessing side). */
  nearestDefender(includeKeeper = false) {
    const dSide = other(this.possession.side);
    const ballD = flip(this.ball.ax, this.ball.ay);
    const candidates = this.teams[dSide].onPitch.filter(p => includeKeeper || p.role_group !== 'goalkeeper');
    return this.rng.weightedItem(candidates, p => {
      const pos = this.positionOf(p, dSide);
      const d = metres(pos, ballD);
      return (0.4 + p.defending) / (1 + (d / 9) ** 2);
    });
  }

  keeper(side) {
    return this.teams[side].onPitch.find(p => p.role_group === 'goalkeeper') || this.teams[side].onPitch[0];
  }

  pickByGroup(side, groups, exclude = null) {
    const pool = this.teams[side].onPitch.filter(p => groups.includes(p.role_group) && p !== exclude);
    return pool.length ? this.rng.pick(pool) : this.teams[side].onPitch.find(p => p !== exclude);
  }

  pickNearSpot(side, ax, ay, exclude = null) {
    const candidates = this.teams[side].onPitch.filter(p => p !== exclude && p.role_group !== 'goalkeeper');
    return this.rng.weightedItem(candidates, p => {
      const pos = this.positionOf(p, side);
      return 1 / (1 + (metres(pos, { ax, ay }) / 10) ** 2);
    });
  }

  findPlayer(id) {
    const p = this.playersById.get(id);
    if (!p || p.sent_off) return null;
    for (const side of ['home', 'away']) {
      if (this.teams[side].onPitch.includes(p)) return p;
    }
    return null;
  }

  // ---------------------------------------------------------- intensities ---

  /** Clock values repeat across periods (first-half stoppage vs 45:00+), so check the period too. */
  beatPeriod(seconds) {
    return seconds >= 45 * 60 ? 2 : 1;
  }

  inPressSpell(side) {
    return this.story.some(b => b.kind === 'press_spell' && b.side === side
      && this.beatPeriod(b.from) === this.period && this.t >= b.from && this.t <= b.to);
  }

  pressMultiplier(side) {
    const spell = this.story.find(b => b.kind === 'press_spell' && b.side === side
      && this.beatPeriod(b.from) === this.period && this.t >= b.from && this.t <= b.to);
    return this.momentum[side] * (spell ? spell.intensity : 1);
  }

  updateMomentum() {
    if (this.t < this.nextMomentumT) return;
    for (const side of ['home', 'away']) {
      this.momentum[side] = clamp(this.momentum[side] + this.rng.normal(0, 0.06), 0.85, 1.15);
    }
    this.nextMomentumT = this.t + 300;
  }

  // ----------------------------------------------------------------- run ---

  run() {
    for (const period of [1, 2]) {
      this.period = period;
      this.t = this.periodStart;
      this.possession = null;
      this.lastPressure = null;
      this.emit({ type: 'period_start', period_label: period === 1 ? 'First half' : 'Second half' }, { noLocation: true });
      const kicking = period === 1 ? 'home' : 'away';
      this.pending = { kind: 'kick_off', side: kicking, ax: 50, ay: 50 };
      let guard = 0;
      while (this.t < this.periodEnd || this.forced) {
        if ((guard += 1) > 20000) throw new Error('simulation did not terminate');
        this.updateMomentum();
        this.runDirector();
        if (this.pending) this.restart();
        else this.onBallAction();
        if (this.t > this.periodEnd + 180) break; // never let a beat run away with the clock
      }
      this.emit({ type: 'period_end', period_label: period === 1 ? 'Half-time' : 'Full-time', score: { ...this.score } }, { noLocation: true });
    }
    return this.output();
  }

  // ------------------------------------------------------------ director ---

  runDirector() {
    if (this.forced) return;
    for (const beat of this.story) {
      if (beat.kind !== 'goal' || beat.done) continue;
      if (this.beatPeriod(beat.at) !== this.period || this.t < beat.at) continue;
      if (this.pending && this.pending.kind === 'kick_off') continue;
      const scorer = this.findPlayer(beat.scorer);
      if (!scorer) { beat.done = true; beat.skipped = 'scorer unavailable'; continue; }
      beat.done = true;
      beat.triggered_t = round(this.t, 1);
      this.forced = beat;
      return;
    }
  }

  /**
   * Drive the active scripted goal.
   *
   * Phase 1 (turnover): a 'press' beat waits until the opponent has the ball
   * deep in its own third, a 'counter' beat until the opponent is attacking in
   * our half; the beat team then wins the ball through a recorded pressure and
   * tackle. Play continues naturally while waiting, so the stream has no
   * teleporting ball. A 'build_up' beat simply starts from the next possession.
   * Phase 2: progress the ball, assist, score.
   */
  forcedAction() {
    const beat = this.forced;
    const side = beat.side;
    if (!beat.ballWon) {
      if (this.possession.side === side) {
        if (beat.via === 'build_up') { beat.ballWon = true; } else { this.normalAction(); return; }
      } else {
        const waited = this.t - beat.triggered_t;
        const ready = beat.via === 'press' ? this.ball.ax <= 30 // opponent deep in its own third => our attacking third
          : beat.via === 'counter' ? this.ball.ax >= 55 : true;
        if (!ready && waited < 120) { this.normalAction(); return; }
        beat.ballWon = true;
        const winner = this.nearestDefender();
        const spot = flip(this.ball.ax, this.ball.ay);
        const pressure = this.emit({ type: 'pressure', side, player: winner, ...spot, target_id: this.carrier.id, target: this.carrier.name });
        this.lastPressure = { side, id: pressure.id, t: this.t, period: this.period };
        this.advance(this.rng.range(0.8, 1.6));
        this.emit({ type: 'tackle', side, player: winner, ...spot, target_id: this.carrier.id, target: this.carrier.name, won: true });
        this.winBall(side, winner, 'tackle');
        return;
      }
    }

    const scorer = this.findPlayer(beat.scorer);
    const assister = this.findPlayer(beat.assist) || this.pickByGroup(side, ['midfielder', 'forward'], scorer);
    if (this.carrier === scorer && this.ball.ax >= 80) {
      this.shoot({ forcedGoal: true });
      return;
    }
    if (this.carrier === assister && this.ball.ax >= 62) {
      const target = { ax: this.rng.range(86, 92), ay: this.rng.range(40, 60) };
      this.pass({ forceRecipient: scorer, forceEnd: target, forceType: this.ball.ax > 78 && Math.abs(this.ball.ay - 50) > 25 ? 'cross' : 'through_ball', forceSuccess: true });
      return;
    }
    if (this.ball.ax >= 60 && this.carrier !== assister) {
      const spot = { ax: clamp(this.ball.ax + this.rng.range(4, 10), 64, 80), ay: clamp(this.ball.ay + this.rng.range(-12, 12), 20, 80) };
      this.pass({ forceRecipient: assister, forceEnd: spot, forceType: 'short', forceSuccess: true });
      return;
    }
    // Build-up: progress the ball quickly.
    if (this.rng.chance(0.35) && this.carrier.role_group !== 'goalkeeper') {
      this.carry({ minGain: 8 });
    } else {
      this.pass({ preferForward: true, forceSuccess: true });
    }
  }

  // --------------------------------------------------------- restarts ---

  restart() {
    const { kind, side, ax, ay } = this.pending;
    this.pending = null;
    this.applySubstitutions();
    const changed = this.setPossession(side, kind, ax);
    this.ball = { ax, ay };
    const delay = {
      kick_off: this.events.at(-1)?.type === 'goal' ? this.rng.range(55, 80) : 0,
      throw_in: this.rng.range(7, 16),
      goal_kick: this.rng.range(14, 26),
      corner: this.rng.range(18, 32),
      free_kick: this.rng.range(14, 32),
      penalty: this.rng.range(50, 80),
      keeper_release: this.rng.range(3, 8),
    }[kind] ?? 5;
    this.advance(delay);

    if (kind === 'keeper_release') {
      this.carrier = this.keeper(side);
      this.pass({ setPiece: null, possessionChange: changed });
      return;
    }
    if (kind === 'penalty') {
      const taker = [...this.teams[side].onPitch].sort((a, b) => b.shooting - a.shooting)[0];
      this.carrier = taker;
      this.ball = { ax: 89.5, ay: 50 };
      this.shoot({ situation: 'penalty' });
      return;
    }
    if (kind === 'free_kick' && ax > 70 && Math.abs(ay - 50) < 22 && this.rng.chance(0.4)) {
      this.carrier = [...this.teams[side].onPitch].sort((a, b) => b.shooting + b.passing - a.shooting - a.passing)[0];
      this.shoot({ situation: 'free_kick', possessionChange: changed });
      return;
    }
    const taker = {
      kick_off: () => this.pickByGroup(side, ['forward']),
      throw_in: () => this.pickNearSpot(side, ax, ay),
      goal_kick: () => this.keeper(side),
      corner: () => this.pickByGroup(side, ['midfielder', 'forward']),
      free_kick: () => this.pickByGroup(side, ['midfielder', 'defender']),
    }[kind]?.() ?? this.pickNearSpot(side, ax, ay);
    this.carrier = taker;
    if (kind === 'corner') {
      this.pass({ setPiece: 'corner', forceType: 'cross', possessionChange: changed });
    } else {
      this.pass({ setPiece: kind, forceType: kind === 'kick_off' ? 'back' : undefined, possessionChange: changed });
    }
  }

  applySubstitutions() {
    for (const side of ['home', 'away']) {
      const team = this.teams[side];
      while (team.subPlan.length && team.subPlan[0] <= this.t && this.period === 2 && team.subsMade < 5) {
        team.subPlan.shift();
        // Never substitute a player who still has a scripted moment to deliver.
        const protectedIds = new Set(this.story.filter(b => b.kind === 'goal' && (!b.done || this.forced === b)).flatMap(b => [b.scorer, b.assist]));
        const outfield = team.onPitch.filter(p => p.role_group !== 'goalkeeper' && !protectedIds.has(p.id));
        // Prefer replacing tired attackers/midfielders with a like-for-like bench player.
        const bench = team.bench.filter(p => p.role_group !== 'goalkeeper');
        if (!bench.length) break;
        const incoming = this.rng.pick(bench);
        const sameGroup = outfield.filter(p => p.role_group === incoming.role_group);
        const outgoing = (sameGroup.length ? sameGroup : outfield).sort((a, b) => b.distance_m - a.distance_m)[0];
        incoming.slot = outgoing.slot;
        team.onPitch = team.onPitch.map(p => (p === outgoing ? incoming : p));
        team.bench = team.bench.filter(p => p !== incoming);
        team.subsMade += 1;
        if (this.carrier === outgoing) this.carrier = incoming;
        this.emit({
          type: 'substitution', side, player: incoming,
          player_off_id: outgoing.id, player_off: outgoing.name,
          player_on_id: incoming.id, player_on: incoming.name,
          position: outgoing.position,
        }, { noLocation: true });
        this.advance(this.rng.range(15, 35));
      }
    }
  }

  // ---------------------------------------------------------- on the ball ---

  onBallAction() {
    if (!this.possession) {
      this.pending = { kind: 'kick_off', side: 'home', ax: 50, ay: 50 };
      return;
    }
    if (this.forced) this.forcedAction();
    else this.normalAction();
  }

  normalAction() {
    const side = this.possession.side;
    const dSide = other(side);
    const style = this.teams[side].style;
    const carrier = this.carrier;

    // 1) Defensive pressure on the ball carrier.
    const dStyle = this.teams[dSide].style;
    const ballInDefFrame = 100 - this.ball.ax; // distance of the ball from the defenders' own goal
    const height = ballInDefFrame > 66 ? dStyle.press_height : ballInDefFrame > 33 ? 0.55 : ballInDefFrame > 17 ? 0.6 : 0.85;
    const pPress = clamp(0.26 * dStyle.press_intensity * height * 2.2 * this.pressMultiplier(dSide), 0.04, 0.75);
    let underPressure = false;
    if (carrier.role_group !== 'goalkeeper' && this.rng.chance(pPress)) {
      underPressure = true;
      const presser = this.nearestDefender();
      const pressure = this.emit({ type: 'pressure', side: dSide, player: presser, ...flip(this.ball.ax, this.ball.ay), target_id: carrier.id, target: carrier.name });
      this.lastPressure = { side: dSide, id: pressure.id, t: this.t, period: this.period };
      this.advance(this.rng.range(0.4, 1.2));

      // Tackle attempt (or a foul committed while pressing). Defenders are far
      // more careful inside their own box, which keeps penalties rare.
      const foulCare = inBox(this.ball.ax, this.ball.ay) ? 0.08 : 1;
      if (this.rng.chance(0.06 * foulCare)) return this.foul(presser, carrier);
      const pTackle = this.inPressSpell(dSide) ? 0.3 : 0.17;
      if (this.rng.chance(pTackle)) {
        const winP = clamp(0.6 + (presser.defending - 0.6) * 0.8 - (carrier.passing - 0.75) * 0.5, 0.25, 0.75);
        const r = this.rng.next();
        if (r < 0.16 * foulCare) return this.foul(presser, carrier);
        if (r < 0.16 + winP * 0.84) {
          this.emit({ type: 'tackle', side: dSide, player: presser, ...flip(this.ball.ax, this.ball.ay), target_id: carrier.id, target: carrier.name, won: true });
          this.winBall(dSide, presser, 'tackle');
          return;
        }
        this.emit({ type: 'tackle', side: dSide, player: presser, ...flip(this.ball.ax, this.ball.ay), target_id: carrier.id, target: carrier.name, won: false });
        this.advance(0.6);
      }
    }

    // 2) Choose an action.
    const ax = this.ball.ax;
    const ay = this.ball.ay;
    const counter = this.isCounter();
    const box = inBox(ax, ay);
    const wide = Math.abs(ay - 50) > 26;
    const weights = {
      pass: 1.0,
      carry: carrier.role_group === 'goalkeeper' ? 0 : (0.22 + (carrier.pace - 31) * 0.03) * (counter ? 1.8 : 1) * (underPressure ? 0.6 : 1),
      shoot: ax < 68 ? 0 : carrier.shooting * (box ? 0.1 : ax > 76 ? 0.055 : 0.018) * (underPressure ? 0.8 : 1),
      cross: ax > 74 && wide ? 0.3 : 0,
      clear: ax < 22 && carrier.role_group === 'defender' ? (underPressure ? 0.7 : 0.08) : 0,
    };
    const action = this.rng.weighted(weights);
    if (action === 'shoot') return this.shoot({ underPressure, situation: counter ? 'counter' : 'open_play' });
    if (action === 'carry') return this.carry({ underPressure, counter });
    if (action === 'cross') return this.pass({ forceType: 'cross', underPressure });
    if (action === 'clear') return this.clearance(underPressure);
    return this.pass({ underPressure, counter, preferForward: style.directness > 0.5 });
  }

  isCounter() {
    const p = this.possession;
    return !!p && (p.how === 'tackle' || p.how === 'interception' || p.how === 'loose_ball') && p.startAx < 50 && this.t - p.startT < 14;
  }

  // ---------------------------------------------------------------- pass ---

  choosePassType({ underPressure, counter, preferForward }) {
    const style = this.teams[this.possession.side].style;
    const ax = this.ball.ax;
    const isKeeper = this.carrier.role_group === 'goalkeeper';
    return this.rng.weighted({
      short: isKeeper ? 0.5 : 0.62,
      back: ax > 25 ? (underPressure ? 0.28 : 0.13) : 0.03,
      long: (isKeeper ? 0.6 : 0.05) + style.directness * (counter ? 0.35 : 0.18) + (preferForward ? 0.05 : 0),
      through_ball: ax > 42 && ax < 82 && !isKeeper ? 0.05 + style.directness * 0.06 + (counter ? 0.12 : 0) : 0,
      switch: ax > 25 && ax < 75 && !isKeeper ? 0.035 : 0,
    });
  }

  chooseRecipient(type, exclude) {
    const side = this.possession.side;
    const from = this.ball;
    const mates = this.teams[side].onPitch.filter(p => p !== exclude);
    return this.rng.weightedItem(mates, p => {
      const pos = this.positionOf(p, side);
      const fwd = pos.ax - from.ax;
      const d = metres(from, pos);
      const keeper = p.role_group === 'goalkeeper';
      switch (type) {
        case 'back': return fwd < -2 ? Math.exp(-((d - 14) ** 2) / 120) * (keeper ? 0.6 : 1) : 0.02;
        case 'long': return keeper ? 0 : fwd > 12 ? Math.exp(-((d - 38) ** 2) / 300) * (p.role_group === 'forward' ? 1.6 : 1) : 0.02;
        case 'through_ball': return fwd > 6 && (p.role_group === 'forward' || p.position === 'AM') ? 1 + fwd / 20 : 0.01;
        case 'switch': return Math.abs(pos.ay - from.ay) > 35 && !keeper ? 1 : 0.01;
        case 'cross': return pos.ax > 70 && (p.role_group === 'forward' || p.position === 'AM') ? 1.5 : 0.05;
        default: return keeper ? (from.ax < 30 ? 0.15 : 0) : Math.exp(-((d - 15) ** 2) / 160) * (fwd > -12 ? 1.2 : 0.4);
      }
    });
  }

  pass({ underPressure = false, counter = false, preferForward = false, forceType, forceRecipient, forceEnd, forceSuccess, setPiece = null, possessionChange = false } = {}) {
    const side = this.possession.side;
    const dSide = other(side);
    const passer = this.carrier;
    const type = forceType || this.choosePassType({ underPressure, counter, preferForward });
    const recipient = forceRecipient || this.chooseRecipient(type, passer);
    const rPos = this.positionOf(recipient, side);
    let end = forceEnd || {
      ax: clamp(rPos.ax + this.rng.normal(type === 'through_ball' ? 6 : 0, 2.5), 1, 99),
      ay: clamp(rPos.ay + this.rng.normal(0, 3), 1, 99),
    };
    if (type === 'cross' && !forceEnd) end = { ax: this.rng.range(84, 95), ay: this.rng.range(36, 64) };
    const start = { ...this.ball };
    const distance = metres(start, end);
    const forward = ((end.ax - start.ax) / 100) * 105;

    const team = this.teams[side];
    const difficulty = clamp(
      distance / 70 * 0.45
      + Math.max(0, forward) / 50 * 0.22
      + (underPressure ? 0.16 : 0)
      + (end.ax > 70 ? 0.12 : 0)
      + (type === 'cross' ? 0.32 : 0)
      + (type === 'through_ball' ? 0.22 : 0)
      + (type === 'long' ? 0.1 : 0),
      0, 1,
    );
    const skill = 0.55 * team.style.passing + 0.45 * passer.passing;
    const pSuccess = clamp((1.04 - difficulty * 0.62) * (0.8 + skill * 0.24) * this.momentum[side], 0.12, 0.985);
    const successful = forceSuccess ? true : this.rng.chance(pSuccess);
    const height = type === 'long' || type === 'cross' || type === 'switch' || setPiece === 'goal_kick' && distance > 30 ? 'high' : 'ground';
    const ballSpeed = height === 'high' ? this.rng.range(55, 85) : clamp(28 + distance * 1.2 + this.rng.normal(0, 5), 25, 80);
    const travel = (distance / (ballSpeed / 3.6)) * (height === 'high' ? 1.35 : 1);

    const base = {
      type: 'pass', side, player: passer, ax: start.ax, ay: start.ay,
      pass_type: type,
      set_piece: setPiece || undefined,
      height,
      distance_m: round(distance, 1),
      ball_speed_kmh: round(ballSpeed, 0),
      progressive: forward >= 10 && end.ax > 40 ? true : undefined,
      difficulty: round(difficulty, 2),
      under_pressure: underPressure || undefined,
      possession_change: possessionChange || undefined,
    };

    if (successful) {
      const ev = this.emit({ ...base, endAx: end.ax, endAy: end.ay, recipient_id: recipient.id, recipient: recipient.name, successful: true, outcome: 'complete' });
      this.advance(travel + this.rng.range(0.6, 1.5) / team.style.tempo);
      this.ball = end;
      this.carrier = recipient;
      this.possession.passes += 1;
      this.lastPass = ev;
      // Header from a completed cross.
      if (type === 'cross' && !this.forced && recipient.role_group !== 'goalkeeper' && this.rng.chance(0.35)) {
        this.shoot({ bodyPart: 'head', situation: setPiece === 'corner' ? 'corner' : 'open_play' });
      }
      return ev;
    }

    // Failure modes.
    const outRoll = this.rng.next();
    const pOut = type === 'long' || type === 'switch' ? 0.35 : type === 'cross' ? 0.25 : 0.1;
    if (type === 'through_ball' && outRoll < 0.3) {
      this.emit({ ...base, endAx: end.ax, endAy: end.ay, recipient_id: recipient.id, recipient: recipient.name, successful: false, outcome: 'offside' });
      this.emit({ type: 'offside', side, player: recipient, ax: end.ax, ay: end.ay });
      this.advance(travel);
      const d = flip(end.ax, end.ay);
      this.pending = { kind: 'free_kick', side: dSide, ax: d.ax, ay: d.ay };
      return null;
    }
    if (outRoll < pOut) {
      const overLine = end.ax > 97 || (type === 'cross' && this.rng.chance(0.5));
      const outEnd = overLine ? { ax: 100, ay: end.ay } : { ax: end.ax, ay: end.ay < 50 ? 0 : 100 };
      this.emit({ ...base, endAx: outEnd.ax, endAy: outEnd.ay, recipient_id: recipient.id, recipient: recipient.name, successful: false, outcome: 'out_of_play' });
      this.advance(travel);
      const d = flip(outEnd.ax, outEnd.ay);
      // A cross that goes behind is often deflected by a defender first.
      const deflected = overLine && type === 'cross' && this.rng.chance(0.45);
      this.pending = deflected
        ? { kind: 'corner', side, ax: 99.5, ay: end.ay < 50 ? 0.5 : 99.5 }
        : overLine
          ? { kind: 'goal_kick', side: dSide, ax: 5, ay: 50 }
          : { kind: 'throw_in', side: dSide, ax: d.ax, ay: d.ay < 50 ? 0.5 : 99.5 };
      return null;
    }
    // Did not reach its target: cut out in flight, or lost in a duel / loose ball.
    const f = this.rng.range(0.45, 1);
    const cut = { ax: start.ax + (end.ax - start.ax) * f, ay: start.ay + (end.ay - start.ay) * f };
    const dCut = flip(cut.ax, cut.ay);
    const defender = this.nearestDefender(inBox(cut.ax, cut.ay));
    if (dCut.ax < 17 && this.rng.chance(0.65)) {
      // Ball into the defenders' box: headed / kicked clear.
      this.emit({ ...base, endAx: cut.ax, endAy: cut.ay, recipient_id: recipient.id, recipient: recipient.name, successful: false, outcome: 'cleared' });
      this.advance(travel * f);
      this.ball = cut;
      return this.defensiveClearance(defender);
    }
    const intercepted = this.rng.chance(0.22);
    const passEv = this.emit({ ...base, endAx: cut.ax, endAy: cut.ay, recipient_id: recipient.id, recipient: recipient.name, successful: false, outcome: intercepted ? 'intercepted' : 'incomplete' });
    this.advance(travel * f);
    this.ball = cut;
    if (intercepted) {
      this.emit({ type: 'interception', side: dSide, player: defender, ax: dCut.ax, ay: dCut.ay, pass_id: passEv.id });
      this.winBall(dSide, defender, 'interception');
    } else {
      this.winBall(dSide, defender, 'loose_ball');
    }
    return null;
  }

  // --------------------------------------------------------------- carry ---

  carry({ underPressure = false, counter = false, minGain = 0 } = {}) {
    const side = this.possession.side;
    const p = this.carrier;
    const start = { ...this.ball };
    const gain = Math.max(minGain, this.rng.range(counter ? 6 : 2, counter ? 22 : 11));
    const end = {
      ax: clamp(start.ax + gain, 2, 94),
      ay: clamp(start.ay + this.rng.normal(0, 6), 3, 97),
    };
    const distance = metres(start, end);
    const speed = clamp(this.rng.normal(counter ? 22 : 15, 3), 8, p.pace - 1);
    this.emit({
      type: 'carry', side, player: p, ax: start.ax, ay: start.ay, endAx: end.ax, endAy: end.ay,
      distance_m: round(distance, 1), under_pressure: underPressure || undefined,
    });
    this.advance(distance / (speed / 3.6));
    // Sprint indicator: emitted only when the carry crosses the speed threshold.
    if (distance > 12 && (counter || this.rng.chance(0.18))) {
      const top = clamp(this.rng.normal(p.pace - 1.2, 1.1), 24, p.pace);
      if (top >= SPRINT_THRESHOLD_KMH) {
        this.emit({
          type: 'sprint', side, player: p, ax: end.ax, ay: end.ay,
          top_speed_kmh: round(top, 1), sprint_distance_m: round(distance + this.rng.range(3, 12), 1),
          total_distance_km: round(p.distance_m / 1000, 2), threshold_kmh: SPRINT_THRESHOLD_KMH,
        });
      }
    }
    this.ball = end;
  }

  // ----------------------------------------------------------- clearance ---

  clearance(underPressure) {
    const side = this.possession.side;
    const dSide = other(side);
    const p = this.carrier;
    const land = { ax: this.rng.range(42, 72), ay: this.rng.range(10, 90) };
    this.emit({ type: 'clearance', side, player: p, ax: this.ball.ax, ay: this.ball.ay, endAx: land.ax, endAy: land.ay, under_pressure: underPressure || undefined });
    this.advance(this.rng.range(2, 3.5));
    if (this.rng.chance(0.38)) {
      const d = flip(land.ax, land.ay < 50 ? 0 : 100);
      this.pending = { kind: 'throw_in', side: dSide, ax: d.ax, ay: d.ay < 50 ? 0.5 : 99.5 };
      return;
    }
    this.ball = land;
    if (this.rng.chance(0.55)) {
      const d = flip(land.ax, land.ay);
      this.ball = land;
      const winner = this.pickNearSpot(dSide, d.ax, d.ay);
      this.winBall(dSide, winner, 'loose_ball');
    } else {
      const winner = this.pickNearSpot(side, land.ax, land.ay);
      this.emit({ type: 'recovery', side, player: winner, ax: land.ax, ay: land.ay, how: 'loose_ball' });
      this.carrier = winner;
    }
  }

  /**
   * The defending side clears the ball out of its own box (no possession is
   * established). this.ball is in the attacking side's frame.
   */
  defensiveClearance(defender) {
    const side = this.possession.side;
    const dSide = other(side);
    const from = flip(this.ball.ax, this.ball.ay);
    const land = { ax: this.rng.range(35, 62), ay: this.rng.range(8, 92) }; // defenders' frame
    this.emit({ type: 'clearance', side: dSide, player: defender, ax: from.ax, ay: from.ay, endAx: land.ax, endAy: land.ay, headed: this.rng.chance(0.5) || undefined });
    this.advance(this.rng.range(2, 3.5));
    const r = this.rng.next();
    if (r < 0.2) {
      this.pending = { kind: 'corner', side, ax: 99.5, ay: from.ay < 50 ? 99.5 : 0.5 };
      return null;
    }
    const landA = flip(land.ax, land.ay); // attacking side's frame
    if (r < 0.38) {
      this.pending = { kind: 'throw_in', side, ax: landA.ax, ay: landA.ay < 50 ? 0.5 : 99.5 };
      return null;
    }
    this.ball = landA;
    if (r < 0.7) {
      // Second ball won by the attacking side: same possession continues.
      const winner = this.pickNearSpot(side, landA.ax, landA.ay);
      this.emit({ type: 'recovery', side, player: winner, ax: landA.ax, ay: landA.ay, how: 'loose_ball' });
      this.carrier = winner;
    } else {
      this.winBall(dSide, this.pickNearSpot(dSide, land.ax, land.ay), 'loose_ball');
    }
    return null;
  }

  // ---------------------------------------------------- change of control ---

  /** dSide (currently defending) gains control at the current ball spot. */
  winBall(dSide, player, how) {
    const d = flip(this.ball.ax, this.ball.ay);
    const linked = this.lastPressure && this.lastPressure.side === dSide && this.lastPressure.period === this.period
      && round(this.t, 1) - round(this.lastPressure.t, 1) <= PRESSURE_LINK_WINDOW_S
      ? this.lastPressure.id : undefined;
    this.ball = d;
    this.setPossession(dSide, how, d.ax);
    this.carrier = player;
    this.emit({
      type: 'recovery', side: dSide, player, ax: d.ax, ay: d.ay,
      how, possession_change: true,
      after_pressure: linked ? true : undefined,
      linked_pressure_id: linked,
    });
    this.advance(this.rng.range(0.6, 1.4));
  }

  foul(offender, victim) {
    const side = this.possession.side;
    const dSide = other(side);
    const spot = { ...this.ball };
    const d = flip(spot.ax, spot.ay);
    this.emit({ type: 'foul', side: dSide, player: offender, ax: d.ax, ay: d.ay, fouled_id: victim.id, fouled: victim.name });
    this.advance(this.rng.range(2, 5));
    if (this.rng.chance(0.17)) {
      offender.yellow += 1;
      const red = offender.yellow >= 2;
      this.emit({ type: 'card', side: dSide, player: offender, ax: d.ax, ay: d.ay, card: red ? 'second_yellow' : 'yellow' });
      if (red) {
        offender.sent_off = true;
        this.teams[dSide].onPitch = this.teams[dSide].onPitch.filter(p => p !== offender);
      }
    }
    this.pending = inBox(spot.ax, spot.ay) && this.rng.chance(0.75)
      ? { kind: 'penalty', side, ax: 89.5, ay: 50 }
      : { kind: 'free_kick', side, ax: spot.ax, ay: spot.ay };
  }

  // ---------------------------------------------------------------- shot ---

  shoot({ underPressure = false, bodyPart = 'foot', situation = 'open_play', forcedGoal = false, possessionChange = false } = {}) {
    const side = this.possession.side;
    const dSide = other(side);
    const shooter = this.carrier;
    const spot = { ...this.ball };
    if (situation === 'counter' && !this.isCounter()) situation = 'open_play';
    const xg = expectedGoals({ ax: spot.ax, ay: spot.ay, bodyPart, situation, underPressure });
    const { distance } = shotGeometry(spot.ax, spot.ay);
    const keyPass = this.lastPass && this.lastPass.recipient_id === shooter.id && this.t - this.lastPass.t < 8 ? this.lastPass : null;

    let outcome;
    if (forcedGoal) {
      outcome = 'goal';
    } else {
      const finishing = this.teams[side].style.finishing * (0.75 + shooter.shooting * 0.35);
      // Penalties keep their real conversion; open play is scaled so scripted goals dominate the story.
      const factor = situation === 'penalty' ? 1 : this.config.naturalGoalFactor;
      const pGoal = clamp(xg * finishing * factor, 0, 0.9);
      const r = this.rng.next();
      const pBlock = situation === 'penalty' ? 0 : underPressure ? 0.3 : 0.22;
      if (r < pBlock) outcome = 'blocked';
      else if (r < pBlock + pGoal) outcome = 'goal';
      else if (r < pBlock + pGoal + 0.03) outcome = 'woodwork';
      else outcome = this.rng.chance(clamp(0.2 + shooter.shooting * 0.14 + xg * 0.45, 0.15, 0.75)) ? 'saved' : 'off_target';
    }
    const onTarget = outcome === 'goal' || outcome === 'saved';
    const speed = bodyPart === 'head' ? this.rng.range(38, 62) : situation === 'penalty' ? this.rng.range(85, 110) : this.rng.range(70, 118);
    const goalMouth = { ax: 100, ay: onTarget ? this.rng.range(45, 55) : this.rng.chance(0.5) ? this.rng.range(30, 44.5) : this.rng.range(55.5, 70) };

    const shot = this.emit({
      type: 'shot', side, player: shooter, ax: spot.ax, ay: spot.ay, endAx: goalMouth.ax, endAy: goalMouth.ay,
      xg, distance_m: round(distance, 1), body_part: bodyPart, situation,
      shot_speed_kmh: round(speed, 0), on_target: onTarget, outcome,
      under_pressure: underPressure || undefined,
      key_pass_id: keyPass?.id, possession_change: possessionChange || undefined,
    });
    this.advance(this.rng.range(0.8, 1.6));

    if (outcome === 'goal') {
      this.score[side] += 1;
      const assister = keyPass ? this.playersById.get(keyPass.player_id) : null;
      this.emit({
        type: 'goal', side, player: shooter, ax: spot.ax, ay: spot.ay,
        scorer_id: shooter.id, scorer: shooter.name,
        assist_id: assister?.id, assist: assister?.name,
        shot_id: shot.id, confirmed: true,
        score: { ...this.score },
      });
      // Only the scripted team's goal completes a beat; an unscripted goal by
      // the other side while the beat waits for its turnover leaves it active.
      if (this.forced && forcedGoal) {
        this.forced.goal_t = round(this.t, 1);
        this.forced = null;
      }
      this.pending = { kind: 'kick_off', side: dSide, ax: 50, ay: 50 };
      return;
    }
    const keeper = this.keeper(dSide);
    if (outcome === 'saved') {
      const held = this.rng.chance(0.55);
      this.emit({ type: 'save', side: dSide, player: keeper, ...flip(97, 50), shot_id: shot.id, held });
      this.advance(this.rng.range(1, 3));
      if (held) {
        this.setPossession(dSide, 'keeper', 5);
        this.ball = { ax: 5, ay: 50 };
        this.carrier = keeper;
        this.pending = { kind: 'keeper_release', side: dSide, ax: 8, ay: 50 };
      } else if (this.rng.chance(0.6)) {
        this.pending = { kind: 'corner', side, ax: 99.5, ay: this.rng.chance(0.5) ? 0.5 : 99.5 };
      } else {
        this.ball = { ax: 92, ay: this.rng.range(30, 70) };
        this.winBall(dSide, this.pickNearSpot(dSide, 8, 50), 'loose_ball');
      }
      return;
    }
    if (outcome === 'blocked') {
      const blocker = this.nearestDefender();
      this.emit({ type: 'block', side: dSide, player: blocker, ...flip(spot.ax + 2, spot.ay), shot_id: shot.id });
      this.advance(0.8);
      const r = this.rng.next();
      if (r < 0.35) this.pending = { kind: 'corner', side, ax: 99.5, ay: spot.ay < 50 ? 0.5 : 99.5 };
      else if (r < 0.7) this.winBall(dSide, blocker, 'loose_ball');
      else {
        const winner = this.pickNearSpot(side, spot.ax - 6, spot.ay);
        this.ball = { ax: spot.ax - 6, ay: spot.ay };
        this.emit({ type: 'recovery', side, player: winner, ax: this.ball.ax, ay: this.ball.ay, how: 'loose_ball' });
        this.carrier = winner;
      }
      return;
    }
    // off target or woodwork
    if (outcome === 'woodwork' && this.rng.chance(0.5)) {
      this.ball = { ax: 90, ay: this.rng.range(35, 65) };
      this.winBall(dSide, this.nearestDefender(), 'loose_ball');
      return;
    }
    this.pending = { kind: 'goal_kick', side: dSide, ax: 5, ay: 50 };
  }

  // -------------------------------------------------------------- output ---

  output() {
    const squads = {};
    for (const side of ['home', 'away']) {
      const team = this.config.teams[side];
      squads[side] = {
        id: team.id, name: team.name, short_name: team.short_name, formation: team.formation,
        colors: team.colors, style: team.style,
        players: [...team.starters.map(p => ({ ...p, starter: true })), ...team.bench.map(p => ({ ...p, starter: false }))]
          .map(({ base, ...p }) => p),
      };
    }
    const script = this.story.map(b => ({
      kind: b.kind, side: b.side, label: b.label,
      ...(b.kind === 'goal' ? {
        planned_at: b.at, triggered_t: b.triggered_t, goal_t: b.goal_t, scorer_id: b.scorer, assist_id: b.assist, via: b.via,
        skipped: b.skipped, event_ids: b.event_ids,
        goal_event_id: b.event_ids.find(id => id.startsWith('G-')),
      } : { from_t: b.from, to_t: b.to, intensity: b.intensity }),
    }));
    return {
      schema_version: SCHEMA_VERSION,
      synthetic: true,
      meta: {
        match_id: this.config.matchId || `SYN-${this.config.teams.home.id}-${this.config.teams.away.id}-${slug(this.config.seed)}`,
        seed: this.config.seed,
        competition: this.config.competition,
        venue: this.config.venue,
        kickoff_utc: this.config.kickoffUtc,
        home: this.config.teams.home.name,
        away: this.config.teams.away.name,
        final_score: { ...this.score },
        stoppage_seconds: { ...this.stoppage },
        coordinate_system: 'x,y in 0..100; home attacks towards x=100 in period 1 and x=0 in period 2. zone/channel are relative to the acting team.',
        disclaimer: 'Fully synthetic, fictional match. No real clubs, players or league data.',
      },
      squads,
      script,
      events: this.events,
    };
  }
}

const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const ID_PREFIX = {
  pass: 'P', carry: 'C', pressure: 'PR', tackle: 'T', interception: 'I', recovery: 'R',
  shot: 'S', goal: 'G', save: 'SV', block: 'B', clearance: 'CL', foul: 'F', card: 'CD',
  offside: 'OF', substitution: 'SUB', sprint: 'SP', physical_milestone: 'PM',
  period_start: 'KO', period_end: 'END',
};
