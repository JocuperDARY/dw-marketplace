import test from 'node:test';
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

test('offline SDK/MCP preserves caps and reports complete structure without semantic acceptance or retries', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-verification-sdk-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const modulePath = fileURLToPath(new URL('./fixtures/verification-model.js', import.meta.url));
  const profile = await resolveProfile('offline', { capabilityProfiles: [{ id: 'offline', access: 'read-only', fileTools: false,
    modules: [{ path: modulePath, sha256: createHash('sha256').update(await readFile(modulePath)).digest('hex'), tools: [] }] }] });
  const runner = createSdkRunner({ resolveCapabilities: async () => profile,
    env: { ...workerEnvironment(), DEEPSEEK_API_KEY: 'offline-not-a-credential' },
    clientFactory: options => new HarnessClient({ ...options, env: { ...options.env,
      NODE_OPTIONS: `${options.env.NODE_OPTIONS} --import=${new URL('./fixtures/offline-network.js', import.meta.url).href}` } }),
  });
  const manager = new ConnectionTasks({ dataDir: join(root, 'state'), runner, resolveCapabilities: async () => profile });
  const server = createServer({ manager, doctor: () => ({ modelCalls: 0 }) });
  const client = new Client({ name: 'offline-verification', version: '1' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); await manager.close(); await rm(root, { recursive: true, force: true }); });
  await server.connect(serverSide);
  await client.connect(clientSide);
  const call = async (name, args) => {
    const response = await client.callTool({ name, arguments: args });
    assert.notEqual(response.isError, true, JSON.stringify(response));
    return response.structuredContent;
  };
  const input = { requestId: 'offline-verification', workspace, executionMode: 'single-request', workload: 'verification',
    reviewContract: { caseIds: ['C06'], ruleIds: ['R1'], checkIds: [] }, maxTokens: 4096, timeoutMs: 20000,
    prompt: 'R1: an anchored ROOT/launch/tmp descendant is scratch, not audit; loss of reader exemption does not change its category. C06 is such a descendant; 80 MiB total, zero audit, total cap 512 MiB.' };
  const task = await call('dsh_submit', input);
  const done = await call('dsh_wait', { taskId: task.taskId, timeoutMs: 25000 });
  assert.equal(done.status, 'completed', JSON.stringify(done));
  assert.equal(done.route.effort, 'high');
  assert.equal(done.maxTokensPerRequest, 4096);
  assert.equal(done.budget.modelRequests, 1);
  assert.equal(done.toolCalls, 0);
  assert.equal(done.deliveryValidation.status, 'structure_complete');
  assert.equal(done.parentAcceptance, 'not_assessed');
  assert.equal(done.cleanup, 'confirmed');
  const result = await call('dsh_result', { taskId: task.taskId });
  assert.equal(JSON.parse(result.text).cases[0].classification, 'audit');
  assert.equal((await call('dsh_submit', input)).duplicate, true);
  assert.equal((await call('dsh_status', { taskId: task.taskId })).budget.modelRequests, 1);
  await assert.rejects(access(join(root, 'state', 'owner.lock')), { code: 'ENOENT' });
});
