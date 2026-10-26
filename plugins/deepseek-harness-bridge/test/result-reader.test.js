import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { TaskManager } from '../src/tasks.js';
import { createServer } from '../src/server.js';
import { readCompleteResult, ResultReadError } from '../src/result-reader.js';
import { snapshotPath } from './fixtures/committed-state.js';

const taskId = randomUUID();
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
function source(text, mutate = page => page) {
  const calls = [];
  const call = async request => {
    calls.push(structuredClone(request));
    assert.equal(request.name, 'dsh_result');
    const { offset, limit } = request.arguments;
    return mutate({ taskId, sessionId: 'session-fixture', number: 3, requestId: 'fixture-3', status: 'completed',
      resultAvailable: true, output: { kind: 'complete_text', modelTruncated: false, storageTruncated: false },
      outputTruncated: false, text: text.slice(offset, offset + limit), offset,
      nextOffset: offset + limit < text.length ? offset + limit : null,
      resultPage: { unit: 'utf16-code-units', totalCharacters: text.length, sha256: sha256(text) } }, calls.length);
  };
  return { call, calls };
}

test('default reader reassembles before JSON parsing, pins returned attempt, and crosses UTF-16 surrogate boundaries', async () => {
  const object = { value: `${'a'.repeat(15989)}😀${'界'.repeat(25000)}`, path: 'C:\\one\\two.json' };
  const text = JSON.stringify(object);
  assert.equal(text.charCodeAt(15999), 0xd83d);
  const f = source(text);
  const result = await readCompleteResult(f.call, { taskId, parseJson: true });
  assert.equal(result.text, text);
  assert.deepEqual(result.json, object);
  assert.deepEqual(result.truncation, { model: false, storage: false });
  assert.equal(result.retrieval.pages, 3);
  assert.equal(result.retrieval.characters, text.length);
  assert.deepEqual(f.calls.map(call => call.arguments), [
    { taskId, offset: 0, limit: 16000 }, { taskId, attempt: 3, offset: 16000, limit: 16000 },
    { taskId, attempt: 3, offset: 32000, limit: 16000 },
  ]);
});

test('empty saved text and an exact page boundary terminate without a redundant call', async () => {
  for (const text of ['', 'a'.repeat(32000)]) {
    const f = source(text);
    const result = await readCompleteResult(f.call, { taskId, attempt: 3, limit: 32000 });
    assert.equal(result.text, text);
    assert.equal(f.calls.length, 1);
    assert.equal(result.receipt.nextOffset, null);
  }
});

test('MCP structured responses and text-only page envelopes are both supported', async () => {
  for (const structured of [false, true]) {
    const f = source('{"ok":true}', page => ({ content: [{ type: 'text', text: JSON.stringify(page) }],
      ...(structured ? { structuredContent: page } : {}) }));
    assert.deepEqual((await readCompleteResult(f.call, { taskId, parseJson: true })).json, { ok: true });
  }
});

for (const [label, options] of [
  ['50000 limit', { limit: 50000 }], ['zero limit', { limit: 0 }], ['fractional limit', { limit: 1.5 }],
  ['bad attempt', { attempt: 0 }], ['bad UUID', { taskId: 'not-a-uuid' }], ['nonboolean parseJson', { parseJson: 'true' }],
]) test(`invalid reader input: ${label} makes no call`, async () => {
  await assert.rejects(readCompleteResult(() => assert.fail('must not call'), { taskId, ...options }),
    { code: 'INVALID_ARGUMENT', category: 'input' });
});

const badPages = [
  ['wrong offset', page => ({ ...page, offset: 1 })],
  ['overlapping nextOffset', page => ({ ...page, nextOffset: page.nextOffset - 1 })],
  ['skipped nextOffset', page => ({ ...page, nextOffset: page.nextOffset + 1 })],
  ['early end', page => ({ ...page, nextOffset: null })],
  ['empty nonterminal page', page => ({ ...page, text: '', nextOffset: 0 })],
  ['oversized text', page => ({ ...page, text: page.text + 'x' })],
  ['wrong task', page => ({ ...page, taskId: randomUUID() })],
  ['wrong explicit attempt', page => ({ ...page, number: 4 })],
  ['nonterminal task', page => ({ ...page, status: 'running' })],
  ['unknown task status', page => ({ ...page, status: 'unrecognized' })],
  ['no metadata', page => ({ ...page, resultPage: undefined })],
  ['bad total', page => ({ ...page, resultPage: { ...page.resultPage, totalCharacters: 1048577 } })],
  ['bad unit', page => ({ ...page, resultPage: { ...page.resultPage, unit: 'utf8-bytes' } })],
];
for (const [label, mutate] of badPages) test(`malformed page: ${label} stops without retry`, async () => {
  const f = source('abcdef', mutate);
  await assert.rejects(readCompleteResult(f.call, { taskId, attempt: 3, limit: 2 }), error => {
    assert.equal(error.code, 'INVALID_PAGE');
    assert.equal(error.category, 'read');
    assert.equal(error.partial.complete, false);
    return true;
  });
  assert.equal(f.calls.length, 1);
});

for (const field of ['sessionId', 'requestId', 'status', 'digest', 'total', 'truncation']) {
  test(`mid-read ${field} change rejects the snapshot and retains only validated pages`, async () => {
    const f = source('abcdef', (page, call) => {
      if (call === 1) return page;
      if (field === 'digest') page.resultPage.sha256 = 'f'.repeat(64);
      else if (field === 'total') page.resultPage.totalCharacters++;
      else if (field === 'truncation') page.output.modelTruncated = true;
      else page[field] = field === 'status' ? 'failed' : 'changed';
      return page;
    });
    await assert.rejects(readCompleteResult(f.call, { taskId, limit: 2 }), error => {
      assert.equal(error.code, 'RESULT_CHANGED');
      assert.equal(error.partial.text, 'ab');
      assert.equal(error.partial.pages, 1);
      return true;
    });
    assert.equal(f.calls.length, 2);
  });
}

test('same-length corrupted page fails the final assembled digest', async () => {
  const f = source('abcdef', page => ({ ...page, text: page.text.replace('c', 'x') }));
  await assert.rejects(readCompleteResult(f.call, { taskId, limit: 2 }), { code: 'RESULT_DIGEST_MISMATCH', category: 'read' });
  assert.equal(f.calls.length, 3);
});

test('transport, MCP tool error, unavailable result, and invalid envelope remain read errors', async () => {
  for (const [response, expected] of [
    [() => { throw new Error('private transport details'); }, 'RESULT_READ_FAILED'],
    [() => ({ isError: true, structuredContent: { error: { code: 'NOT_FINISHED' } } }), 'RESULT_READ_FAILED'],
    [() => ({ resultAvailable: false }), 'RESULT_UNAVAILABLE'],
    [() => ({ content: [{ type: 'text', text: 'broken envelope' }] }), 'INVALID_PAGE'],
    [() => ({ content: [] }), 'INVALID_PAGE'], [() => null, 'INVALID_PAGE'],
  ]) {
    let calls = 0;
    await assert.rejects(readCompleteResult(() => { calls++; return response(); }, { taskId }), error => {
      assert.ok(error instanceof ResultReadError);
      assert.equal(error.code, expected);
      assert.equal(error.category, 'read');
      assert.equal(error.partial.text, '');
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('content errors retain complete saved evidence and distinguish provider and storage truncation', async () => {
  for (const kind of ['model', 'storage', 'invalid', 'root']) {
    const text = kind === 'invalid' ? '{"broken":' : kind === 'root' ? '[]' : '{"ok":true}';
    const f = source(text, page => {
      page.output.modelTruncated = kind === 'model';
      page.output.storageTruncated = kind === 'storage';
      page.outputTruncated = kind === 'storage';
      return page;
    });
    await assert.rejects(readCompleteResult(f.call, { taskId, limit: 2, parseJson: true }), error => {
      assert.equal(error.code, kind === 'invalid' ? 'INVALID_JSON' : kind === 'root' ? 'INVALID_JSON_OBJECT' : 'RESULT_TRUNCATED');
      assert.equal(error.category, 'content');
      assert.equal(error.result.text, text);
      assert.equal(error.result.retrieval.complete, true);
      assert.equal(error.result.truncation.model, kind === 'model');
      assert.equal(error.result.truncation.storage, kind === 'storage');
      return true;
    });
    assert.equal(f.calls.length, Math.ceil(text.length / 2));
  }
});

test('missing historical truncation evidence remains unknown after complete retrieval', async () => {
  const f = source('{"ok":true}', page => {
    delete page.output;
    delete page.outputTruncated;
    return page;
  });
  const result = await readCompleteResult(f.call, { taskId, parseJson: true });
  assert.deepEqual(result.truncation, { model: null, storage: null });
  assert.deepEqual(result.json, { ok: true });
});

async function apiFixture(t, text, output = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-result-reader-'));
  const workspace = join(root, 'workspace');
  const dataDir = join(root, 'state');
  await mkdir(workspace);
  let launches = 0;
  const manager = await new TaskManager({ dataDir, resolveCapabilities: async id => ({ id, digest: 'offline', access: 'read-only' }),
    runner: async () => { launches++; return { terminal: 'completed', text, cleanup: 'confirmed', ...output }; } }).open();
  const task = await manager.submit({ requestId: 'saved-fixture', executionMode: 'single-request', workspace, prompt: 'Offline fixture only.' });
  await manager.wait({ taskId: task.taskId });
  const server = createServer({ manager, doctor: () => ({ modelCalls: 0 }) });
  const client = new Client({ name: 'reader-fixture', version: '1' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  t.after(async () => { await client.close(); await server.close(); await manager.close(); await rm(root, { recursive: true, force: true }); });
  return { root, dataDir, manager, client, task, launches: () => launches };
}

test('real MCP schema rejects 50000 before manager.result; defaults, max, metadata, and reassembly work', async t => {
  const text = JSON.stringify({ value: '界😀'.repeat(15000) });
  const f = await apiFixture(t, text);
  const tools = (await f.client.listTools()).tools;
  assert.equal(tools.length, 21);
  const tool = tools.find(tool => tool.name === 'dsh_result');
  assert.equal(tool.inputSchema.properties.limit.maximum, 32000);
  assert.match(tool.description, /32000 UTF-16.*default 16000/);
  assert.match(tool.inputSchema.properties.limit.description, /maximum 32000, default 16000/);
  let reads = 0;
  const original = f.manager.result.bind(f.manager);
  f.manager.result = input => { reads++; return original(input); };
  const rejected = await f.client.callTool({ name: 'dsh_result', arguments: { taskId: f.task.taskId, limit: 50000 } });
  assert.equal(rejected.isError, true);
  assert.equal(rejected.structuredContent.error.code, 'INVALID_ARGUMENT');
  assert.equal(rejected.structuredContent.error.validation.phase, 'schema');
  assert.equal(reads, 0);
  const first = (await f.client.callTool({ name: 'dsh_result', arguments: { taskId: f.task.taskId } })).structuredContent;
  assert.equal(first.text.length, 16000);
  assert.equal(first.nextOffset, 16000);
  assert.deepEqual(first.resultPage, { unit: 'utf16-code-units', totalCharacters: text.length, sha256: sha256(text) });
  const max = await original({ taskId: f.task.taskId, limit: 32000 });
  assert.equal(max.text.length, 32000);
  const beyond = await original({ taskId: f.task.taskId, offset: text.length + 1 });
  assert.equal(beyond.text, '');
  assert.equal(beyond.nextOffset, null);
  const result = await readCompleteResult(request => f.client.callTool(request), { taskId: f.task.taskId, parseJson: true });
  assert.equal(result.text, text);
  assert.deepEqual(result.json, JSON.parse(text));
  assert.equal(result.retrieval.pages, 3);
  assert.equal(f.launches(), 1, 'only the explicit offline fixture runner launched; retrieval launches nothing');
});

test('real saved-file change between pages is caught without reopening or continuing a task', async t => {
  const text = '{"value":"abcdef"}';
  const f = await apiFixture(t, text);
  let calls = 0;
  await assert.rejects(readCompleteResult(async request => {
    const page = await f.client.callTool(request);
    if (++calls === 1) await writeFile(join(f.dataDir, 'tasks-v3', f.task.taskId, 'result-1.txt'), text.replace('c', 'x'));
    return page;
  }, { taskId: f.task.taskId, limit: 2 }), { code: 'RESULT_CHANGED', category: 'read' });
  assert.equal(calls, 2);
  assert.equal(f.launches(), 1);
});

test('failed runtime receipt with attempt.error is still a successfully retrieved artifact', async t => {
  const f = await apiFixture(t, '{"ok":false}', { terminal: 'error', error: { code: 'WORKER_FAILED', message: 'Offline fixture failure.' } });
  const result = await readCompleteResult(request => f.client.callTool(request), { taskId: f.task.taskId, parseJson: true });
  assert.equal(result.retrieval.complete, true);
  assert.equal(result.receipt.status, 'failed');
  assert.equal(result.receipt.error.code, 'WORKER_FAILED');
  assert.deepEqual(result.json, { ok: false });
  assert.equal(f.launches(), 1);
});

for (const kind of ['model', 'storage']) test(`real ${kind} clipping is content evidence even with attempt.error`, async t => {
  const f = await apiFixture(t, kind === 'storage' ? 'a'.repeat(1048577) : '{"partial":',
    { terminal: kind === 'model' ? 'max-tokens' : 'completed',
      output: { kind: kind === 'model' ? 'partial_text' : 'complete_text', modelTruncated: kind === 'model' },
      error: { code: 'FIXTURE_OUTPUT_INCOMPLETE', message: 'Offline incomplete output.' } });
  await assert.rejects(readCompleteResult(request => f.client.callTool(request), { taskId: f.task.taskId, parseJson: true }), error => {
    assert.equal(error.category, 'content');
    assert.equal(error.code, 'RESULT_TRUNCATED');
    assert.equal(error.result.retrieval.complete, true);
    assert.equal(error.result.receipt.status, 'failed');
    assert.equal(error.result.receipt.error.code, 'FIXTURE_OUTPUT_INCOMPLETE');
    assert.equal(error.result.truncation.model, kind === 'model');
    assert.equal(error.result.truncation.storage, kind === 'storage');
    return true;
  });
  assert.equal(f.launches(), 1);
});

test('CLI reads an existing offline task over stdio, parses assembled JSON, and leaves task state unchanged', { timeout: 30000 }, async t => {
  const text = JSON.stringify({ value: '界😀'.repeat(15000) });
  const f = await apiFixture(t, text);
  const path = await snapshotPath(f.dataDir, f.task.taskId);
  const registry = await readFile(join(f.dataDir, 'registry.json'), 'utf8');
  const before = await readFile(path, 'utf8');
  const { stdout, stderr } = await promisify(execFile)(process.execPath,
    [fileURLToPath(new URL('../scripts/read-result.js', import.meta.url)), f.task.taskId, '1', '--json'],
    { env: { ...process.env, DSH_BRIDGE_DATA_DIR: f.dataDir,
      NODE_OPTIONS: `--import=${new URL('./fixtures/offline-network.js', import.meta.url).href}` }, maxBuffer: 4 * 1024 * 1024, timeout: 25000 });
  assert.equal(stderr, '');
  const result = JSON.parse(stdout);
  assert.equal(result.text, text);
  assert.deepEqual(result.json, JSON.parse(text));
  assert.equal(result.retrieval.pages, 3);
  assert.equal(await readFile(path, 'utf8'), before);
  assert.equal(await readFile(join(f.dataDir, 'registry.json'), 'utf8'), registry);
  assert.equal(f.launches(), 1);
});

test('CLI honors local config dataDir without decrypting execution credentials or leaking child stderr', { timeout: 30000 }, async t => {
  const f = await apiFixture(t, '{"configured":true}');
  const configDir = join(f.root, 'config');
  await mkdir(configDir);
  await writeFile(join(configDir, 'config.json'), JSON.stringify({ dataDir: f.dataDir, nodePath: 'ignored-for-read-only-cli' }));
  await writeFile(join(configDir, 'api-key.dpapi'), 'invalid-encrypted-execution-key-must-not-be-read');
  const preload = join(f.root, 'stderr-fixture.mjs');
  await writeFile(preload, 'import { Socket } from "node:net";\nSocket.prototype.connect = function () { throw new Error("Offline fixture forbids network"); };\nprocess.stderr.write("PRIVATE_CHILD_STDERR_MARKER\\n");\n');
  const env = { ...process.env, DSH_BRIDGE_CONFIG_DIR: configDir,
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` };
  // Both processes write the preload marker; only the outer CLI's direct stderr
  // should be observable because its bridge child is piped and drained.
  delete env.DSH_BRIDGE_DATA_DIR;
  const { stdout, stderr } = await promisify(execFile)(process.execPath,
    [fileURLToPath(new URL('../scripts/read-result.js', import.meta.url)), f.task.taskId, '--json'],
    { env, maxBuffer: 1024 * 1024, timeout: 25000 });
  assert.deepEqual(JSON.parse(stdout).json, { configured: true });
  // The parent CLI preload writes once. Its child is separately piped/drained.
  assert.equal(stderr, 'PRIVATE_CHILD_STDERR_MARKER\n');
  assert.equal(f.launches(), 1);
});
