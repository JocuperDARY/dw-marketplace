import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ConnectionTasks } from '../src/connection-tasks.js';

const complete = text => ({ text, terminal: 'completed', cleanup: 'confirmed' });
async function fixture(t, runner) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-connections-'));
  const workspace = join(root, 'workspace');
  const dataDir = join(root, 'state');
  await mkdir(workspace);
  const first = new ConnectionTasks({ dataDir, runner });
  const second = new ConnectionTasks({ dataDir, runner });
  t.after(async () => {
    await Promise.all([first.close(), second.close()]);
    await rm(root, { recursive: true, force: true });
  });
  return { first, second, workspace, lock: join(dataDir, 'owner.lock') };
}

test('completed task releases ownership and another connection resumes the same session', async t => {
  let launches = 0;
  const calls = [];
  const { first, second, workspace, lock } = await fixture(t, async input => {
    launches++; calls.push(input); return complete(input.prompt);
  });
  const input = { workspace, requestId: 'first', prompt: 'one' };
  const task = await first.submit(input);
  await first.wait({ taskId: task.taskId });
  await assert.rejects(access(lock), { code: 'ENOENT' });
  assert.equal((await second.submit(input)).duplicate, true);
  const continued = await second.continue({ taskId: task.taskId, requestId: 'second', prompt: 'two' });
  await second.wait({ taskId: task.taskId });
  assert.equal(continued.sessionId, task.sessionId);
  assert.equal(continued.number, 2);
  assert.equal(calls[1].resume, true);
  assert.equal((await first.result({ taskId: task.taskId, attempt: 1 })).text, 'one');
  assert.equal((await first.result({ taskId: task.taskId })).text, 'two');
  assert.equal(launches, 2);
  await assert.rejects(access(lock), { code: 'ENOENT' });
});

test('active worker excludes other connections, cancellation releases the lease', async t => {
  let launches = 0;
  const { first, second, workspace, lock } = await fixture(t, ({ signal }) => {
    launches++;
    return new Promise(resolve => signal.addEventListener('abort', () => resolve({ ...complete('cancelled'), terminal: 'aborted' }), { once: true }));
  });
  const task = await first.submit({ workspace, requestId: 'running', prompt: 'one' });
  const owner = await readFile(lock, 'utf8');
  await assert.rejects(second.submit({ workspace, requestId: 'competitor', prompt: 'two' }), { code: 'STATE_LOCKED' });
  assert.equal(await readFile(lock, 'utf8'), owner);
  assert.equal(launches, 1);
  assert.equal((await first.cancel({ taskId: task.taskId })).cleanup, 'confirmed');
  assert.equal((await second.status({ taskId: task.taskId })).status, 'cancelled');
  await assert.rejects(access(lock), { code: 'ENOENT' });
});

test('automatic completion releases ownership without polling', async t => {
  let finish;
  const { first, workspace, lock } = await fixture(t, () => new Promise(resolve => { finish = resolve; }));
  await first.submit({ workspace, requestId: 'unpolled', prompt: 'one' });
  await access(lock);
  finish(complete('done'));
  for (let count = 0; count < 100 && first.manager; count++) await delay(5);
  assert.equal(first.manager, null);
  await assert.rejects(access(lock), { code: 'ENOENT' });
});

test('unverified cleanup retains the lock and prevents another worker', async t => {
  const { first, second, workspace, lock } = await fixture(t, async () => ({ ...complete('unknown'), cleanup: 'unverified' }));
  const task = await first.submit({ workspace, requestId: 'unverified', prompt: 'one' });
  assert.equal((await first.wait({ taskId: task.taskId })).status, 'cleanup_failed');
  const owner = await readFile(lock, 'utf8');
  await first.close();
  await assert.rejects(second.list(), { code: 'STATE_LOCKED' });
  assert.equal(await readFile(lock, 'utf8'), owner);
});

test('shutdown cancels an active worker while wait is in flight', async t => {
  const { first, second, workspace, lock } = await fixture(t, ({ signal }) => new Promise(resolve => {
    signal.addEventListener('abort', () => resolve({ ...complete('stopped'), terminal: 'aborted' }), { once: true });
  }));
  const task = await first.submit({ workspace, requestId: 'shutdown', prompt: 'one' });
  const waiting = first.wait({ taskId: task.taskId, timeoutMs: 1000 });
  await first.transitions;
  const closing = first.close();
  assert.equal((await waiting).status, 'cancelled');
  await closing;
  await assert.rejects(first.list(), { code: 'CLOSED' });
  assert.equal((await second.status({ taskId: task.taskId })).cleanup, 'confirmed');
  await assert.rejects(access(lock), { code: 'ENOENT' });
});
