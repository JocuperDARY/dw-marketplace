import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskManager } from '../src/tasks.js';

const capabilities = async id => ({ id, digest: 'offline', access: 'read-only' });
const completed = async () => ({ terminal: 'completed', text: 'result', cleanup: 'confirmed' });
const abortable = ({ signal }) => new Promise(resolve => {
  const finish = () => resolve({ terminal: 'aborted', text: 'partial', cleanup: 'confirmed' });
  if (signal.aborted) finish(); else signal.addEventListener('abort', finish, { once: true });
});

async function fixture(t, runner = abortable) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-concurrent-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const managers = [];
  const manager = async (run = runner) => {
    const value = await new TaskManager({ dataDir: join(root, 'state'), runner: run, resolveCapabilities: capabilities }).open();
    managers.push(value);
    return value;
  };
  t.after(async () => { await Promise.all(managers.map(value => value.close())); await rm(root, { recursive: true, force: true }); });
  const input = (requestId, extra = {}) => ({ requestId, executionMode: 'single-request', prompt: 'Task', workspace, ...extra });
  return { root, workspace, manager, input };
}

test('independent task controllers run concurrently and cancellation affects only the selected task', async t => {
  const f = await fixture(t);
  const manager = await f.manager();
  const [first, second] = await Promise.all([manager.submit(f.input('one')), manager.submit(f.input('two'))]);
  assert.deepEqual(new Set((await manager.list()).activeTaskIds), new Set([first.taskId, second.taskId]));
  assert.equal((await manager.list()).activeTaskId, null);
  assert.equal((await manager.cancel({ taskId: first.taskId })).status, 'cancelled');
  assert.equal((await manager.status({ taskId: second.taskId })).status, 'running');
  assert.equal((await manager.list()).activeTaskId, second.taskId);
});

test('committed cross-manager observations never interrupt another owner and close cancels only local work', async t => {
  const f = await fixture(t);
  const owner = await f.manager();
  const first = await owner.submit(f.input('owner-one'));
  const observer = await f.manager();
  assert.equal((await observer.status({ taskId: first.taskId })).status, 'running');
  const second = await observer.submit(f.input('owner-two'));
  await observer.close();
  assert.equal((await owner.status({ taskId: first.taskId })).status, 'running');
  assert.equal((await owner.status({ taskId: second.taskId })).status, 'cancelled');
});

test('control capabilities are private and cross-manager cancellation waits for real owner cleanup', async t => {
  const f = await fixture(t);
  let launchedTask;
  let release;
  let aborted;
  const sawAbort = new Promise(resolve => { aborted = resolve; });
  const owner = await f.manager(async args => {
    launchedTask = args.task;
    await new Promise(resolve => args.signal.addEventListener('abort', () => { aborted(); release = resolve; setTimeout(resolve, 2000).unref(); }, { once: true }));
    return { terminal: 'aborted', text: 'owner-cleaned', cleanup: 'confirmed' };
  });
  const first = await owner.submit(f.input('capability', { parentLabel: 'display only' }));
  const observer = await f.manager();
  assert.equal(typeof first.controlToken, 'string');
  assert.ok(first.controlToken.length >= 32);
  for (const value of [launchedTask, await observer.status({ taskId: first.taskId }), await observer.list(), await observer.usage()]) {
    assert.ok(!JSON.stringify(value).includes(first.controlToken));
    assert.ok(!JSON.stringify(value).includes('controlTokenHash'));
  }
  const duplicate = await observer.submit(f.input('capability', { parentLabel: 'display only' }));
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.controlToken, undefined);
  await assert.rejects(observer.cancel({ taskId: first.taskId }), { code: 'NOT_OWNER' });
  await assert.rejects(observer.cancel({ taskId: first.taskId, controlToken: 'invalid' }), { code: 'NOT_OWNER' });
  const pending = observer.cancel({ taskId: first.taskId, controlToken: first.controlToken, timeoutMs: 0 });
  await sawAbort;
  assert.ok(['running', 'cancelling'].includes((await pending).status));
  release();
  const done = await observer.wait({ taskId: first.taskId, timeoutMs: 1000 });
  assert.equal(done.status, 'cancelled');
  assert.equal(done.cleanup, 'confirmed');
  assert.equal((await observer.result({ taskId: first.taskId })).text, 'owner-cleaned');
});

test('cross-manager request replay launches once and conflicting inputs reject', async t => {
  let launches = 0;
  const f = await fixture(t, args => { launches++; return abortable(args); });
  const first = await f.manager();
  const second = await f.manager();
  const results = await Promise.all([first.submit(f.input('shared')), second.submit(f.input('shared'))]);
  assert.equal(results[0].taskId, results[1].taskId);
  assert.equal(results.filter(value => value.duplicate).length, 1);
  assert.equal(results.filter(value => value.controlToken).length, 1);
  assert.equal(launches, 1);
  await assert.rejects(second.submit(f.input('shared', { prompt: 'different' })), { code: 'REQUEST_CONFLICT' });
});

test('unverified cleanup quarantines only its task and workspace, preserving unrelated capacity', async t => {
  const f = await fixture(t, async () => ({ terminal: 'error', cleanup: 'unverified', text: '' }));
  const manager = await f.manager();
  const first = await manager.submit(f.input('unclean', { access: 'workspace-write', executionMode: 'automatic', capabilityProfile: 'inference-only' }));
  assert.equal((await manager.wait({ taskId: first.taskId })).status, 'cleanup_failed');
  await assert.rejects(manager.submit(f.input('conflict')), { code: 'WORKSPACE_BUSY' });
  const another = join(f.root, 'another');
  await mkdir(another);
  const other = await manager.submit(f.input('unrelated', { workspace: another }));
  assert.equal((await manager.wait({ taskId: other.taskId })).status, 'cleanup_failed');
});

test('concurrent continuation acquires the latest attempt exactly once and requires control', async t => {
  const f = await fixture(t);
  const owner = await f.manager(completed);
  const first = await owner.submit(f.input('initial', { executionMode: 'automatic', capabilityProfile: 'inference-only' }));
  await owner.wait({ taskId: first.taskId });
  const observer = await f.manager(abortable);
  await assert.rejects(observer.continue({ taskId: first.taskId, requestId: 'unauthorized', prompt: 'More' }), { code: 'NOT_OWNER' });
  const input = { taskId: first.taskId, requestId: 'followup', prompt: 'More', controlToken: first.controlToken };
  const [a, b] = await Promise.all([observer.continue(input), observer.continue(input)]);
  assert.equal(a.number, 2);
  assert.equal(b.number, 2);
  assert.equal(b.duplicate, true);
  assert.equal((await owner.status({ taskId: first.taskId })).number, 2);
});

for (const failure of ['saveResult', 'persist']) {
  test(`${failure} failure retains only its lease and reports honest durable or local failure evidence`, async t => {
    const f = await fixture(t, completed);
    const owner = await f.manager();
    const observer = await f.manager();
    const original = owner[failure].bind(owner);
    owner[failure] = async () => { throw new Error('offline disk failure'); };
    const first = await owner.submit(f.input(`failure-${failure}`, {
      executionMode: 'automatic', capabilityProfile: 'inference-only', access: 'workspace-write',
    }));
    const done = await owner.wait({ taskId: first.taskId, timeoutMs: 1000 });
    assert.equal(done.status, 'state_write_failed');
    const durable = await observer.status({ taskId: first.taskId });
    if (failure === 'persist') {
      assert.equal(done.durability, 'unconfirmed');
      assert.equal(done.committedStatus, 'running');
      assert.equal(durable.status, 'running');
    } else {
      assert.equal(durable.status, 'state_write_failed');
      assert.equal(done.durability, undefined);
    }
    assert.equal((await owner.store.read()).leases.length, 1);
    await assert.rejects(observer.submit(f.input(`conflict-${failure}`)), { code: 'WORKSPACE_BUSY' });
    owner[failure] = original;
    const unrelated = join(f.root, 'unrelated');
    await mkdir(unrelated);
    const next = await owner.submit(f.input(`healthy-${failure}`, { workspace: unrelated }));
    assert.equal((await owner.wait({ taskId: next.taskId })).status, 'completed');
    assert.equal((await observer.status({ taskId: first.taskId })).status, durable.status);
  });
}

for (const requested of [false, true]) {
  test(`cancellation response stays on its observed attempt across continuation (requested=${requested})`, async t => {
    const f = await fixture(t);
    let release;
    let launches = 0;
    const firstResult = new Promise(resolve => { release = resolve; });
    const owner = await f.manager(args => ++launches === 1 ? firstResult : abortable(args));
    // Keep the owner from observing the mailbox before the original worker's
    // natural completion; the next lease must ignore that old mailbox.
    owner.pollCancellation = async () => {};
    const observer = await f.manager();
    const first = await owner.submit(f.input(`cancel-race-${requested}`, { executionMode: 'automatic', capabilityProfile: 'inference-only' }));
    if (!requested) { release(await completed()); await owner.wait({ taskId: first.taskId }); }
    const original = observer.store.requestCancel.bind(observer.store);
    observer.store.requestCancel = async (...args) => {
      const receipt = await original(...args);
      assert.equal(receipt.requested, requested);
      if (requested) { release(await completed()); await owner.wait({ taskId: first.taskId }); }
      await owner.continue({ taskId: first.taskId, requestId: `race-next-${requested}`, prompt: 'Continue' });
      return receipt;
    };
    const result = await observer.cancel({ taskId: first.taskId, controlToken: first.controlToken, timeoutMs: 0 });
    assert.equal(result.number, 1);
    assert.equal(result.status, 'completed');
    assert.equal(result.cancelRequested, undefined);
    assert.equal((await observer.status({ taskId: first.taskId })).number, 2);
    assert.equal((await observer.status({ taskId: first.taskId })).status, 'running');
  });
}

test('wait includes lease release after terminal result publication', async t => {
  const f = await fixture(t, completed);
  const owner = await f.manager();
  const observer = await f.manager();
  let entered;
  const reached = new Promise(resolve => { entered = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const original = owner.store.release.bind(owner.store);
  owner.store.release = async (...args) => { entered(); await gate; return original(...args); };
  const first = await owner.submit(f.input('release-pending'));
  await reached;
  let settled = false;
  let waiting;
  try {
    assert.equal((await observer.status({ taskId: first.taskId })).leasePending, true);
    waiting = observer.wait({ taskId: first.taskId, timeoutMs: 1000 }).then(value => { settled = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.equal(settled, false);
  } finally { release(); }
  const done = await waiting;
  assert.equal(done.status, 'completed');
  assert.equal(done.leasePending, undefined);
});
