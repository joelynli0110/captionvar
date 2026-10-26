#!/usr/bin/env node
/**
 * The machine-readable overlay feed for one match: every threshold-triggered
 * player tag (sprint, long or difficult pass, shot, distance milestone), timed
 * on the match clock, as JSON lines a graphics renderer can consume.
 *
 *   node scripts/overlay_feed.mjs --seed captionvar-demo-6 > overlays.jsonl
 */
import { generateMatch } from '../src/sim/generateMatch.js';
import { indexPeople } from '../src/broadcast/narrator.js';
import { overlayFeed } from '../src/broadcast/overlays.js';
import { seedFromArgs } from './factbox-ops.mjs';

process.stdout.on('error', err => { if (err.code === 'EPIPE') process.exit(0); throw err; });
const match = generateMatch({ seed: seedFromArgs() });
for (const tag of overlayFeed(match, indexPeople(match))) process.stdout.write(`${JSON.stringify(tag)}\n`);
