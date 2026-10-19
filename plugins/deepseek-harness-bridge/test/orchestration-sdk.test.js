import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
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
import { TaskManager } from '../src/tasks.js';

// Functional SDK coverage includes process initialization (which has its own 30s
// allowance). Exact soft-deadline boundaries are exercised without startup races
// in budget.test.js and checkpoint-fixture-reliability.test.js.
const stageTimeoutMs = 60000;
const chainTimeoutMs = 180000;

test('real SDK and MCP complete checkpoint orchestration using an offline model with network blocked', { timeout: 210000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-orchestration-sdk-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  await writeFile(join(workspace, 'input.txt'), 'offline evidence');
  const modulePath = fileURLToPath(new URL('./fixtures/checkpoint-model.js', import.meta.url));
  const profile = await resolveProfile('offline', { capabilityProfiles: [{ id: 'offline', access: 'read-only', fileTools: true,
    modules: [{ path: modulePath, sha256: createHash('sha256').update(await readFile(modulePath)).digest('hex'), tools: [] }] }] });
  const terminalEvents = [];
  const runner = createSdkRunner({ resolveCapabilities: async () => profile,
    env: { ...workerEnvironment(), DEEPSEEK_API_KEY: 'offline-not-a-credential' },
    clientFactory: options => {
      const client = new HarnessClient({ ...options, env: { ...options.env,
        NODE_OPTIONS: `${options.env.NODE_OPTIONS} --import=${new URL('./fixtures/offline-network.js', import.meta.url).href}` } });
      const subscribe = client.subscribe.bind(client);
      client.subscribe = filter => subscribe(notification => {
        if (notification.params?.event?.type === 'turn/end') terminalEvents.push(notification.params.event);
        return filter(notification);
      });
      return client;
    },
  });
  const manager = new ConnectionTasks({ dataDir: join(root, 'state'), runner, resolveCapabilities: async () => profile });
  const server = createServer({ manager, doctor: () => ({ modelCalls: 0 }) });
  const client = new Client({ name: 'offline-orchestration', version: '1' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); await manager.close(); await rm(root, { recursive: true, force: true }); });
  await server.connect(serverSide);
  await client.connect(clientSide);
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    assert.notEqual(response.isError, true, JSON.stringify(response));
    return response.structuredContent;
  };
  const submitted = await call('dsh_submit', { requestId: 'offline-full-chain', prompt: 'Read input.txt and return a summary.', workspace,
    capabilityProfile: 'offline', maxTokens: 512, maxModelRequests: 2, maxToolCalls: 2, timeoutMs: stageTimeoutMs,
    budget: { totalModelRequests: 6, totalOutputTokens: 3072, totalToolCalls: 4, totalDurationMs: chainTimeoutMs } });
  const wait = async taskId => {
    let done;
    do { done = await call('dsh_wait', { taskId, timeoutMs: 30000 }); } while (done.status === 'running');
    return done;
  };
  const done = await wait(submitted.taskId);
  assert.equal(done.status, 'completed', JSON.stringify({ done, terminalEvents }));
  assert.equal(done.orchestration.stages, 2);
  assert.equal(done.orchestration.charged.modelRequests, 3);
  assert.equal(done.orchestration.charged.outputTokens, 300);
  assert.equal(done.orchestration.charged.toolCalls, 1);
  assert.match((await call('dsh_result', { taskId: submitted.taskId })).text, /Finished using saved evidence/);
  const saved = JSON.parse(await readFile(join(root, 'state', 'tasks', submitted.taskId, 'task.json'), 'utf8'));
  const checkpoint = JSON.parse(await readFile(saved.orchestration.stages[0].checkpointPath, 'utf8'));
  assert.match(checkpoint.summary, /Read input\.txt: offline evidence \(sha256=[a-f0-9]{64}\)/);
  assert.equal(saved.orchestration.stages[0].charged.toolCalls, 1);
  assert.notEqual(saved.orchestration.stages[0].sessionId, saved.orchestration.stages[1].sessionId);
  const followup = { taskId: submitted.taskId, requestId: 'offline-continue', prompt: 'Confirm the saved summary.' };
  await call('dsh_continue', followup);
  const continued = await wait(submitted.taskId);
  assert.equal(continued.status, 'completed');
  assert.equal(continued.orchestration.charged.modelRequests, 4);
  assert.equal(continued.orchestration.deadlineAt, done.orchestration.deadlineAt);
  assert.equal((await call('dsh_continue', followup)).duplicate, true);
  await assert.rejects(access(join(root, 'state', 'owner.lock')), { code: 'ENOENT' });
});

for (const mode of ['partial-json', 'reasoning-only']) test(`real SDK recovers ${mode} with one off request and no network`, { timeout: 150000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-truncation-sdk-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const modulePath = fileURLToPath(new URL('./fixtures/checkpoint-model.js', import.meta.url));
  const profile = await resolveProfile('offline', { capabilityProfiles: [{ id: 'offline', access: 'read-only', fileTools: false,
    modules: [{ path: modulePath, sha256: createHash('sha256').update(await readFile(modulePath)).digest('hex'), tools: [] }] }] });
  const runner = createSdkRunner({ resolveCapabilities: async () => profile,
    env: { ...workerEnvironment(), DEEPSEEK_API_KEY: 'offline-not-a-credential' },
    clientFactory: options => new HarnessClient({ ...options, env: { ...options.env,
      NODE_OPTIONS: `${options.env.NODE_OPTIONS} --import=${new URL('./fixtures/offline-network.js', import.meta.url).href}` } }),
  });
  const manager = await new TaskManager({ dataDir: join(root, 'state'), runner, resolveCapabilities: async () => profile }).open();
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  const submitted = await manager.submit({ requestId: 'offline-truncation', prompt: `offline-truncate ${mode}: Summarize the supplied text.`, workspace,
    capabilityProfile: 'offline', workload: mode === 'reasoning-only' ? 'reasoning' : 'mechanical', maxTokens: 4096, maxModelRequests: 2, maxToolCalls: 0, timeoutMs: stageTimeoutMs,
    budget: { totalModelRequests: 4, totalOutputTokens: 12288, totalToolCalls: 0, totalDurationMs: 120000 } });
  let done;
  do { done = await manager.wait({ taskId: submitted.taskId, timeoutMs: 30000 }); } while (done.status === 'running');
  assert.equal(done.status, 'completed', JSON.stringify(done));
  assert.equal(done.recovery.status, 'completed');
  assert.equal(done.orchestration.charged.modelRequests, 2);
  assert.equal(done.orchestration.charged.outputTokens, 4196);
  assert.equal(done.orchestration.charged.toolCalls, 0);
  const result = await manager.result({ taskId: submitted.taskId });
  assert.equal(JSON.parse(result.text).state, 'completed');
  const partial = JSON.parse(await readFile(done.orchestration.lastPartial.path, 'utf8'));
  assert.equal(partial.output.kind, mode === 'partial-json' ? 'partial_text' : 'reasoning_only');
  assert.equal(partial.output.modelTruncated, true);
  assert.ok(!JSON.stringify({ partial, result }).includes('private-reasoning-marker'));
});
