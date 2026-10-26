import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { TaskManager } from '../src/tasks.js';
import { ConnectionTasks } from '../src/connection-tasks.js';
import { createServer } from '../src/server.js';
import { snapshotPath } from './fixtures/committed-state.js';

const checks = [{ id: 'fact', kind: 'literal', pointer: '/value', expected: 4 }];
async function fixture(t, invalidStore = false) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-check-api-'));
  const workspace = join(root, 'workspace');
  const dataDir = join(root, 'state');
  await mkdir(workspace);
  let launches = 0;
  const options = { dataDir, resolveCapabilities: async id => ({ id, digest: 'offline', access: 'read-only' }),
    runner: async () => { launches++; return { terminal: 'completed', text: '{"value":4}', cleanup: 'confirmed' }; } };
  const manager = invalidStore ? new ConnectionTasks(options) : await new TaskManager(options).open();
  let task;
  if (invalidStore) { await mkdir(dataDir); await writeFile(join(dataDir, 'owner.lock'), 'synthetic-invalid-lock'); }
  else {
    task = await manager.submit({ workspace, prompt: 'Synthetic fixture.', requestId: 'checker-fixture', executionMode: 'single-request' });
    await manager.wait({ taskId: task.taskId });
  }
  const client = new Client({ name: 'parent-check-test', version: '1' });
  const server = createServer({ manager, doctor: () => ({ modelCalls: 0 }) });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(right); await client.connect(left);
  t.after(async () => { await client.close(); await server.close(); await manager.close(); await rm(root, { recursive: true, force: true }); });
  return { root, workspace, dataDir, manager, task, client, launches: () => launches };
}

test('public checker rejects invalid contracts before task observation and never exposes values', async t => {
  const f = await fixture(t, true);
  const tool = (await f.client.listTools()).tools.find(x => x.name === 'dsh_check_result');
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.openWorldHint, false);
  for (const invalid of [[checks[0], checks[0]], [{ ...checks[0], pointer: 'private-marker' }], []]) {
    const result = await f.client.callTool({ name: tool.name, arguments: { taskId: 'b30d32e6-3a8f-448a-b8d3-09aba533e02d', attempt: 1, checks: invalid } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'INVALID_ARGUMENT');
    assert.equal(JSON.stringify(result).includes('private-marker'), false);
  }
  assert.equal(f.manager.manager, null);
  assert.equal(f.launches(), 0);
  assert.equal(await readFile(join(f.dataDir, 'owner.lock'), 'utf8'), 'synthetic-invalid-lock');
});

test('public checker and CLI inspect a pinned saved result without changing state or launching workers', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const path = await snapshotPath(f.dataDir, f.task.taskId);
  const before = await readFile(path, 'utf8');
  const registry = await readFile(join(f.dataDir, 'registry.json'), 'utf8');
  const input = { taskId: f.task.taskId, attempt: 1, checks };
  const result = (await f.client.callTool({ name: 'dsh_check_result', arguments: input })).structuredContent;
  assert.equal(result.status, 'checks_passed');
  assert.equal(result.parentAcceptance, 'not_assessed');
  const checkFile = join(f.root, 'checks.json');
  await writeFile(checkFile, JSON.stringify(checks));
  const run = () => promisify(execFile)(process.execPath,
    [fileURLToPath(new URL('../scripts/check-result.js', import.meta.url)), f.task.taskId, '1', checkFile],
    { env: { ...process.env, DEEPSEEK_API_KEY: '', DSH_BRIDGE_DATA_DIR: f.dataDir, DSH_BRIDGE_CONFIG_DIR: join(f.root, 'empty-config'),
      NODE_OPTIONS: `--import=${new URL('./fixtures/offline-network.js', import.meta.url).href}` }, timeout: 25000, windowsHide: true });
  const { stdout, stderr } = await run();
  assert.equal(stderr, '');
  assert.equal(JSON.parse(stdout).status, 'checks_passed');
  await writeFile(checkFile, JSON.stringify([{ ...checks[0], expected: 5 }]));
  await assert.rejects(run(), error => { assert.equal(error.code, 1); assert.equal(JSON.parse(error.stdout).status, 'checks_failed'); return true; });
  assert.equal(await readFile(path, 'utf8'), before);
  assert.equal(await readFile(join(f.dataDir, 'registry.json'), 'utf8'), registry);
  assert.equal(f.launches(), 1, 'only the explicit synthetic fixture runner started');
});
