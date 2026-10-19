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

for (const single of [false, true]) for (const mode of ['reasoning-only', 'summary-prose', 'report']) {
  test(`offline SDK: ${mode}, ${single ? 'single-request stops' : 'budgeted recovery'}`, { timeout: 35000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-output-sdk-'));
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    const modulePath = fileURLToPath(new URL('./fixtures/delivery-model.js', import.meta.url));
    const profile = await resolveProfile('offline', { capabilityProfiles: [{ id: 'offline', access: 'read-only', fileTools: false,
      modules: [{ path: modulePath, sha256: createHash('sha256').update(await readFile(modulePath)).digest('hex'), tools: [] }] }] });
    const runner = createSdkRunner({ resolveCapabilities: async () => profile,
      env: { ...workerEnvironment(), DEEPSEEK_API_KEY: 'offline-not-a-credential' },
      clientFactory: options => new HarnessClient({ ...options, env: { ...options.env,
        NODE_OPTIONS: `${options.env.NODE_OPTIONS} --import=${new URL('./fixtures/offline-network.js', import.meta.url).href}` } }),
    });
    const manager = new ConnectionTasks({ dataDir: join(root, 'state'), runner, resolveCapabilities: async () => profile });
    const server = createServer({ manager, doctor: () => ({ modelCalls: 0 }) });
    const client = new Client({ name: 'offline-delivery', version: '1' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    t.after(async () => { await client.close(); await server.close(); await manager.close(); await rm(root, { recursive: true, force: true }); });
    await server.connect(serverSide);
    await client.connect(clientSide);
    const call = async (name, args) => {
      const response = await client.callTool({ name, arguments: args });
      assert.notEqual(response.isError, true, JSON.stringify(response));
      return response.structuredContent;
    };
    const budget = { totalModelRequests: 3, totalOutputTokens: 8192, totalToolCalls: 0, totalDurationMs: 25000 };
    const input = { requestId: 'offline-delivery', workspace, executionMode: single ? 'single-request' : 'budgeted',
      ...(single ? {} : { budget }), workload: mode === 'reasoning-only' ? 'standard' : 'drafting',
      capabilityProfile: 'inference-only', outputFormat: 'json-object', maxTokens: 8192, timeoutMs: 20000,
      prompt: `fixture-${mode}: Return a draft from supplied facts.` };
    if (mode === 'report') input.reportContract = { facts: [{ id: 'seconds', kind: 'limit', value: 180, unit: 's', source: 'plan.json:limits.seconds' }] };
    const task = await call('dsh_submit', input);
    const done = await call('dsh_wait', { taskId: task.taskId, timeoutMs: 30000 });
    const result = await call('dsh_result', { taskId: task.taskId });
    assert.equal(done.cleanup, 'confirmed', JSON.stringify(done));
    assert.equal(done.parentAcceptance, 'not_assessed');
    if (mode === 'report') {
      assert.equal(done.status, 'completed');
      assert.equal(done.reportValidation.status, 'mismatch');
      assert.equal(done.reportValidation.proseAcceptance, 'not_assessed');
      assert.equal(done.outputValidation.status, 'valid');
      assert.equal(done.budget.modelRequests, 1);
      assert.equal(done.orchestration?.recoveries ?? 0, 0);
      assert.match(result.text, /Measured 180 seconds/);
      if (single) {
        const continued = await client.callTool({ name: 'dsh_continue', arguments: { taskId: task.taskId, requestId: 'forbidden', prompt: 'retry' } });
        assert.equal(continued.structuredContent.error.code, 'NOT_RESUMABLE');
      }
    } else if (single) {
      assert.equal(done.budget.modelRequests, 1);
      assert.equal(done.status, mode === 'reasoning-only' ? 'failed' : 'completed');
      assert.equal(done.outputValidation.status, mode === 'reasoning-only' ? 'not_evaluated' : 'invalid');
      assert.equal(done.toolCalls, 0);
      const continued = await client.callTool({ name: 'dsh_continue', arguments: { taskId: task.taskId, requestId: 'forbidden', prompt: 'retry' } });
      assert.equal(continued.structuredContent.error.code, 'NOT_RESUMABLE');
    } else {
      assert.equal(done.status, 'completed', JSON.stringify(done));
      assert.equal(done.outputValidation.status, 'valid');
      assert.equal(done.orchestration.charged.modelRequests, 2);
      assert.ok(done.orchestration.charged.outputTokens <= budget.totalOutputTokens);
      assert.equal(done.orchestration.charged.toolCalls, 0);
      assert.equal(done.orchestration.recoveries, 1);
      assert.equal(done.budget.calls[0].effort, 'off');
      assert.equal(done.recovery.status, 'completed');
      const partial = JSON.parse(await readFile(done.recovery.partialPath, 'utf8'));
      assert.equal(partial.reason, mode === 'reasoning-only' ? 'OUTPUT_TRUNCATED' : 'OUTPUT_FORMAT_INVALID');
      if (mode === 'reasoning-only') assert.equal(partial.output.kind, 'reasoning_only');
      assert.ok(!JSON.stringify({ result, partial }).includes('private-delivery-reasoning-marker'));
      assert.equal(JSON.parse(JSON.parse(result.text).summary).path, 'C:\\fixture\\file.json');
    }
    assert.equal((await call('dsh_submit', input)).duplicate, true);
    const usage = await call('dsh_usage', { taskId: task.taskId });
    const requests = single || mode === 'report' ? 1 : 2;
    assert.equal(usage.recordedModelRequests, requests);
    assert.equal(usage.finishedModelRequests, requests);
    assert.equal(usage.unknownReceiptGroups, 0);
    assert.equal(usage.tokens.inputTokens.reported, requests * 100);
    assert.equal(usage.tokens.outputTokens.missingCalls, 0);
    assert.equal(usage.modelCallsPerformed, 0);
    await assert.rejects(access(join(root, 'state', 'owner.lock')), { code: 'ENOENT' });
  });
}
