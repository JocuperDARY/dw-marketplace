import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { workerEnvironment } from '../src/sdk-runner.js';
import { preparePayload, payloadDigest } from '../src/payload.js';
import { recordRejection } from '../src/rejection-evidence.js';
import { normalizeSubmission } from '../src/submission-plan.js';
import { ConnectionTasks } from '../src/connection-tasks.js';
import { createServer } from '../src/server.js';

const objective = { text: 'Verify the supplied synthetic rule.', classification: 'synthetic' };
const segment = (id, classification = 'general', role = 'fact', text = 'Supplied fact.') => ({ id, classification, role, text });
const rejection = { requestId: 'rejected-fixture', payloadSha256: 'a'.repeat(64), taskId: null, reason: 'host-approval-rejected' };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-payload-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, dataDir: join(root, 'state') };
}

test('default preparation omits internal bodies and preserves authority versus assertion roles', () => {
  const result = preparePayload({ objective, segments: [segment('rule', 'general', 'authority', 'x must be positive'),
    segment('claim', 'synthetic', 'assertion', 'x must be even'), segment('private', 'internal', 'fact', 'private-value-marker')] });
  assert.equal(JSON.stringify(result).includes('private-value-marker'), false);
  assert.deepEqual(result.manifest.includedCounts, { general: 1, synthetic: 2, internal: 0 });
  assert.equal(result.manifest.excluded[0].id, 'private');
  assert.match(result.submission.prompt, /asserted or newly added/);
  assert.match(result.submission.prompt, /locator alone does not establish entailment/);
  assert.match(result.submission.prompt, /"role":"assertion"/);
  assert.match(result.submission.prompt, /"role":"authority"/);
  assert.equal(result.submission.payloadSha256, payloadDigest(result.submission.prompt));
  assert.equal(result.authorization, 'not_assessed');
  assert.equal(result.manifest.identityScope, 'user-prompt-only');
});

test('explicit selection can include internal data but never becomes authorization', () => {
  assert.throws(() => preparePayload({ objective: { ...objective, classification: 'internal' } }), error => error.validation.issues[0].code === 'objective_required');
  const result = preparePayload({ objective: { ...objective, classification: 'internal' },
    segments: [segment('omit'), segment('include', 'internal')], includeIds: ['objective', 'include'] });
  assert.equal(result.manifest.includedCounts.internal, 2);
  assert.deepEqual(result.manifest.excluded.map(x => x.id), ['omit']);
  assert.equal(result.authorization, 'not_assessed');
  assert.equal(result.warnings.some(x => /authorization/.test(x)), true);
});

test('duplicate IDs, unknown selection, missing labels and byte overflows fail without echoing data', () => {
  for (const input of [{ objective, segments: [segment('objective')] }, { objective, segments: [segment('x'), segment('x')] },
    { objective, includeIds: ['objective', 'unknown'] }, { objective, includeIds: ['objective', 'objective'] },
    { objective: { text: 'private-marker' } }, { objective: { ...objective, text: '界'.repeat(23000) } }]) {
    assert.throws(() => preparePayload(input), error => error.code === 'INVALID_ARGUMENT' && !JSON.stringify(error).includes('private-marker'));
  }
  assert.throws(() => preparePayload({ objective: { ...objective, text: 'x'.repeat(65200) } }), error => error.validation.issues[0].code === 'payload_size_limit');
});

test('digest detects whitespace drift and leaves single-request no-retry semantics intact', () => {
  const prepared = preparePayload({ objective }).submission;
  const input = { ...prepared, requestId: 'identity-fixture', executionMode: 'single-request' };
  const normalized = normalizeSubmission(input);
  assert.equal(normalized.planned.maxModelRequests, 1);
  assert.equal(normalized.planned.maxToolCalls, 0);
  assert.throws(() => normalizeSubmission({ ...input, prompt: `${input.prompt}\n` }), error => error.validation.issues[0].code === 'payload_identity_mismatch');
});

test('rejection metadata is immutable, concurrent duplicates converge and task state is untouched', async t => {
  const f = await fixture(t);
  await mkdir(f.dataDir);
  await writeFile(join(f.dataDir, 'owner.lock'), 'synthetic-protected-lock');
  const options = { dataDir: f.dataDir };
  const results = await Promise.all(Array.from({ length: 8 }, () => recordRejection(rejection, options)));
  assert.equal(results.filter(x => !x.duplicate).length, 1);
  assert.equal(new Set(results.map(x => x.reportedAt)).size, 1);
  assert.equal(results.every(x => x.taskId === null && x.modelUsage === null && !x.usageIncluded && !x.generationQualityIncluded), true);
  const directory = join(f.dataDir, 'rejections-v1');
  const names = await readdir(directory);
  assert.equal(names.length, 1);
  const original = await readFile(join(directory, names[0]), 'utf8');
  await assert.rejects(recordRejection({ ...rejection, payloadSha256: 'b'.repeat(64) }, options), { code: 'REJECTION_CONFLICT' });
  assert.equal(await readFile(join(directory, names[0]), 'utf8'), original);
  assert.equal(await readFile(join(f.dataDir, 'owner.lock'), 'utf8'), 'synthetic-protected-lock');
  assert.deepEqual((await readdir(f.dataDir)).sort(), ['owner.lock', 'rejections-v1']);
});

test('malformed rejection never creates state; corrupted stored evidence fails closed', async t => {
  const f = await fixture(t);
  await assert.rejects(recordRejection({ ...rejection, taskId: 'receipt-exists' }, f), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(access(f.dataDir), { code: 'ENOENT' });
  const receipt = await recordRejection(rejection, f);
  await writeFile(join(f.dataDir, 'rejections-v1', `${receipt.reportId}.json`), JSON.stringify({ private: 'private-marker' }));
  await assert.rejects(recordRejection(rejection, f), error => error.code === 'INVALID_REJECTION_RECORD' && !error.message.includes('private-marker'));
});

test('MCP preparation and rejected identity avoid TaskManager and credentials even beside a bad lock', async t => {
  const f = await fixture(t);
  await mkdir(f.dataDir);
  await writeFile(join(f.dataDir, 'owner.lock'), 'synthetic-bad-lock');
  const manager = new ConnectionTasks({ dataDir: f.dataDir, runner: () => assert.fail('No worker') });
  const client = new Client({ name: 'payload-test', version: '1' });
  const server = createServer({ manager, doctor: () => ({}), preflight: () => assert.fail('No credentials') });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(right); await client.connect(left);
  t.after(async () => { await client.close(); await server.close(); await manager.close(); });
  const tools = (await client.listTools()).tools;
  assert.equal(tools.find(x => x.name === 'dsh_prepare_payload').annotations.readOnlyHint, true);
  assert.equal(tools.find(x => x.name === 'dsh_record_rejection').annotations.openWorldHint, false);
  const prepared = (await client.callTool({ name: 'dsh_prepare_payload', arguments: { objective } })).structuredContent;
  for (const name of ['dsh_plan', 'dsh_submit']) {
    const result = await client.callTool({ name, arguments: { ...prepared.submission, prompt: 'private-drift-marker', requestId: 'digest', workspace: f.root } });
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent.error.validation.issues[0].path, ['payloadSha256']);
    assert.equal(result.structuredContent.error.validation.issues[0].code, 'payload_identity_mismatch');
    assert.equal(JSON.stringify(result).includes('private-drift-marker'), false);
  }
  const result = await client.callTool({ name: 'dsh_record_rejection', arguments: rejection });
  assert.equal(result.structuredContent.admission, 'reported-not-admitted');
  assert.equal(manager.manager, null);
  assert.equal(await readFile(join(f.dataDir, 'owner.lock'), 'utf8'), 'synthetic-bad-lock');
});

test('parent-reported rejections are absent from task history and usage', async t => {
  const f = await fixture(t);
  await recordRejection(rejection, f);
  const manager = new ConnectionTasks({ dataDir: f.dataDir, runner: () => assert.fail('No worker') });
  t.after(() => manager.close());
  const list = await manager.list({ scope: 'store' });
  assert.equal(list.total, 0);
  const usage = await manager.usage({ scope: 'store' });
  assert.equal(usage.tasks, 0);
});

test('standalone stdio prepares and records without API key or task-store initialization', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await mkdir(f.dataDir);
  await writeFile(join(f.dataDir, 'owner.lock'), 'synthetic-protected-lock');
  const env = workerEnvironment();
  delete env.DEEPSEEK_API_KEY;
  env.DSH_BRIDGE_DATA_DIR = f.dataDir;
  env.DSH_BRIDGE_CONFIG_DIR = join(f.root, 'empty-config');
  env.NODE_OPTIONS = `--import=${new URL('./fixtures/offline-network.js', import.meta.url).href}`;
  const client = new Client({ name: 'payload-stdio', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../index.js', import.meta.url))], env, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  t.after(async () => { await client.close(); await transport.close(); });
  await client.connect(transport);
  const prepared = await client.callTool({ name: 'dsh_prepare_payload', arguments: { objective } });
  assert.equal(prepared.structuredContent.validation.modelCalls, 0);
  const saved = await client.callTool({ name: 'dsh_record_rejection', arguments: { ...rejection,
    payloadSha256: prepared.structuredContent.submission.payloadSha256 } });
  assert.equal(saved.structuredContent.modelUsage, null);
  assert.equal(saved.structuredContent.validation.workerStarts, 0);
  assert.deepEqual((await readdir(f.dataDir)).sort(), ['owner.lock', 'rejections-v1']);
  assert.equal(await readFile(join(f.dataDir, 'owner.lock'), 'utf8'), 'synthetic-protected-lock');
});
