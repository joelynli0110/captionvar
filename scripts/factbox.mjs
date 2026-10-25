#!/usr/bin/env node
/**
 * Factbox over stdio, one JSON request per line and one JSON response per
 * line. The agent workflow normally reaches the same operations through the
 * MCP server (scripts/referee-mcp.mjs); this is the dependency-free fallback.
 *
 *   node scripts/factbox.mjs --seed captionvar-demo-6
 *
 * Requests: {"id": 1, "op": "<op>", ...}
 *   info                                   -> match id, number of moments
 *   moments                                -> narrator packets for every moment
 *   extractor_packet  {index, text}        -> what the extractor may see
 *   verify            {index, text, extracted}
 *                                          -> claims, segments, verdict (only events up to the moment)
 *   editor_packet     {index, text, verdict}
 *   template          {index, verdict}     -> safe English caption from true facts
 *   decision_header   {index}              -> fields the trace needs (seq, t, minute, facts...)
 *   simulated         {index, seed}        -> the test narrator's caption, for offline runs
 */
import { createInterface } from 'node:readline';
import { createFactbox, seedFromArgs } from './factbox-ops.mjs';

const OPS = createFactbox(seedFromArgs());

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', line => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
    const fn = OPS[req.op];
    if (!fn) throw new Error(`unknown op ${req.op}`);
    process.stdout.write(`${JSON.stringify({ id: req.id, ok: true, result: fn(req) })}\n`);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ id: req?.id ?? null, ok: false, error: String(err?.message || err) })}\n`);
  }
});
