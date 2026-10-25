#!/usr/bin/env node
/**
 * The CaptionVAR referee as an MCP server (stdio).
 *
 *   node scripts/referee-mcp.mjs --seed captionvar-demo-6
 *
 * The agent workflow (agents/captionvar_agents/factbox.py) calls these tools
 * over MCP: the Referee executor calls `check_caption`, the Extractor and
 * Editor get what they may see from `extractor_view` and `editor_view`, and
 * the Publisher falls back to `caption_from_data`. Any other MCP client can
 * use the same tools, for example GitHub Copilot agent mode in VS Code
 * through .vscode/mcp.json.
 *
 * Every tool is read-only and deterministic. `check_caption` sees only the
 * events recorded up to the moment being captioned.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createFactbox, seedFromArgs } from './factbox-ops.mjs';

const seed = seedFromArgs();
const ops = createFactbox(seed);

const index = z.number().int().min(0).describe('Moment index, from list_moments');
const text = z.string().describe('The caption, exactly as written');
const verdict = z.record(z.string(), z.any()).describe('A verdict returned by check_caption');
const claim = z.record(z.string(), z.any());

/**
 * Tools, in the order an agent workflow uses them. `op` is the factbox
 * operation behind each one; the Python client maps its calls through it.
 */
export const TOOLS = [
  {
    name: 'match_info', op: 'info', title: 'Match info',
    description: 'Match id, clubs and number of captionable moments of the synthetic match.',
    input: {},
  },
  {
    name: 'list_moments', op: 'moments', title: 'List moments',
    description: 'Every captionable moment (goals, shots, cards, substitutions, sprints, pressing spells) with the facts and recent actions a narrator may use.',
    input: {},
  },
  {
    name: 'extractor_view', op: 'extractor_packet', title: 'What the claim extractor may see',
    description: 'The caption and the squad lists for one moment, and nothing about what actually happened, so claims are reported as written.',
    input: { index, text },
  },
  {
    name: 'check_caption', op: 'verify', title: 'VAR check a caption',
    description: 'Check every claim of a caption against the match events recorded up to its moment. Returns each claim as supported, contradicted or unverifiable with evidence event IDs, and an overall verdict: VERIFY (airs as written), QUALIFY (a detail is removed) or WITHHOLD (the main claim is false).',
    input: { index, text, extracted: z.array(claim).describe('Claims from the extractor: kind, span and the asserted values') },
  },
  {
    name: 'editor_view', op: 'editor_packet', title: 'What the editor may see',
    description: 'The failed caption, the verdict on each claim and the true facts of the moment, for a rewrite.',
    input: { index, text, verdict },
  },
  {
    name: 'caption_from_data', op: 'template', title: 'Caption built from the data',
    description: 'A safe English caption rendered straight from the verified facts, used when no written version passes.',
    input: { index, verdict: verdict.optional() },
  },
  {
    name: 'moment_header', op: 'decision_header', title: 'Moment header',
    description: 'Sequence number, match time, moment type and facts of one moment, as recorded in a trace.',
    input: { index },
  },
  {
    name: 'test_narrator_caption', op: 'simulated', title: 'Test narrator caption',
    description: 'The built-in test narrator\'s caption for a moment, with its claims and any deliberately planted error. Used for offline runs without a model.',
    input: { index, seed: z.string().optional() },
  },
];

const server = new McpServer({ name: 'captionvar-referee', version: '1.0.0' });
for (const tool of TOOLS) {
  server.registerTool(tool.name, {
    title: tool.title,
    description: tool.description,
    inputSchema: tool.input,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async args => {
    try {
      const result = ops[tool.op](args ?? {});
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: String(err?.message || err) }] };
    }
  });
}

await server.connect(new StdioServerTransport());
console.error(`captionvar-referee MCP server ready (match seed ${seed})`);
