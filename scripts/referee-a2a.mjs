#!/usr/bin/env node
/**
 * The CaptionVAR referee as an A2A (Agent2Agent) agent over HTTP.
 *
 *   node scripts/referee-a2a.mjs --seed captionvar-demo-6 --port 41241
 *
 * Options: --host (default 127.0.0.1), --public-url (the base URL written
 * into the Agent Card, when clients reach the server at another address).
 *
 * Agent Card:  GET  /.well-known/agent-card.json
 * JSON-RPC:    POST /a2a/jsonrpc   (message/send)
 *
 * One skill, `check_caption`. The request is a message with one DataPart
 * holding exactly the input of the MCP tool `check_caption`
 * (scripts/referee-tools.mjs): { index, text, extracted, scope?, recap? }.
 * The reply is a message with a TextPart summary and a DataPart holding
 * exactly what the MCP tool returns: { claims, segments, verdict }.
 *
 * Same factbox operation as the MCP server (scripts/factbox-ops.mjs), so
 * the verdict is the same code path, not a reimplementation. Read-only and
 * deterministic; the check sees only events up to the moment.
 */
import express from 'express';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { AGENT_CARD_PATH } from '@a2a-js/sdk';
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { createFactbox, seedFromArgs } from './factbox-ops.mjs';
import { CHECK_CAPTION } from './referee-tools.mjs';

const checkInput = z.object(CHECK_CAPTION.input);

/** The demo check used in the card's examples and by scripts/referee-a2a-client.mjs. */
export const DEMO_CHECK = {
  index: 5,
  text: 'Strand nets his first after Benedetti’s clever assist, Riverside United lead Northbridge 0-2 following a relentless high press!',
  extracted: [
    { kind: 'goal_scorer', span: 'Strand nets his first', player_id: 'RVU-09' },
    { kind: 'scorer_tally', span: 'Strand nets his first', number: 1 },
    { kind: 'goal_assist', span: 'Benedetti’s clever assist', player_id: 'RVU-10' },
    { kind: 'score', span: 'Riverside United lead Northbridge 0-2', home: 0, away: 2 },
    { kind: 'goal_from_press', span: 'following a relentless high press' },
  ],
};

export function agentCard(baseUrl, seed) {
  return {
    name: 'CaptionVAR referee',
    description: `Checks the claims in a football caption, a line of context or a recap sentence against the match events recorded up to its moment, in code, not with a model. Match seed ${seed}. Same check as the MCP tool check_caption.`,
    protocolVersion: '0.3.0',
    version: '1.0.0',
    url: `${baseUrl}/a2a/jsonrpc`,
    preferredTransport: 'JSONRPC',
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json', 'text/plain'],
    skills: [{
      id: 'check_caption',
      name: 'VAR check a caption',
      description: [
        CHECK_CAPTION.description,
        'Input: one DataPart with the same JSON as the MCP tool check_caption: index (moment index), text (the caption as written), extracted (typed claims: kind, span and the asserted values, e.g. player_id, number, home/away), and optionally scope ("caption", "insight" or "recap") and recap ("HT" or "FT").',
        'Output: a TextPart summary and a DataPart with the same JSON the MCP tool returns: claims, segments and verdict (status VERIFY, QUALIFY or WITHHOLD; each claim supported, contradicted or unverifiable, with evidence event IDs).',
      ].join(' '),
      tags: ['football', 'fact-check', 'referee', 'deterministic'],
      inputModes: ['application/json'],
      outputModes: ['application/json', 'text/plain'],
      examples: [
        `DataPart ${JSON.stringify(DEMO_CHECK)} -> WITHHOLD: the score claim is contradicted, the goal events give 0-1 (evidence G-0559).`,
      ],
    }],
  };
}

/** One line for people: the verdict, then each failing claim with its evidence. */
export function summarise({ verdict }) {
  const failing = verdict.claims.filter(c => c.status !== 'supported');
  const head = `${verdict.status}: ${verdict.claims.length - failing.length} of ${verdict.claims.length} claims supported.`;
  const lines = failing.map(c => `${c.status} "${c.span}"${c.note ? `: ${c.note}` : ''}${c.evidence?.length ? ` [${c.evidence.join(', ')}]` : ''}`);
  if (verdict.note) lines.push(verdict.note);
  return [head, ...lines].join(' ');
}

/** The input of a request: the first DataPart, or a TextPart that is JSON. */
function requestInput(message) {
  const parts = message?.parts ?? [];
  const data = parts.find(p => p.kind === 'data');
  if (data) return data.data;
  const textPart = parts.find(p => p.kind === 'text');
  if (textPart) {
    try { return JSON.parse(textPart.text); } catch { /* fall through */ }
  }
  return undefined;
}

class RefereeExecutor {
  constructor(ops) { this.ops = ops; }

  async execute(ctx, bus) {
    const reply = parts => ({ kind: 'message', messageId: randomUUID(), role: 'agent', contextId: ctx.contextId, parts });
    const parsed = checkInput.safeParse(requestInput(ctx.userMessage));
    if (!parsed.success) {
      const error = `Expected one DataPart with the check_caption input { index, text, extracted, scope?, recap? }: ${parsed.error.issues.map(i => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`;
      bus.publish(reply([{ kind: 'text', text: `Rejected. ${error}` }, { kind: 'data', data: { error } }]));
    } else {
      try {
        const result = this.ops[CHECK_CAPTION.op](parsed.data);
        bus.publish(reply([{ kind: 'text', text: summarise(result) }, { kind: 'data', data: result }]));
      } catch (err) {
        const error = String(err?.message || err);
        bus.publish(reply([{ kind: 'text', text: `Error. ${error}` }, { kind: 'data', data: { error } }]));
      }
    }
    bus.finished();
  }

  async cancelTask() {}
}

/**
 * Start the server; resolves to { url, card, close } once it listens.
 * `publicUrl` is the base URL written into the Agent Card, if clients reach
 * the server at another address than the one it listens on.
 */
export async function startServer({ seed = 'captionvar-demo-6', port = 41241, host = '127.0.0.1', publicUrl } = {}) {
  const ops = createFactbox(seed);
  const app = express();
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(port, host, () => resolve(s));
    s.on('error', reject);
  });
  const url = `http://${host}:${server.address().port}`;
  const card = agentCard(publicUrl || url, seed);
  const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), new RefereeExecutor(ops));
  app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: handler }));
  app.use('/a2a/jsonrpc', jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
  return { url, card, close: () => new Promise(r => server.close(r)) };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const port = argv.includes('--port') ? Number(argv[argv.indexOf('--port') + 1]) : 41241;
  const host = argv.includes('--host') ? argv[argv.indexOf('--host') + 1] : '127.0.0.1';
  const publicUrl = argv.includes('--public-url') ? argv[argv.indexOf('--public-url') + 1] : undefined;
  const seed = seedFromArgs();
  const { url } = await startServer({ seed, port, host, publicUrl });
  console.log(`captionvar-referee A2A agent at ${url} (card: ${url}/${AGENT_CARD_PATH}, match seed ${seed})`);
}
