import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { HistoryPages, normalizeHistory } from '../src/history.js';
import { TaskManager } from '../src/tasks.js';
import { ConnectionTasks } from '../src/connection-tasks.js';
import { createServer } from '../src/server.js';

const row = (index, extra = {}) => ({ taskId: `task-${String(index).padStart(3, '0')}`, status: 'completed',
  startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(), parentLabel: 'parent-A', ...extra });
const query = input => normalizeHistory(input).query;
const next = (history, request) => { const { query, cursor } = normalizeHistory(request); return history.next(query, cursor); };

test('default50 and subsequent pages preserve a stable snapshot across mutations and insertions', () => {
  const history = new HistoryPages();
  const rows = Array.from({ length: 123 }, (_, i) => row(i));
  let page = history.capture(query(), rows);
  assert.equal(page.tasks.length, 50); assert.equal(page.total, 123);
  const firstId = page.tasks[0].taskId;
  page.tasks[0].status = 'failed';
  rows[0].status = 'failed'; rows.push(row(999));
  const ids = [firstId, ...page.tasks.slice(1).map(x => x.taskId)];
  const request = page.pagination.nextRequest;
  while (page.pagination.nextRequest) {
    page = next(history, page.pagination.nextRequest);
    assert.equal(page.total, 123);
    assert.equal(page.tasks.every(x => x.status === 'completed'), true);
    ids.push(...page.tasks.map(x => x.taskId));
  }
  assert.equal(ids.length, 123); assert.equal(new Set(ids).size, 123);
  assert.equal(ids.includes('task-999'), false);
  assert.deepEqual(next(history, request), next(history, request), 'cursor replay is deterministic');
  assert.equal(history.capture(query(), rows).total, 124, 'fresh query sees new tasks');
});

test('exact labels/statuses and inclusive/exclusive UTC times filter latest summaries', () => {
  const history = new HistoryPages();
  const rows = [row(0), row(1, { status: 'running' }), row(2, { parentLabel: 'parent-B' }), row(3), row(4)];
  const page = history.capture(query({ scope: 'store', parentLabel: 'parent-A', statuses: ['completed'],
    startedFrom: rows[0].startedAt, startedBefore: rows[4].startedAt }), rows, ['task-001', 'task-003']);
  assert.deepEqual(page.tasks.map(x => x.taskId), ['task-003', 'task-000']);
  assert.equal(page.total, 2); assert.equal(page.scopeTotal, 5);
  assert.deepEqual(page.activeTaskIds, ['task-003']);
  assert.equal(page.activeTaskId, 'task-003');
  assert.equal(history.capture(query({ parentLabel: 'Parent-A' }), rows).total, 0);
});

test('ties use task identity and equivalent filter representations preserve cursor identity', () => {
  const history = new HistoryPages();
  const rows = [row(1, { startedAt: row(0).startedAt }), row(2, { startedAt: row(0).startedAt })];
  const first = history.capture(query({ limit: 1, statuses: ['failed', 'completed'], startedFrom: '2026-01-01T00:00:00Z' }), rows);
  assert.equal(first.tasks[0].taskId, 'task-002');
  assert.equal(next(history, { ...first.pagination.nextRequest, statuses: ['completed', 'failed'] }).tasks[0].taskId, 'task-001');
});

test('sub-millisecond filter precision is rejected instead of silently moving interval boundaries', () => {
  for (const field of ['startedFrom', 'startedBefore']) {
    for (const value of ['2026-01-01T00:00:00.0001Z', '2026-01-01T00:00:00.0000Z']) {
      assert.throws(() => normalizeHistory({ [field]: value }), error => error.code === 'INVALID_ARGUMENT'
        && error.validation.issues[0].path[0] === field);
    }
  }
  const history = new HistoryPages();
  const rows = [row(0)];
  assert.equal(history.capture(query({ startedFrom: '2026-01-01T00:00:00.001Z' }), rows).total, 0);
  assert.equal(history.capture(query({ startedBefore: '2026-01-01T00:00:00.001Z' }), rows).total, 1);
  assert.equal(query({ startedFrom: '2026-01-01T00:00:00.1Z' }).startedFrom, '2026-01-01T00:00:00.100Z');
});

test('retained high-precision timestamps keep chronological order across offsets and filter boundaries', () => {
  const history = new HistoryPages();
  const rows = [row(9, { startedAt: '2026-01-01T00:00:00.0001Z' }),
    row(1, { startedAt: '2026-01-01T01:00:00.0002+01:00' }), row(8, { startedAt: '2026-01-01T00:00:00.0000Z' })];
  const first = history.capture(query({ limit: 1 }), rows);
  assert.equal(first.tasks[0].taskId, 'task-001');
  assert.equal(next(history, first.pagination.nextRequest).tasks[0].taskId, 'task-009');
  assert.equal(history.capture(query({ startedBefore: '2026-01-01T00:00:00.001Z' }), rows).total, 3);
  assert.equal(history.capture(query({ startedBefore: '2026-01-01T00:00:00.000Z' }), rows).total, 0);
  assert.equal(history.capture(query({ startedFrom: '2026-01-01T00:00:00.000Z' }), rows).total, 3);
});

test('scope/filter/page size drift, tampering and foreign connection cursors fail clearly', () => {
  const history = new HistoryPages();
  const first = history.capture(query({ scope: 'store', limit: 1 }), [row(0), row(1)]);
  const request = first.pagination.nextRequest;
  for (const patch of [{ scope: 'connection' }, { parentLabel: 'parent-A' }, { limit: 2 }, { statuses: ['completed'] }]) {
    assert.throws(() => next(history, { ...request, ...patch }), { code: 'HISTORY_CURSOR_MISMATCH' });
  }
  const cursor = request.cursor;
  const bad = cursor.slice(0, -1) + (cursor.endsWith('A') ? 'B' : 'A');
  assert.throws(() => next(history, { ...request, cursor: bad }), { code: 'HISTORY_CURSOR_INVALID' });
  assert.throws(() => next(new HistoryPages(), request), { code: 'HISTORY_CURSOR_UNAVAILABLE' });
});

test('snapshot expiry, eviction and memory limits never silently restart pagination', () => {
  let now = 1000;
  const history = new HistoryPages({ now: () => now, ttlMs: 10, maxSnapshots: 1, maxBytes: 10000 });
  const rows = [row(1), row(2)];
  const first = history.capture(query({ limit: 1 }), rows);
  now += 10;
  assert.throws(() => next(history, first.pagination.nextRequest), { code: 'HISTORY_CURSOR_UNAVAILABLE' });
  const second = history.capture(query({ limit: 1 }), rows);
  const third = history.capture(query({ limit: 1 }), rows);
  assert.throws(() => next(history, second.pagination.nextRequest), { code: 'HISTORY_CURSOR_UNAVAILABLE' });
  assert.equal(next(history, third.pagination.nextRequest).tasks.length, 1);
  assert.throws(() => new HistoryPages({ maxBytes: 10 }).capture(query(), rows), { code: 'HISTORY_SNAPSHOT_TOO_LARGE' });
  history.clear();
  assert.equal(history.bytes, 0);
  assert.throws(() => next(history, third.pagination.nextRequest), { code: 'HISTORY_CURSOR_UNAVAILABLE' });
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-history-'));
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  const dataDir = join(root, 'state');
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, workspace, dataDir };
}

test('real store pages over50 legacy records without refreshing or modifying evidence on later pages', async t => {
  const f = await fixture(t);
  const records = [];
  for (let i = 0; i < 61; i++) {
    const record = { schemaVersion: 1, taskId: randomUUID(), sessionId: `bridge-${randomUUID()}`, workspace: f.workspace,
      access: 'read-only', parentLabel: 'legacy', attempts: [{ number: 1, requestId: `legacy-${i}`, fingerprint: 'a'.repeat(64),
        startedAt: row(i).startedAt, status: 'completed', cleanup: 'confirmed' }] };
    const directory = join(f.dataDir, 'tasks', record.taskId); await mkdir(directory, { recursive: true });
    const path = join(directory, 'task.json'); await writeFile(path, JSON.stringify(record));
    records.push({ record, path });
  }
  const manager = await new TaskManager({ dataDir: f.dataDir, runner: () => assert.fail('No runner') }).open();
  t.after(() => manager.close());
  const originalPaths = (await readdir(f.dataDir, { recursive: true })).sort();
  const originals = await Promise.all(records.map(({ path }) => readFile(path, 'utf8')));
  assert.equal((await manager.list()).total, 0, 'connection scope does not claim legacy ownership');
  const first = await manager.list({ scope: 'store' });
  assert.equal(first.total, 61); assert.equal(first.tasks.length, 50);
  assert.equal(first.tasks.every(x => x.readOnly === true && x.controlToken === undefined), true);
  const refresh = manager.refresh.bind(manager);
  manager.refresh = () => assert.fail('Cursor must not refresh live store');
  const final = await manager.list(first.pagination.nextRequest);
  assert.equal(final.tasks.length, 11); assert.equal(final.pagination.nextCursor, null);
  assert.equal(new Set([...first.tasks, ...final.tasks].map(x => x.taskId)).size, 61);
  assert.deepEqual(await Promise.all(records.map(({ path }) => readFile(path, 'utf8'))), originals);
  assert.deepEqual((await readdir(f.dataDir, { recursive: true })).sort(), originalPaths);
  manager.refresh = refresh;
});

test('independent connections keep owned scopes while store filtering crosses chats read-only', async t => {
  const f = await fixture(t);
  const options = { dataDir: f.dataDir, runner: async () => ({ terminal: 'completed', cleanup: 'confirmed', text: 'synthetic' }),
    resolveCapabilities: async id => ({ id, digest: 'offline', access: 'read-only' }) };
  const a = await new TaskManager(options).open(); const b = await new TaskManager(options).open();
  t.after(async () => { await a.close(); await b.close(); });
  for (const [manager, label] of [[a, 'A'], [b, 'B']]) {
    const receipt = await manager.submit({ requestId: label, parentLabel: label, workspace: f.workspace,
      prompt: 'Synthetic fixture.', executionMode: 'single-request' });
    await manager.wait({ taskId: receipt.taskId });
  }
  const before = await readFile(join(f.dataDir, 'registry.json'), 'utf8');
  assert.deepEqual((await a.list()).tasks.map(x => x.parentLabel), ['A']);
  assert.deepEqual((await b.list()).tasks.map(x => x.parentLabel), ['B']);
  assert.deepEqual((await a.list({ scope: 'store', parentLabel: 'B' })).tasks.map(x => x.parentLabel), ['B']);
  const first = await a.list({ scope: 'store', limit: 1 });
  await assert.rejects(b.list(first.pagination.nextRequest), { code: 'HISTORY_CURSOR_UNAVAILABLE' });
  assert.equal(await readFile(join(f.dataDir, 'registry.json'), 'utf8'), before);
});

test('malformed filters and foreign cursors reject before public manager initialization', async t => {
  const f = await fixture(t); await mkdir(f.dataDir);
  await writeFile(join(f.dataDir, 'owner.lock'), 'synthetic-protected-lock');
  const manager = new ConnectionTasks({ dataDir: f.dataDir, runner: () => assert.fail('No runner') });
  const server = createServer({ manager, doctor: () => ({}), preflight: () => assert.fail('No credentials') });
  const client = new Client({ name: 'history-schema', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair(); await server.connect(right); await client.connect(left);
  t.after(async () => { await client.close(); await server.close(); await manager.close(); });
  for (const input of [{ statuses: ['completed', 'completed'] }, { cursor: 'private-marker' }, { limit: 51 },
    { startedFrom: '2026-01-01T00:00:00.0001Z' }, { startedBefore: '2026-01-01T00:00:00.0001Z' },
    { startedFrom: 'private-date-marker' }, { startedFrom: '2026-01-02T00:00:00Z', startedBefore: '2026-01-01T00:00:00Z' }]) {
    const response = await client.callTool({ name: 'dsh_list', arguments: input });
    assert.equal(response.structuredContent.error.code, 'INVALID_ARGUMENT');
    assert.equal(JSON.stringify(response).includes('private-'), false);
  }
  const other = new HistoryPages();
  const page = other.capture(query({ limit: 1 }), [row(0), row(1)]);
  const response = await client.callTool({ name: 'dsh_list', arguments: page.pagination.nextRequest });
  assert.equal(response.structuredContent.error.code, 'HISTORY_CURSOR_UNAVAILABLE');
  assert.equal(manager.manager, null);
  assert.equal(await readFile(join(f.dataDir, 'owner.lock'), 'utf8'), 'synthetic-protected-lock');
});
