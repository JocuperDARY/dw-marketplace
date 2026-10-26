import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';

async function fixture(t) {
  const calls = [];
  const manager = Object.fromEntries(['spawnAgent', 'sendMessage', 'followupTask', 'interruptAgent', 'waitAgents', 'listAgents']
    .map(name => [name, async input => { calls.push({ name, input }); return { accepted: true }; }]));
  const server = createServer({ manager, doctor: () => ({}), preflight: () => {} });
  const client = new Client({ name: 'agent-contract-test', version: '1' });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s); await client.connect(c);
  t.after(async () => { await client.close(); await server.close(); });
  return { client, calls };
}

test('agent operations are discoverable without starting a worker', async t => {
  const { client, calls } = await fixture(t);
  const names = new Set((await client.listTools()).tools.map(tool => tool.name));
  for (const name of ['dsh_spawn_agent', 'dsh_send_message', 'dsh_followup_task', 'dsh_interrupt_agent', 'dsh_wait_agents', 'dsh_list_agents']) {
    assert.ok(names.has(name), `Missing ${name}`);
  }
  assert.equal(calls.length, 0);
  const listed = await client.callTool({ name: 'dsh_list_agents', arguments: { limit: 51 } });
  assert.equal(listed.isError, true); assert.equal(listed.structuredContent.error.validation.phase, 'schema');
  assert.equal(calls.length, 0, 'History and agent list must advertise the same page limit');
});

test('message schema and admission agree on Unicode, retraction and safe field errors', async t => {
  const { client, calls } = await fixture(t);
  const definition = (await client.listTools()).tools.find(tool => tool.name === 'dsh_send_message');
  assert.ok(definition, 'The public message schema must exist');
  const validate = new Ajv({ strict: false }).compile(definition.inputSchema);
  const input = { agentId: '11111111-1111-4111-8111-111111111111', requestId: 'unicode', text: '😀'.repeat(32768) };
  assert.equal(validate(input), true);
  assert.notEqual((await client.callTool({ name: definition.name, arguments: input })).isError, true);
  assert.equal(calls.length, 1);
  const invalid = [
    { ...input, text: '😀'.repeat(32769) },
    { ...input, text: ' \n\t' },
    { ...input, change: 'replace' },
    { ...input, change: 'retract', targetMessageIds: ['22222222-2222-4222-8222-222222222222'], expectedContextRevision: 1 },
    { ...input, text: 'private-body-marker', 'private-key-marker': 'private-value-marker' },
  ];
  for (const args of invalid) {
    assert.equal(validate(args), false);
    const result = await client.callTool({ name: definition.name, arguments: args });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'INVALID_ARGUMENT');
    assert.equal(result.structuredContent.error.validation.phase, 'schema');
    assert.doesNotMatch(JSON.stringify(result), /private-body-marker|private-key-marker|private-value-marker/);
  }
  assert.equal(calls.length, 1, 'Invalid inputs must not reach task state');
});
