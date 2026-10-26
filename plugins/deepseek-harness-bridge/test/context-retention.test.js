import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskManager } from '../src/tasks.js';
import { contextSnapshot } from '../src/task-context.js';

for (const executionMode of ['automatic', 'budgeted']) test(`${executionMode} retains twelve parent activities across an owner restart`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-context-'));
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  const seen = []; const managers = [];
  const create = async () => {
    const manager = await new TaskManager({ dataDir: join(root, 'state'),
      resolveCapabilities: async id => ({ id, digest: 'offline', access: 'read-only' }),
      runner: async ({ task }) => {
        seen.push(contextSnapshot(task.taskContext));
        return { terminal: 'completed', cleanup: 'confirmed', toolCalls: 0,
          text: executionMode === 'budgeted' ? JSON.stringify({ state: 'completed', summary: 'Edit finished.', nextSteps: '' }) : 'Edit finished.',
          budget: { nonce: task.stageBudget?.nonce, modelRequests: 1, denied: null,
            calls: [{ number: 1, reservedOutputTokens: task.maxTokens, usage: { outputTokens: 1 }, finished: true }] } };
      } }).open();
    managers.push(manager); return manager;
  };
  t.after(async () => { await Promise.all(managers.map(manager => manager.close())); if (t.passed) await rm(root, { recursive: true, force: true }); });
  let manager = await create();
  const first = await manager.submit({ requestId: 'round-0', workspace, prompt: 'Preserve the report format.', executionMode });
  await manager.wait({ taskId: first.taskId });
  for (let round = 1; round <= 12; round++) {
    if (round === 5) { await manager.close(); manager = await create(); }
    const prompt = round === 1 ? 'DO_NOT_RETRAIN: reuse the verified artifact.' : `Correct report item ${round}.`;
    await manager.continue({ taskId: first.taskId, controlToken: first.controlToken, requestId: `round-${round}`, prompt });
    assert.equal((await manager.wait({ taskId: first.taskId })).status, 'completed');
  }
  assert.equal(seen.length, 13);
  for (const state of seen.slice(1)) assert.ok(state.activeInstructions.some(item => item.text.startsWith('DO_NOT_RETRAIN')));
  assert.equal(seen.at(-1).activeInstructions.length, 13);
  await manager.continue({ taskId: first.taskId, controlToken: first.controlToken, requestId: 'legacy-large', prompt: 'x'.repeat(65536) });
  assert.equal((await manager.wait({ taskId: first.taskId })).status, 'completed');
  assert.equal(seen.at(-1).activeInstructions.at(-1).text.length, 65536, 'The existing continuation size contract must not shrink');
});
