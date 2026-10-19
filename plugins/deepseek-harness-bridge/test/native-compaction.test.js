import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client';
import { resolveProfile } from '../src/capabilities.js';
import { createSdkRunner, workerEnvironment, prepareRuntime } from '../src/sdk-runner.js';

test('native compaction is preferred and repeatedly replaces real SDK history through the shared meter offline', { timeout: 45000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-compaction-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  await writeFile(join(workspace, 'input.txt'), 'fixture context words '.repeat(500));
  const task = { taskId: 'compaction', sessionId: 'compaction', workspace, access: 'read-only', capabilityProfile: 'native', nativePlugins: [],
    planning: { executionMode: 'automatic' }, route: { provider: 'deepseek-official', model: 'deepseek-flash', effort: 'off' },
    maxTokens: 256, maxModelRequests: null, maxRequestBytes: null, maxToolCalls: null, attempts: [{ number: 1, timeoutMs: null }] };
  const profile = await resolveProfile('native', {}, task);
  const modulePath = fileURLToPath(new URL('./fixtures/native-compaction-model.js', import.meta.url));
  profile.modules.push({ path: modulePath, sha256: createHash('sha256').update(await readFile(modulePath)).digest('hex'), tools: [], native: true, config: {} });
  const override = join(root, 'test-context.patch.json');
  // A small context triggers the native mechanism quickly; this is test-only.
  await writeFile(override, JSON.stringify([{ id: 'llm-deepseek', config: { models: [{ id: 'deepseek-flash', contextWindow: 4000 }] } },
    { id: 'compaction-basic', config: { thresholdRatio: 0.5, retainTokens: 0, headroomTokens: 256 } }]));
  const events = [];
  const runner = createSdkRunner({ resolveCapabilities: async () => profile,
    env: { ...workerEnvironment(), DEEPSEEK_API_KEY: 'offline-not-a-credential' },
    clientFactory: options => {
      const client = new HarnessClient({ ...options, patches: [...options.patches, override], env: { ...options.env,
        NODE_OPTIONS: `${options.env.NODE_OPTIONS} --import=${new URL('./fixtures/offline-network.js', import.meta.url).href}` } });
      const subscribe = client.subscribe.bind(client);
      client.subscribe = filter => subscribe(notification => { if (notification.params?.event?.type?.startsWith('compaction/')) events.push(notification.params.event); return filter(notification); });
      return client;
    } });
  const result = await runner({ task, prompt: 'Run the offline read fixture, then return its marker.', signal: AbortSignal.timeout(35000), home: join(root, 'home') });
  assert.equal(result.terminal, 'completed', JSON.stringify(result));
  assert.equal(result.cleanup, 'confirmed');
  assert.equal(result.text, 'NATIVE_COMPACTION_DONE');
  assert.equal(result.capabilities.selection.contextStrategy, 'native-compaction');
  const compacted = result.budget.calls.filter(call => call.purpose === 'compaction');
  assert.ok(compacted.length >= 2, JSON.stringify({ calls: result.budget.calls, events }));
  assert.equal(result.budget.modelRequests, 5 + compacted.length);
  assert.ok(events.filter(event => event.type === 'compaction/end').length >= 2);
  assert.ok(compacted.every(call => call.reservedOutputTokens === 256 && call.finished));
  const single = await prepareRuntime({ task: { ...task, planning: { executionMode: 'single-request' } }, home: join(root, 'single'), env: {}, resolveCapabilities: async () => profile });
  const patch = JSON.parse(await readFile(single.options.patches[0], 'utf8'));
  assert.equal(patch.find(entry => entry.id === 'compaction-basic').disabled, true);
});
