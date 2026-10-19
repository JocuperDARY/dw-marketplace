import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from '../src/server.js';
import { normalizeLifecycleContract } from '../src/lifecycle.js';
import { planExecution } from '../src/planning.js';
import { safeError } from '../src/errors.js';
import { workerEnvironment } from '../src/sdk-runner.js';

const entry = { id: 'case', allowedStatuses: ['unknown'], slotReusable: false, basis: 'Parent explicitly supplied fallback.' };
const contract = { statuses: ['unknown'], cases: [entry] };

function boundaryContract(bytes) {
  const value = { statuses: ['unknown'], cases: Array.from({ length: 8 }, (_, i) => ({ ...entry, id: `case${i}`, basis: '界'.repeat(600) })) };
  const missing = bytes - Buffer.byteLength(JSON.stringify(value), 'utf8');
  assert.ok(missing >= 0 && missing < 1448);
  value.cases[0].basis += 'x'.repeat(missing);
  assert.equal(Buffer.byteLength(JSON.stringify(value), 'utf8'), bytes);
  return value;
}

test('normalized lifecycle UTF-8 size accepts exactly 16 KiB and rejects the next multibyte byte boundary', () => {
  const exact = boundaryContract(16384);
  assert.deepEqual(normalizeLifecycleContract(exact), exact);
  const over = structuredClone(exact);
  over.cases[0].basis += '界';
  assert.equal(Buffer.byteLength(JSON.stringify(over), 'utf8'), 16387);
  assert.throws(() => normalizeLifecycleContract(over), error => {
    assert.equal(safeError(error).validation.issues[0].code, 'lifecycle_utf8_size_limit');
    return true;
  });
  const reordered = { cases: exact.cases.map(({ basis, slotReusable, allowedStatuses, id }) => ({ basis, slotReusable, allowedStatuses, id })), statuses: exact.statuses };
  assert.equal(JSON.stringify(normalizeLifecycleContract(reordered)), JSON.stringify(exact));
  const spaced = { ...contract, cases: [{ ...entry, basis: '  supplied basis \n' }] };
  assert.equal(normalizeLifecycleContract(spaced).cases[0].basis, spaced.cases[0].basis);
});

test('lifecycle defaults preserve automatic/native and omitted or nullable resource limits', () => {
  for (const limits of [{}, { maxTokens: null, maxToolCalls: null, maxModelRequests: null }]) {
    const plan = planExecution({ ...limits, lifecycleContract: contract });
    assert.equal(plan.executionMode, 'automatic');
    assert.equal(plan.capabilityProfile, 'native');
    assert.equal(plan.workload, 'verification');
    assert.equal(plan.effort, 'high');
    assert.equal(plan.outputFormat, 'json-object');
    assert.equal(plan.maxTokens, null);
    assert.equal(plan.maxToolCalls, null);
    assert.equal(plan.maxModelRequests, null);
    assert.equal(plan.budget, null);
  }
});

test('published lifecycle schema advertises duplicate and nonblank constraints; cross-field errors remain safe before admission', async t => {
  let admissions = 0;
  const server = createServer({ manager: { submit: async () => { admissions++; return { accepted: true }; } }, doctor: () => ({}), preflight: () => assert.fail('No preflight expected') });
  const client = new Client({ name: 'lifecycle-schema', version: '1' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverSide); await client.connect(clientSide);
  const schema = (await client.listTools()).tools.find(tool => tool.name === 'dsh_submit').inputSchema;
  const lifecycle = schema.properties.lifecycleContract;
  assert.equal(lifecycle.properties.statuses.uniqueItems, true);
  assert.equal(lifecycle.properties.cases.items.properties.allowedStatuses.uniqueItems, true);
  assert.equal(lifecycle.properties.cases.items.properties.basis.pattern, '\\S');
  assert.match(lifecycle.description, /16384 UTF-8 bytes/);
  const validate = new Ajv({ strict: false, validateFormats: false }).compile(schema);
  const base = { requestId: 'schema-lifecycle', prompt: 'private-prompt-marker', workspace: 'private-workspace-marker', lifecycleContract: contract };
  const invalidSchema = [
    { ...contract, statuses: ['unknown', 'unknown'] },
    { ...contract, cases: [{ ...entry, allowedStatuses: ['unknown', 'unknown'] }] },
    { ...contract, cases: [{ ...entry, basis: ' \t\n' }] },
    { ...contract, cases: [{ ...entry, slotReusable: 'private-value-marker' }] },
    { ...contract, cases: [{ ...entry, 'private-key-marker': 'private-value-marker' }] },
  ];
  for (const value of invalidSchema) {
    assert.equal(validate({ ...base, lifecycleContract: value }), false);
    const response = await client.callTool({ name: 'dsh_submit', arguments: { ...base, lifecycleContract: value } });
    assert.equal(response.structuredContent.error.code, 'INVALID_ARGUMENT');
    assert.equal(response.structuredContent.error.validation.phase, 'schema');
    assert.deepEqual(JSON.parse(response.content[0].text), response.structuredContent);
    for (const marker of ['private-prompt-marker', 'private-workspace-marker', 'private-value-marker', 'private-key-marker']) assert.equal(JSON.stringify(response).includes(marker), false);
  }
  for (const [value, path, code] of [
    [{ ...contract, cases: [entry, entry] }, ['lifecycleContract', 'cases', 1, 'id'], 'duplicate_case_id'],
    [{ ...contract, cases: [{ ...entry, allowedStatuses: ['private-status-marker'] }] }, ['lifecycleContract', 'cases', 0, 'allowedStatuses', 0], 'status_not_declared'],
    [boundaryContract(16385), ['lifecycleContract'], 'lifecycle_utf8_size_limit'],
  ]) {
    assert.equal(validate({ ...base, lifecycleContract: value }), true);
    const response = await client.callTool({ name: 'dsh_submit', arguments: { ...base, lifecycleContract: value } });
    const error = response.structuredContent.error;
    assert.equal(error.validation.phase, 'contract');
    assert.deepEqual(error.validation.issues[0].path, path);
    assert.equal(error.validation.issues[0].code, code);
    assert.equal(JSON.stringify(response).includes('private-status-marker'), false);
  }
  assert.equal(admissions, 0);
  const many = { ...contract, cases: Array.from({ length: 64 }, (_, i) => ({ ...entry, id: `case${i}`, allowedStatuses: ['private-status-marker'] })) };
  const bounded = await client.callTool({ name: 'dsh_submit', arguments: { ...base, lifecycleContract: many } });
  assert.equal(bounded.structuredContent.error.validation.issues.length, 16);
  assert.equal(bounded.structuredContent.error.validation.issuesTruncated, true);
  assert.equal(JSON.stringify(bounded).includes('private-status-marker'), false);
  assert.notEqual((await client.callTool({ name: 'dsh_submit', arguments: base })).isError, true);
  assert.equal(admissions, 1);
});

test('invalid lifecycle contracts leave a production-like owner lock sentinel and missing credentials untouched', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-lifecycle-lock-'));
  const state = join(root, 'state'); await mkdir(state);
  const lock = join(state, 'owner.lock');
  const sentinel = JSON.stringify({ pid: process.pid, fixture: 'No owner or credential admission' });
  await writeFile(lock, sentinel);
  const env = workerEnvironment(); delete env.DEEPSEEK_API_KEY; env.DSH_BRIDGE_DATA_DIR = state;
  const client = new Client({ name: 'lifecycle-lock', version: '1' });
  t.after(async () => { await client.close(); await rm(root, { recursive: true, force: true }); });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../index.js', import.meta.url))], env, stderr: 'pipe' }));
  const invalid = [{ lifecycleContract: { ...contract, statuses: ['unknown', 'unknown'] } }, { lifecycleContract: { ...contract, cases: [entry, entry] } }, { lifecycleContract: { ...contract, cases: [{ ...entry, allowedStatuses: ['undeclared'] }] } }, { lifecycleContract: boundaryContract(16385) },
    { lifecycleContract: contract, outputFormat: 'text' }, { lifecycleContract: contract, reviewContract: { caseIds: ['C'], ruleIds: ['R'], checkIds: [] } },
    { lifecycleContract: contract, reportContract: { facts: [{ id: 'F', kind: 'limit', value: 1, unit: '', source: 'parent' }] } }];
  for (const patch of invalid) {
    const response = await client.callTool({ name: 'dsh_submit', arguments: { requestId: 'bad-lifecycle', prompt: 'Task', workspace: root, ...patch } });
    assert.equal(response.structuredContent.error.code, 'INVALID_ARGUMENT');
    assert.equal(await readFile(lock, 'utf8'), sentinel);
    assert.deepEqual(await readdir(state), ['owner.lock']);
  }
});
