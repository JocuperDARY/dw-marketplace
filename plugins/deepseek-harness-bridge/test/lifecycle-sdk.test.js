import test from 'node:test';
import { retainedLeases } from './fixtures/committed-state.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { resolveProfile } from '../src/capabilities.js';
import { createSdkRunner, workerEnvironment } from '../src/sdk-runner.js';
import { ConnectionTasks } from '../src/connection-tasks.js';
import { createServer } from '../src/server.js';

test('offline SDK/MCP returns original contradiction with lifecycle mismatch, cleanup and no extra call', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-lifecycle-sdk-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const modulePath = fileURLToPath(new URL('./fixtures/lifecycle-model.js', import.meta.url));
  const source = JSON.parse(await readFile(new URL('./fixtures/lifecycle-failure.json', import.meta.url), 'utf8'));
  const lifecycleContract = JSON.parse(await readFile(new URL('./fixtures/lifecycle-contract.json', import.meta.url), 'utf8'));
  const profile = await resolveProfile('offline', { capabilityProfiles: [{ id: 'offline', access: 'read-only', fileTools: false,
    modules: [{ path: modulePath, sha256: createHash('sha256').update(await readFile(modulePath)).digest('hex'), tools: [] }] }] });
  const runner = createSdkRunner({ resolveCapabilities: async () => profile,
    env: { ...workerEnvironment(), DEEPSEEK_API_KEY: 'offline-not-a-credential' },
    clientFactory: options => new HarnessClient({ ...options, env: { ...options.env,
      NODE_OPTIONS: options.env.NODE_OPTIONS + ' --import=' + new URL('./fixtures/offline-network.js', import.meta.url).href } }),
  });
  const manager = new ConnectionTasks({ dataDir: join(root, 'state'), runner, resolveCapabilities: async () => profile });
  const server = createServer({ manager, doctor: () => ({ modelCalls: 0 }) });
  const client = new Client({ name: 'offline-lifecycle', version: '1' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); await manager.close(); await rm(root, { recursive: true, force: true }); });
  await server.connect(serverSide);
  await client.connect(clientSide);
  const tools = (await client.listTools()).tools;
  const schema = tools.find(tool => tool.name === 'dsh_submit').inputSchema.properties.lifecycleContract;
  assert.deepEqual([...schema.required].sort(), ['cases', 'statuses']);
  assert.equal(schema.additionalProperties, false);
  const call = async (name, args) => {
    const response = await client.callTool({ name, arguments: args });
    assert.notEqual(response.isError, true, JSON.stringify(response));
    return response.structuredContent;
  };
  const input = { requestId: 'offline-lifecycle', workspace, executionMode: 'single-request', workload: 'mechanical',
    lifecycleContract, effort: 'off', maxTokens: 2048, timeoutMs: 20000, prompt: JSON.stringify(source.assignment) };
  const invalid = structuredClone(input);
  invalid.lifecycleContract.cases[2].allowedStatuses = [];
  assert.equal((await client.callTool({ name: 'dsh_submit', arguments: invalid })).isError, true);
  assert.equal((await call('dsh_list', {})).total, 0);
  const task = await call('dsh_submit', input);
  const done = await call('dsh_wait', { taskId: task.taskId, timeoutMs: 25000 });
  assert.equal(done.status, 'completed', JSON.stringify(done));
  assert.equal(done.cleanup, 'confirmed');
  assert.equal(done.route.effort, 'off');
  assert.equal(done.maxTokensPerRequest, 2048);
  assert.equal(done.budget.modelRequests, 1);
  assert.equal(done.toolCalls, 0);
  assert.equal(done.outputValidation.status, 'valid');
  assert.equal(done.lifecycleValidation.status, 'mismatch');
  assert.ok(done.lifecycleValidation.issues.some(issue => issue.path === 'rows.S3.status'));
  assert.equal(done.parentAcceptance, 'not_assessed');
  const result = await call('dsh_result', { taskId: task.taskId });
  assert.equal(result.text, source.text);
  assert.equal(result.lifecycleValidation.proseAcceptance, 'not_assessed');
  assert.equal((await call('dsh_submit', input)).duplicate, true);
  const continuation = await client.callTool({ name: 'dsh_continue', arguments: { taskId: task.taskId, requestId: 'no-auto-retry', prompt: 'Fix it' } });
  assert.equal(continuation.structuredContent.error.code, 'NOT_RESUMABLE');
  assert.equal((await call('dsh_status', { taskId: task.taskId })).budget.modelRequests, 1);
  assert.deepEqual(await retainedLeases(join(root, 'state')), []);
});
