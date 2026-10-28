#!/usr/bin/env node
/**
 * A minimal A2A client for the referee: discovers the Agent Card and sends one
 * real check from the demo match, the 24' goal the narrator called 0-2.
 *
 *   node scripts/referee-a2a.mjs            # in one terminal
 *   node scripts/referee-a2a-client.mjs     # in another
 *
 * `--url <base>` points it at another server (default http://127.0.0.1:41241).
 */
import { randomUUID } from 'node:crypto';
import { ClientFactory } from '@a2a-js/sdk/client';
import { DEMO_CHECK } from './referee-a2a.mjs';

const argv = process.argv.slice(2);
const base = argv.includes('--url') ? argv[argv.indexOf('--url') + 1] : 'http://127.0.0.1:41241';

const client = await new ClientFactory().createFromUrl(base);
const card = await client.getAgentCard();
console.log(`Agent: ${card.name} (A2A ${card.protocolVersion})`);
console.log(`Skills: ${card.skills.map(s => s.id).join(', ')}`);
console.log(`Caption: ${DEMO_CHECK.text}`);

const reply = await client.sendMessage({
  message: { kind: 'message', messageId: randomUUID(), role: 'user', parts: [{ kind: 'data', data: DEMO_CHECK }] },
});
const text = reply.parts.find(p => p.kind === 'text')?.text;
const data = reply.parts.find(p => p.kind === 'data')?.data;
console.log(`Summary: ${text}`);
for (const c of data?.verdict?.claims ?? []) {
  console.log(`  ${c.status.padEnd(13)} ${c.id.padEnd(8)} "${c.span}" evidence ${c.evidence?.join(', ') || '-'}`);
}
console.log(`Verdict: ${data?.verdict?.status}`);
