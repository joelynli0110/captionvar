#!/usr/bin/env node
/**
 * Generate a synthetic match and write it to disk, or stream it live.
 *
 *   node scripts/generate_match.mjs                         # default demo match
 *   node scripts/generate_match.mjs --seed derby-7 --out data/matches/derby-7.json
 *   node scripts/generate_match.mjs --story none            # no scripted beats
 *   node scripts/generate_match.mjs --stream --speed 60     # NDJSON on stdout, paced on the match clock
 *
 * Exits non-zero if the generated match fails validation.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { generateMatch, DEFAULT_STORY } from '../src/sim/generateMatch.js';
import { validateMatch } from '../src/sim/validate.js';
import { matchStats } from '../src/sim/stats.js';
import { liveFeed } from '../src/sim/stream.js';

const DEMO_SEED = 'captionvar-demo-6';

function parseArgs(argv) {
  const args = { seed: DEMO_SEED, out: null, story: 'default', stream: false, speed: 20, naturalGoalFactor: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[(i += 1)];
    if (a === '--seed') args.seed = next();
    else if (a === '--out') args.out = next();
    else if (a === '--story') args.story = next();
    else if (a === '--stream') args.stream = true;
    else if (a === '--speed') args.speed = Number(next());
    else if (a === '--natural-goals') args.naturalGoalFactor = Number(next());
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('usage: generate_match.mjs [--seed S] [--out FILE] [--story default|none] [--natural-goals F] [--stream --speed N]');
  process.exit(0);
}

const match = generateMatch({
  seed: args.seed,
  story: args.story === 'none' ? [] : DEFAULT_STORY,
  ...(args.naturalGoalFactor != null ? { naturalGoalFactor: args.naturalGoalFactor } : {}),
});

const problems = validateMatch(match);
if (problems.length) {
  console.error(`validation failed (${problems.length} problems):\n  ${problems.slice(0, 20).join('\n  ')}`);
  process.exit(1);
}

if (args.stream) {
  for await (const ev of liveFeed(match, { speed: args.speed })) {
    process.stdout.write(`${JSON.stringify(ev)}\n`);
  }
} else {
  const out = resolve(args.out || `src/data/matches/${match.meta.match_id.toLowerCase()}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(match)}\n`);
  const s = matchStats(match.events);
  console.log(`${match.meta.home} ${s.score.home}-${s.score.away} ${match.meta.away}  (seed "${args.seed}")`);
  console.log(`events: ${match.events.length}  possession: ${s.possession.home}%-${s.possession.away}%  xG: ${s.home.xg}-${s.away.xg}  shots: ${s.home.shots}-${s.away.shots}`);
  for (const beat of match.script) {
    console.log(`  script: ${beat.label}${beat.goal_event_id ? ` -> ${beat.goal_event_id}` : beat.skipped ? ` (skipped: ${beat.skipped})` : ''}`);
  }
  console.log(`wrote ${out}`);
}
