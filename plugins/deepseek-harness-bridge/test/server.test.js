import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { TaskManager } from '../src/tasks.js';
import { createServer } from '../src/server.js';
import { workerEnvironment } from '../src/sdk-runner.js';
import Ajv from 'ajv';

test('published MCP schema and runtime reject malformed report facts with safe field errors before admission', async t => {
  let admissions = 0;
  const manager = { submit: async input => { admissions++; return { accepted: input.reportContract }; } };
  const server = createServer({ manager, doctor: () => ({}), preflight: () => assert.fail('No preflight expected') });
  const client = new Client({ name: 'schema-test', version: '1' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverSide);
  await client.connect(clientSide);
  const schema = (await client.listTools()).tools.find(tool => tool.name === 'dsh_submit').inputSchema;
  const validate = new Ajv({ strict: false, validateFormats: false }).compile(schema);
  assert.match(schema.properties.reportContract.description, /unique facts\[\]\.id/);
  assert.match(schema.properties.reportContract.description, /16384 UTF-8 bytes/);
  const fact = { id: 'status', kind: 'execution-status', value: 'NOT_RUN', unit: 'calls', source: 'supplied-source' };
  const base = { requestId: 'schema-check', prompt: 'private-prompt-marker', workspace: 'private-workspace-marker', reportContract: { facts: [fact] } };
  for (const patch of [{ value: 0 }, { value: false }, { value: null }, { value: ' \t' }, { value: { private: 'private-value-marker' } }, { source: ' \n' }, { kind: 'private-kind-marker' }]) {
    const input = { ...base, reportContract: { facts: [{ ...fact, ...patch }] } };
    assert.equal(validate(input), false);
    const response = await client.callTool({ name: 'dsh_submit', arguments: input });
    assert.equal(response.isError, true);
    assert.deepEqual(JSON.parse(response.content[0].text), response.structuredContent);
    const { error } = response.structuredContent;
    assert.equal(error.code, 'INVALID_ARGUMENT');
    assert.equal(error.validation.phase, 'schema');
    assert.deepEqual(error.validation.issues[0].path, ['reportContract', 'facts', 0, Object.keys(patch)[0]]);
    for (const marker of ['private-prompt-marker', 'private-workspace-marker', 'private-value-marker', 'private-kind-marker']) assert.equal(JSON.stringify(response).includes(marker), false);
  }
  const unknown = await client.callTool({ name: 'dsh_submit', arguments: { ...base, 'private-key-name': 'private-value' } });
  assert.equal(unknown.structuredContent.error.validation.issues[0].code, 'unrecognized_keys');
  assert.equal(JSON.stringify(unknown).includes('private-key-name'), false);
  assert.equal(JSON.stringify(unknown).includes('private-value'), false);
  const duplicate = { ...base, reportContract: { facts: [fact, fact] } };
  assert.equal(validate(duplicate), true); // Documented admission check, not a JSON Schema keyword.
  const rejected = await client.callTool({ name: 'dsh_submit', arguments: duplicate });
  assert.equal(rejected.structuredContent.error.validation.phase, 'contract');
  assert.deepEqual(rejected.structuredContent.error.validation.issues[0].path, ['reportContract', 'facts', 1, 'id']);
  assert.equal(admissions, 0);
  const valid = { ...base, reportContract: { facts: [{ ...fact, kind: 'limit', value: 0 }] } };
  assert.equal(validate(valid), true);
  const accepted = await client.callTool({ name: 'dsh_submit', arguments: valid });
  assert.notEqual(accepted.isError, true);
  assert.deepEqual(accepted.structuredContent.accepted, valid.reportContract);
  assert.equal(admissions, 1);
});

test('production rejects invalid contracts before touching an existing state lock or credentials', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-contract-lock-'));
  const state = join(root, 'state');
  await mkdir(state);
  const lock = join(state, 'owner.lock');
  const sentinel = JSON.stringify({ pid: process.pid, fixture: 'Do not modify' });
  await writeFile(lock, sentinel);
  const env = workerEnvironment();
  delete env.DEEPSEEK_API_KEY;
  env.DSH_BRIDGE_DATA_DIR = state;
  const client = new Client({ name: 'contract-lock-test', version: '1' });
  t.after(async () => { await client.close(); await rm(root, { recursive: true, force: true }); });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../index.js', import.meta.url))], env, stderr: 'pipe' }));
  const fact = { id: 'status', kind: 'execution-status', value: 'NOT_RUN', unit: '', source: 'supplied' };
  for (const [facts, phase] of [[[{ ...fact, value: 0 }], 'schema'], [[fact, fact], 'contract']]) {
    const response = await client.callTool({ name: 'dsh_submit', arguments: { requestId: 'bad-contract', prompt: 'Task', workspace: root, reportContract: { facts } } });
    assert.equal(response.structuredContent.error.code, 'INVALID_ARGUMENT');
    assert.equal(response.structuredContent.error.validation.phase, phase);
    assert.equal(await readFile(lock, 'utf8'), sentinel);
    assert.deepEqual(await readdir(state), ['owner.lock']);
  }
});

test('multiple production connections discover tools without reserving task ownership', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-discovery-'));
  const state = join(root, 'state');
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map(client => client.close()));
    await rm(root, { recursive: true, force: true });
  });
  for (let index = 0; index < 2; index++) {
    const env = workerEnvironment();
    delete env.DEEPSEEK_API_KEY;
    env.DSH_BRIDGE_DATA_DIR = state;
    const client = new Client({ name: 'discovery-test', version: '1' });
    clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../index.js', import.meta.url))], env, stderr: 'pipe' }));
    assert.equal((await client.listTools()).tools.length, 11);
    const result = await client.callTool({ name: 'dsh_doctor', arguments: {} });
    assert.equal(JSON.parse(result.content[0].text).validation.modelCalls, 0);
  }
  await assert.rejects(access(join(state, 'owner.lock')), { code: 'ENOENT' });
});

test('MCP preserves omitted limits and enforces an explicit one-request contract', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-mcp-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const manager = await new TaskManager({ dataDir: join(root, 'state'), runner: async ({ prompt }) => ({ terminal: 'completed', text: prompt, cleanup: 'confirmed' }) }).open();
  const server = createServer({ manager, doctor: () => ({ modelCalls: 0 }) });
  const client = new Client({ name: 'test', version: '1' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); await manager.close(); await rm(root, { recursive: true, force: true }); });
  await server.connect(serverSide);
  await client.connect(clientSide);
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 11);
  const prepareTool = tools.find(tool => tool.name === 'dsh_prepare_workspace');
  assert.equal(prepareTool.annotations.readOnlyHint, false);
  assert.equal(prepareTool.annotations.openWorldHint, false);
  assert.equal(prepareTool.annotations.idempotentHint, false);
  assert.equal(prepareTool.annotations.destructiveHint, false);
  const submitSchema = tools.find(tool => tool.name === 'dsh_submit').inputSchema;
  assert.ok(submitSchema.properties.workload.enum.includes('verification'));
  assert.ok(submitSchema.properties.workload.enum.includes('drafting'));
  assert.deepEqual(submitSchema.properties.outputFormat.enum, ['text', 'json-object']);
  assert.ok(submitSchema.properties.reviewContract.required.includes('checkIds'));
  assert.ok(submitSchema.properties.reportContract.required.includes('facts'));
  const usageTool = tools.find(tool => tool.name === 'dsh_usage');
  assert.equal(usageTool.annotations.readOnlyHint, true);
  assert.equal(usageTool.annotations.openWorldHint, false);
  assert.match(tools.find(tool => tool.name === 'dsh_result').description, /proseAcceptance/);
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    assert.notEqual(response.isError, true);
    return JSON.parse(response.content[0].text);
  };
  assert.equal(submitSchema.required.includes('budget'), false);
  assert.ok(submitSchema.properties.executionMode.enum.includes('automatic'));
  const noContract = await client.callTool({ name: 'dsh_submit', arguments: { executionMode: 'single-request', workload: 'verification', requestId: 'no-contract', prompt: 'Rules', workspace } });
  assert.equal(noContract.structuredContent.error.code, 'REVIEW_CONTRACT_REQUIRED');
  const duplicateIds = await client.callTool({ name: 'dsh_submit', arguments: { executionMode: 'single-request', requestId: 'duplicate-contract', prompt: 'Rules', workspace, reviewContract: { caseIds: ['C1', 'C1'], ruleIds: ['R1'], checkIds: [] } } });
  assert.equal(JSON.parse(duplicateIds.content[0].text).error.code, 'INVALID_ARGUMENT');
  assert.equal(manager.list().total, 0);
  const task = await call('dsh_submit', { executionMode: 'single-request', requestId: 'mcp-1', prompt: 'Task', workspace });
  assert.equal((await call('dsh_wait', { taskId: task.taskId })).status, 'completed');
  assert.equal((await call('dsh_result', { taskId: task.taskId })).text, 'Task');
  const continuation = await client.callTool({ name: 'dsh_continue', arguments: { taskId: task.taskId, requestId: 'mcp-2', prompt: 'More' } });
  assert.equal(continuation.structuredContent.error.code, 'NOT_RESUMABLE');
  assert.equal((await call('dsh_status', { taskId: task.taskId })).number, 1);
  assert.equal((await call('dsh_list')).total, 1);
  const usage = await call('dsh_usage');
  assert.equal(usage.tasks, 1);
  assert.equal(usage.unknownReceiptGroups, 1);
  assert.equal(usage.modelCallsPerformed, 0);
  assert.equal((await call('dsh_doctor')).modelCalls, 0);
  assert.equal((await call('dsh_cancel', { taskId: task.taskId })).status, 'completed');
  assert.equal((await client.callTool({ name: 'dsh_submit', arguments: { requestId: 'mcp-3', prompt: 'Task', workspace, arbitraryModel: 'other' } })).isError, true);
});

test('production stdio entry starts without a key and doctor makes no model calls', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-stdio-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const env = workerEnvironment();
  delete env.DEEPSEEK_API_KEY;
  env.DSH_BRIDGE_DATA_DIR = join(root, 'state');
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../index.js', import.meta.url))], env, stderr: 'pipe' });
  const client = new Client({ name: 'stdio-test', version: '1' });
  t.after(async () => { await client.close(); await rm(root, { recursive: true, force: true }); });
  await client.connect(transport);
  const response = await client.callTool({ name: 'dsh_doctor', arguments: {} });
  const status = JSON.parse(response.content[0].text);
  assert.equal(status.credentialConfigured, false);
  assert.equal(status.validation.modelCalls, 0);
  assert.equal(status.dependencies['@deepseek-ai/dsh-sdk-client'], '0.2.1-rc.2');
  if (process.platform === 'win32') {
    const preparedPath = join(root, 'worker-owned');
    const prepared = await client.callTool({ name: 'dsh_prepare_workspace', arguments: { workspace: preparedPath } });
    assert.notEqual(prepared.isError, true, JSON.stringify(prepared));
    assert.equal(prepared.structuredContent.workspace, preparedPath);
    assert.equal(prepared.structuredContent.modelRequests, 0);
    assert.equal(prepared.structuredContent.evidence.currentSid, prepared.structuredContent.evidence.ownerSid);
    await assert.rejects(access(env.DSH_BRIDGE_DATA_DIR), { code: 'ENOENT' });
    const duplicate = await client.callTool({ name: 'dsh_prepare_workspace', arguments: { workspace: preparedPath } });
    assert.equal(duplicate.structuredContent.error.code, 'NATIVE_WORKSPACE_EXISTS');
  }
  const missingKey = await client.callTool({ name: 'dsh_submit', arguments: { executionMode: 'single-request', requestId: 'no-key', workspace, prompt: 'Task' } });
  assert.equal(JSON.parse(missingKey.content[0].text).error.code, 'MISSING_CREDENTIAL');
  await client.close();
});
