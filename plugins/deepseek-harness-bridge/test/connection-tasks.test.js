import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ConnectionTasks } from '../src/connection-tasks.js';

const complete = text => ({ text, terminal: 'completed', cleanup: 'confirmed' });
async function fixture(t, runner) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-connections-'));
  const workspace = join(root, 'workspace');
  const dataDir = join(root, 'state');
  await mkdir(workspace);
  const resolveCapabilities = async id => ({ id, digest: 'offline', access: 'read-only' });
  const first = new ConnectionTasks({ dataDir, runner, resolveCapabilities, observationWaitMs: 150 });
  const second = new ConnectionTasks({ dataDir, runner, resolveCapabilities, observationWaitMs: 150 });
  t.after(async () => {
    await Promise.all([first.close(), second.close()]);
    await rm(root, { recursive: true, force: true });
  });
  return { first, second, workspace, lock: join(dataDir, 'owner.lock') };
}

test('completed task releases ownership and another connection reads an idempotent result', async t => {
  let launches = 0;
  const calls = [];
  const { first, second, workspace, lock } = await fixture(t, async input => {
    launches++; calls.push(input); return complete(input.prompt);
  });
  const input = { executionMode: 'single-request', workspace, requestId: 'first', prompt: 'one' };
  const task = await first.submit(input);
  await first.wait({ taskId: task.taskId });
  await assert.rejects(access(lock), { code: 'ENOENT' });
  assert.equal((await second.submit(input)).duplicate, true);
  await assert.rejects(second.continue({ taskId: task.taskId, requestId: 'second', prompt: 'two' }), { code: 'NOT_RESUMABLE' });
  assert.equal((await first.result({ taskId: task.taskId, attempt: 1 })).text, 'one');
  assert.equal((await first.result({ taskId: task.taskId })).text, 'one');
  assert.equal((await second.usage()).tasks, 1);
  assert.equal((await second.usage({ taskId: task.taskId })).unknownReceiptGroups, 1);
  assert.equal(launches, 1);
  await assert.rejects(access(lock), { code: 'ENOENT' });
});

for (const method of ['list', 'status']) {
  test(`${method} rejects corrupt saved attempts and leaves the lock for reconciliation`, async t => {
    let launches = 0;
    const { first, second, lock } = await fixture(t, () => { launches++; throw new Error('must not launch'); });
    const taskId = '00000000-0000-4000-8000-000000000000';
    const path = join(dirname(lock), 'tasks', taskId, 'task.json');
    await mkdir(dirname(path), { recursive: true });
    const saved = JSON.stringify({ schemaVersion: 1, taskId, attempts: [] });
    await writeFile(path, saved);
    await assert.rejects(first[method]({ taskId }), { code: 'INVALID_STATE' });
    const owner = await readFile(lock, 'utf8');
    await first.close();
    await assert.rejects(second[method]({ taskId }), { code: 'STATE_LOCKED' });
    assert.equal(await readFile(lock, 'utf8'), owner);
    assert.equal(await readFile(path, 'utf8'), saved);
    assert.equal(launches, 0);
  });
}

test('result observation waits through a short ownership conflict without relaunching work', async t => {
  let finish;
  let launches = 0;
  const { first, second, workspace, lock } = await fixture(t, () => { launches++; return new Promise(resolve => { finish = resolve; }); });
  const task = await first.submit({ executionMode: 'single-request', workspace, requestId: 'read-race', prompt: 'one' });
  const reading = second.result({ taskId: task.taskId });
  await delay(30);
  finish(complete('preserved result'));
  assert.equal((await reading).text, 'preserved result');
  assert.equal(launches, 1);
  await assert.rejects(access(lock), { code: 'ENOENT' });
});

test('persistent ownership is reported as an observation conflict and shutdown interrupts waiting', async t => {
  const { first, second, workspace, lock } = await fixture(t, ({ signal }) => new Promise(resolve => {
    signal.addEventListener('abort', () => resolve({ ...complete('stopped'), terminal: 'aborted' }), { once: true });
  }));
  const task = await first.submit({ executionMode: 'single-request', workspace, requestId: 'held', prompt: 'one' });
  const owner = await readFile(lock, 'utf8');
  await assert.rejects(second.status({ taskId: task.taskId }), error => error.code === 'STATE_LOCKED' && error.retryable === true && error.operation === 'observation');
  await assert.rejects(second.usage(), error => error.code === 'STATE_LOCKED' && error.retryable === true && error.operation === 'observation');
  assert.equal(await readFile(lock, 'utf8'), owner);
  const pending = second.result({ taskId: task.taskId });
  await delay(10);
  await second.close();
  await assert.rejects(pending, { code: 'CLOSED' });
  assert.equal(await readFile(lock, 'utf8'), owner);
});

test('active worker excludes other connections, cancellation releases the lease', async t => {
  let launches = 0;
  const { first, second, workspace, lock } = await fixture(t, ({ signal }) => {
    launches++;
    return new Promise(resolve => signal.addEventListener('abort', () => resolve({ ...complete('cancelled'), terminal: 'aborted' }), { once: true }));
  });
  const task = await first.submit({ executionMode: 'single-request', workspace, requestId: 'running', prompt: 'one' });
  const owner = await readFile(lock, 'utf8');
  await assert.rejects(second.submit({ executionMode: 'single-request', workspace, requestId: 'competitor', prompt: 'two' }), { code: 'STATE_LOCKED' });
  assert.equal(await readFile(lock, 'utf8'), owner);
  assert.equal(launches, 1);
  assert.equal((await first.cancel({ taskId: task.taskId })).cleanup, 'confirmed');
  assert.equal((await second.status({ taskId: task.taskId })).status, 'cancelled');
  await assert.rejects(access(lock), { code: 'ENOENT' });
});

test('automatic completion releases ownership without polling', async t => {
  let finish;
  const { first, workspace, lock } = await fixture(t, () => new Promise(resolve => { finish = resolve; }));
  await first.submit({ executionMode: 'single-request', workspace, requestId: 'unpolled', prompt: 'one' });
  await access(lock);
  finish(complete('done'));
  for (let count = 0; count < 100 && first.manager; count++) await delay(5);
  assert.equal(first.manager, null);
  await assert.rejects(access(lock), { code: 'ENOENT' });
});

test('unverified cleanup retains the lock and prevents another worker', async t => {
  const { first, second, workspace, lock } = await fixture(t, async () => ({ ...complete('unknown'), cleanup: 'unverified' }));
  const task = await first.submit({ executionMode: 'single-request', workspace, requestId: 'unverified', prompt: 'one' });
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
  const task = await first.submit({ executionMode: 'single-request', workspace, requestId: 'shutdown', prompt: 'one' });
  const waiting = first.wait({ taskId: task.taskId, timeoutMs: 1000 });
  await first.transitions;
  const closing = first.close();
  assert.equal((await waiting).status, 'cancelled');
  await closing;
  await assert.rejects(first.list(), { code: 'CLOSED' });
  assert.equal((await second.status({ taskId: task.taskId })).cleanup, 'confirmed');
  await assert.rejects(access(lock), { code: 'ENOENT' });
});
