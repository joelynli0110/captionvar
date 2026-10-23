/**
 * Calibration report: average per-team match totals over many seeds,
 * compared with typical top-flight reference ranges.
 *
 *   node scripts/calibrate_sim.mjs [numSeeds]
 *
 * Reference ranges are rounded, publicly reported per-team-per-match averages
 * for top European leagues (event-data providers differ in definitions, so
 * these are sanity bands, not targets to overfit).
 */
import { generateMatch } from '../src/sim/generateMatch.js';
import { teamStats } from '../src/sim/stats.js';

const REFERENCE = {
  passes: [400, 600],
  pass_accuracy: [77, 88],
  shots: [10, 16],
  shots_on_target: [3, 6],
  xg: [1.0, 1.9],
  pressures: [100, 180],
  tackles: [12, 22],
  interceptions: [7, 14],
  fouls: [8, 13],
  yellow_cards: [1, 3],
  corners: [3, 7],
  offsides: [1, 3],
  crosses: [10, 22],
};

const n = Number(process.argv[2] || 30);
const sums = {};
let events = 0;
let scriptedGoals = 0;
let goals = 0;

for (let i = 0; i < n; i += 1) {
  const match = generateMatch({ seed: `calibration-${i}` });
  events += match.events.length;
  goals += match.events.filter(e => e.type === 'goal').length;
  scriptedGoals += match.script.filter(b => b.goal_event_id).length;
  for (const side of ['home', 'away']) {
    const s = teamStats(match.events, side);
    for (const [k, v] of Object.entries(s)) sums[k] = (sums[k] || 0) + (v || 0);
  }
}

const rows = Object.entries(sums).map(([k, v]) => {
  const mean = v / (2 * n);
  const ref = REFERENCE[k];
  const flag = ref ? (mean < ref[0] ? 'LOW' : mean > ref[1] ? 'HIGH' : 'ok') : '';
  return { stat: k, mean_per_team: Math.round(mean * 10) / 10, reference: ref ? `${ref[0]}-${ref[1]}` : '', flag };
});
console.table(rows);
console.log(`events/match: ${Math.round(events / n)}  goals/match: ${(goals / n).toFixed(2)} (scripted ${(scriptedGoals / n).toFixed(2)}, natural ${((goals - scriptedGoals) / n).toFixed(2)})`);
