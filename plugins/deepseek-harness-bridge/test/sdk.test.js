import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client';
import { createSdkRunner, prepareRuntime, ROUTE, workerEnvironment } from '../src/sdk-runner.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-sdk-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const task = { taskId: 'offline-task', sessionId: 'offline-session', workspace,
    route: { ...ROUTE, effort: 'high' }, access: 'read-only', maxToolCalls: 2, maxTokens: 256,
    attempts: [{ number: 1, timeoutMs: 5000 }] };
  const env = { ...workerEnvironment(), DEEPSEEK_API_KEY: 'offline-placeholder-not-a-credential' };
  const home = join(root, 'home');
  const runner = createSdkRunner({ env, verifyCapabilities: false, clientFactory: options => new HarnessClient({
    ...options, dshBin: fileURLToPath(new URL('./fixtures/sdk-runtime.js', import.meta.url)),
    shutdownTimeoutMs: 100, disposeEofGraceMs: 100, disposeGraceMs: 1000,
  }) });
  return { task, env, home, runner };
}

test('official SDK transports an identified prompt and reaps the fixture process', async t => {
  const f = await fixture(t);
  const output = await f.runner({ ...f, prompt: 'success', resume: false, signal: new AbortController().signal });
  assert.equal(output.text, 'fresh result');
  assert.equal(output.terminal, 'completed');
  assert.equal(output.cleanup, 'confirmed');
  assert.equal(output.error, undefined);
});

for (const mode of ['truncated', 'missing-terminal', 'empty', 'malformed', 'fail', 'tool-limit']) {
  test(`SDK ${mode} cannot become successful completion`, async t => {
    const f = await fixture(t);
    const output = await f.runner({ ...f, prompt: mode, resume: false, signal: new AbortController().signal });
    assert.notEqual(output.terminal, 'completed');
    assert.equal(output.cleanup, 'confirmed');
    assert.ok(output.error);
    assert.ok(!JSON.stringify(output).includes('dummy-provider-secret'));
  });
}

test('cancellation closes the official SDK-owned runtime', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 200);
  t.after(() => clearTimeout(timer));
  const output = await f.runner({ ...f, prompt: 'hang', resume: false, signal: controller.signal });
  assert.equal(output.cleanup, 'confirmed');
  assert.notEqual(output.terminal, 'completed');
  assert.equal(output.error.code, 'ABORTED');
});

test('output redacts the configured credential and environment excludes implicit runtime overrides', async t => {
  const f = await fixture(t);
  const output = await f.runner({ ...f, prompt: 'redact', resume: true, signal: new AbortController().signal });
  assert.equal(output.text, '[REDACTED]');
  assert.deepEqual(workerEnvironment({ PATH: 'path', NODE_OPTIONS: '--import malicious', DSH_HOME: 'other', DSH_SYSTEM_PROMPT: 'other', SECRET: 'secret' }), { PATH: 'path' });
});

test('installed SDK runtime initializes the restricted profile without a model request', { timeout: 45000 }, async t => {
  const f = await fixture(t);
  const prepared = await prepareRuntime(f);
  const client = new HarnessClient(prepared.options);
  try {
    const initialized = await client.initialize({ cwd: f.task.workspace, ...ROUTE, reasoningEffort: 'high', maxTokens: 256 });
    assert.equal(initialized.serverInfo.name, 'deepseek-harness-sdk-runtime');
    const capabilities = JSON.parse(await readFile(prepared.receiptPath, 'utf8'));
    assert.equal(capabilities.nonce, prepared.nonce);
    assert.deepEqual(capabilities.tools, ['bridge_list', 'bridge_read']);
  } finally { await client.close(); }
});
