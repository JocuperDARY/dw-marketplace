import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectionTasks } from '../src/connection-tasks.js';
import { ConcurrentStore } from '../src/concurrent-store.js';

const complete = text => ({ text, terminal: 'completed', cleanup: 'confirmed' });
async function fixture(t, runner) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-connections-'));
  const workspace = join(root, 'workspace');
  const dataDir = join(root, 'state');
  await mkdir(workspace);
  const resolveCapabilities = async id => ({ id, digest: 'offline', access: 'read-only' });
  const first = new ConnectionTasks({ dataDir, runner, resolveCapabilities });
  const second = new ConnectionTasks({ dataDir, runner, resolveCapabilities });
  t.after(async () => {
    await Promise.all([first.close(), second.close()]);
    await rm(root, { recursive: true, force: true });
  });
  return { first, second, workspace, dataDir };
}

test('discovery and empty observations do not initialize or own the task store', async t => {
  const f = await fixture(t, () => assert.fail('No worker needed'));
  assert.equal((await f.first.list()).total, 0);
  assert.equal((await f.second.usage()).tasks, 0);
  await assert.rejects(access(f.dataDir), { code: 'ENOENT' });
  await Promise.all([f.first.close(), f.first.close(), f.second.close()]);
  await assert.rejects(f.first.list(), { code: 'CLOSED' });
});

test('idle connection retains its control identity; another connection observes without acquiring it', async t => {
  let launches = 0;
  const f = await fixture(t, async input => { launches++; return complete(input.prompt); });
  const input = { workspace: f.workspace, requestId: 'first', prompt: 'one' };
  const task = await f.first.submit(input);
  await f.first.wait({ taskId: task.taskId });
  const owner = f.first.manager;
  assert.equal((await f.first.list()).total, 1);
  assert.equal(f.first.manager, owner);
  assert.equal((await f.second.list()).total, 0);
  assert.equal((await f.second.list({ scope: 'store' })).total, 1);
  assert.equal((await f.second.submit(input)).duplicate, true);
  await assert.rejects(f.second.continue({ taskId: task.taskId, requestId: 'foreign', prompt: 'two' }), { code: 'NOT_OWNER' });
  await f.first.continue({ taskId: task.taskId, requestId: 'followup', prompt: 'two' });
  await f.first.wait({ taskId: task.taskId });
  assert.equal((await f.second.result({ taskId: task.taskId })).text, 'two');
  assert.equal((await f.second.usage({ scope: 'store' })).tasks, 1);
  assert.equal(launches, 2);
  assert.deepEqual((await f.first.manager.store.read()).leases, []);
  const guard = JSON.parse(await readFile(join(f.dataDir, 'owner.lock'), 'utf8'));
  assert.equal(guard.kind, 'bridge-protocol-guard');
});

test('two connections run concurrently; closing one cancels only its own worker', async t => {
  const started = new Map();
  const f = await fixture(t, ({ task, signal }) => new Promise(resolve => {
    started.set(task.taskId, resolve);
    signal.addEventListener('abort', () => resolve({ ...complete('stopped'), terminal: 'aborted' }), { once: true });
  }));
  const [a, b] = await Promise.all([
    f.first.submit({ workspace: f.workspace, requestId: 'a', prompt: 'a' }),
    f.second.submit({ workspace: f.workspace, requestId: 'b', prompt: 'b' }),
  ]);
  assert.equal(started.size, 2);
  assert.equal((await f.first.list({ scope: 'store' })).activeTaskIds.length, 2);
  assert.equal((await f.second.status({ taskId: a.taskId })).status, 'running');
  await assert.rejects(f.second.result({ taskId: a.taskId }), { code: 'NOT_FINISHED' });
  const waiting = f.first.wait({ taskId: a.taskId, timeoutMs: 1000 });
  await f.first.close();
  assert.equal((await waiting).status, 'cancelled');
  assert.equal((await f.second.status({ taskId: b.taskId })).status, 'running');
  started.get(b.taskId)(complete('b survived'));
  assert.equal((await f.second.wait({ taskId: b.taskId })).cleanup, 'confirmed');
  assert.equal((await f.second.result({ taskId: b.taskId })).text, 'b survived');
  assert.deepEqual((await f.second.manager.store.read()).leases, []);
});

test('observations preserve a legacy lock and malformed historical evidence without claiming ownership', async t => {
  const f = await fixture(t, () => assert.fail('No worker needed'));
  const id = '00000000-0000-4000-8000-000000000000';
  const path = join(f.dataDir, 'tasks', id);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'task.json'), '{"schemaVersion":1,"attempts":[]}');
  await writeFile(join(f.dataDir, 'owner.lock'), 'legacy owner evidence');
  for (const connection of [f.first, f.second]) {
    await assert.rejects(connection.list({ scope: 'store' }), { code: 'INVALID_STATE' });
  }
  assert.equal(await readFile(join(path, 'task.json'), 'utf8'), '{"schemaVersion":1,"attempts":[]}');
  assert.equal(await readFile(join(f.dataDir, 'owner.lock'), 'utf8'), 'legacy owner evidence');
  assert.deepEqual((await readdir(f.dataDir)).sort(), ['owner.lock', 'tasks']);
});

test('uncertain cleanup retains only its task lease and remains observable after connection close', async t => {
  const f = await fixture(t, async () => ({ ...complete('unknown'), cleanup: 'unverified' }));
  const task = await f.first.submit({ workspace: f.workspace, requestId: 'uncertain', prompt: 'one' });
  assert.equal((await f.first.wait({ taskId: task.taskId })).status, 'cleanup_failed');
  await f.first.close();
  assert.equal((await f.second.status({ taskId: task.taskId })).cleanup, 'unverified');
  assert.equal((await f.second.manager.store.read()).leases[0].taskId, task.taskId);
});

test('a temporary read failure does not poison the connection after initialization completes', async t => {
  const f = await fixture(t, () => assert.fail('No worker needed'));
  await new ConcurrentStore({ dataDir: f.dataDir }).initialize();
  const path = join(f.dataDir, 'protocol.json');
  const manifest = await readFile(path, 'utf8');
  await rm(path);
  await assert.rejects(f.first.list(), { code: 'RECOVERY_REQUIRED' });
  await writeFile(path, manifest);
  assert.equal((await f.first.list()).total, 0);
  assert.equal((await f.first.manager.store.read()).leases.length, 0);
});
