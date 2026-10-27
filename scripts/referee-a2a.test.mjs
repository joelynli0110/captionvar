/**
 * The referee over A2A gives the same verdict as over MCP. Starts both servers
 * as a client would (`node scripts/referee-a2a.mjs`, `node scripts/referee-mcp.mjs`),
 * fetches the Agent Card, and sends the same checks to each.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ClientFactory } from '@a2a-js/sdk/client';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DEMO_CHECK } from './referee-a2a.mjs';

const script = name => fileURLToPath(new URL(name, import.meta.url));

/** The demo goal with the true score, 0-1. */
const PASSING = {
  ...DEMO_CHECK,
  text: DEMO_CHECK.text.replace('0-2', '0-1'),
  extracted: DEMO_CHECK.extracted.map(c => (c.kind === 'score' ? { ...c, span: c.span.replace('0-2', '0-1'), away: 1 } : c)),
};

let server, base, a2a, mcp;

test.before(async () => {
  server = spawn(process.execPath, [script('referee-a2a.mjs'), '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  base = await new Promise((resolve, reject) => {
    let out = '';
    server.stdout.on('data', chunk => {
      out += chunk;
      const m = out.match(/A2A agent at (http:\/\/\S+)/);
      if (m) resolve(m[1]);
    });
    server.on('exit', code => reject(new Error(`A2A server exited with ${code}`)));
  });
  a2a = await new ClientFactory().createFromUrl(base);
  mcp = new McpClient({ name: 'a2a-test', version: '1.0.0' });
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [script('referee-mcp.mjs')], stderr: 'ignore' }));
});

test.after(async () => {
  await mcp?.close();
  server?.kill();
});

async function viaA2a(parts) {
  const reply = await a2a.sendMessage({ message: { kind: 'message', messageId: randomUUID(), role: 'user', parts } });
  assert.equal(reply.kind, 'message');
  return {
    text: reply.parts.find(p => p.kind === 'text')?.text,
    data: reply.parts.find(p => p.kind === 'data')?.data,
  };
}

async function viaMcp(args) {
  const res = await mcp.callTool({ name: 'check_caption', arguments: args });
  assert.ok(!res.isError, res.content?.[0]?.text);
  return JSON.parse(res.content[0].text);
}

test('the Agent Card is served at the well-known path with the check_caption skill', async () => {
  const res = await fetch(`${base}/.well-known/agent-card.json`);
  assert.equal(res.status, 200);
  const card = await res.json();
  assert.equal(card.name, 'CaptionVAR referee');
  assert.equal(card.url, `${base}/a2a/jsonrpc`);
  assert.deepEqual(card.skills.map(s => s.id), ['check_caption']);
  assert.ok(card.skills[0].examples.length > 0);
});

test("A2A withholds the 24' goal called 0-2, exactly as MCP does", async () => {
  const { text, data } = await viaA2a([{ kind: 'data', data: DEMO_CHECK }]);
  assert.deepEqual(data, await viaMcp(DEMO_CHECK));
  assert.equal(data.verdict.status, 'WITHHOLD');
  const score = data.verdict.claims.find(c => c.id === 'score');
  assert.equal(score.status, 'contradicted');
  assert.deepEqual(score.evidence, ['G-0559']);
  assert.match(text, /^WITHHOLD: 4 of 5 claims supported\. contradicted .*\[G-0559\]/);
});

test('A2A verifies the same goal called 0-1, exactly as MCP does', async () => {
  const { text, data } = await viaA2a([{ kind: 'data', data: PASSING }]);
  assert.deepEqual(data, await viaMcp(PASSING));
  assert.equal(data.verdict.status, 'VERIFY');
  assert.equal(text, 'VERIFY: 5 of 5 claims supported.');
});

test('A2A rejects a message without the check_caption input', async () => {
  const { text, data } = await viaA2a([{ kind: 'text', text: 'Did Strand score?' }]);
  assert.match(text, /^Rejected\./);
  assert.match(data.error, /extracted/);
});
