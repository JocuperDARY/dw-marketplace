import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client';
import { resolveNativeProfile } from '../src/native-profile.js';
import { createSdkRunner, ROUTE, workerEnvironment } from '../src/sdk-runner.js';
import { createTaskContext, applyContextMessage } from '../src/task-context.js';

test('real SDK includes literal required parent context and updates it after resume', { timeout: 90000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-context-sdk-'));
  await mkdir(join(root, 'workspace'));
  const workspace = await realpath(join(root, 'workspace'));
  const modelPath = fileURLToPath(new URL('./fixtures/native-work-model.js', import.meta.url));
  const receipt = join(root, 'requests.json');
  const task = { taskId: randomUUID(), sessionId: `bridge-${randomUUID()}`, workspace, access: 'read-only',
    capabilityProfile: 'native', nativePlugins: [], planning: { executionMode: 'automatic' },
    route: { ...ROUTE, effort: 'off' }, maxTokens: null, maxModelRequests: null, maxToolCalls: null,
    maxRequestBytes: null, attempts: [{ number: 1, timeoutMs: null }],
    taskContext: createTaskContext({ assignment: 'Keep {{literal}} unchanged.', requestId: 'initial' }) };
  const profile = await resolveNativeProfile({}, task);
  profile.modules.push({ path: modelPath, sha256: createHash('sha256').update(await readFile(modelPath)).digest('hex'),
    tools: [], native: true, config: { receipt, steps: [] } });
  const runner = createSdkRunner({ resolveCapabilities: async () => profile,
    env: { ...workerEnvironment(), DEEPSEEK_API_KEY: 'offline-synthetic-not-a-secret' },
    clientFactory: options => new HarnessClient({ ...options, env: { ...options.env,
      NODE_OPTIONS: `${options.env.NODE_OPTIONS ?? ''} --import=${new URL('./fixtures/offline-network.js', import.meta.url).href}` } }) });
  t.after(async () => { if (t.passed) await rm(root, { recursive: true, force: true }); else t.diagnostic(`Retained: ${root}`); });
  for (const resume of [false, true]) {
    if (resume) { task.attempts.push({ number: 2, timeoutMs: null }); task.taskContext = applyContextMessage(task.taskContext, { id: 'followup', text: 'DO_NOT_RETRAIN' }); }
    const output = await runner({ task, resume, home: join(root, 'home'), prompt: 'Produce the offline result.', signal: AbortSignal.timeout(60000) });
    assert.equal(output.terminal, 'completed', JSON.stringify(output));
    assert.equal(output.cleanup, 'confirmed');
    assert.equal(output.contextEvidence.requests.at(-1).contextRevision, resume ? 2 : 1);
    const requests = JSON.parse(await readFile(receipt, 'utf8'));
    assert.match(JSON.stringify(requests.at(-1).messages), /\{\{literal\}\}/);
    if (resume) assert.match(JSON.stringify(requests.at(-1).messages), /DO_NOT_RETRAIN/);
  }
});
