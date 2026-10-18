import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client';
import { installedInventory, resolveProfile, capabilities } from '../src/capabilities.js';
import { prepareRuntime, confirmCapabilities, workerEnvironment, ROUTE } from '../src/sdk-runner.js';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-capabilities-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('inventory reads installed package metadata without executing its code or credential files', async t => {
  const root = await fixture(t);
  const profile = join(root, 'profiles', 'desktop');
  const module = join(profile, 'node_modules', 'dsh-ops');
  await mkdir(module, { recursive: true });
  await writeFile(join(root, '.credentials.yaml'), 'unread credential sentinel');
  await writeFile(join(profile, 'package.json'), JSON.stringify({ dependencies: { 'dsh-ops': '^0.2.9', 'missing-plugin': '1' }, dsh: { profile: { bundles: ['dsh-ops'] } } }));
  await writeFile(join(module, 'package.json'), JSON.stringify({ name: 'dsh-ops', version: '0.2.9', main: 'index.js' }));
  await writeFile(join(module, 'index.js'), 'throw new Error("must never import during inventory")');
  const result = await installedInventory({ inventoryHome: root });
  const [installed, missing] = result.profiles[0].packages;
  assert.equal(installed.version, '0.2.9');
  assert.equal(installed.declaredBundle, true);
  assert.equal(installed.workerLoaded, false);
  assert.equal(installed.activation, 'not_verified');
  assert.equal(missing.installed, false);
  assert.equal(JSON.stringify(result).includes('sentinel'), false);
});

test('selected skill content is bounded and pinned; changed files require review', async t => {
  const root = await fixture(t);
  const path = join(root, 'SKILL.md');
  const content = '---\nname: scoped-check\n---\nCheck the assigned file only.';
  await writeFile(path, content);
  const config = { inventoryHome: root, capabilityProfiles: [{ id: 'docs', access: 'read-only', skills: [{ path, sha256: sha256(content) }] }] };
  const profile = await resolveProfile('docs', config);
  assert.equal(profile.skills[0].text, content);
  assert.equal((await capabilities(config)).capabilityProfiles.length, 3);
  await writeFile(path, 'changed');
  await assert.rejects(resolveProfile('docs', config), { code: 'CAPABILITY_CHANGED' });
  await assert.rejects(resolveProfile('unknown', config), { code: 'INVALID_PROFILE' });
});

test('an asynchronously initialized module reaches the exact capability set before prompting, with zero model calls', { timeout: 45000 }, async t => {
  const root = await fixture(t);
  const modulePath = fileURLToPath(new URL('./fixtures/extra-tools.js', import.meta.url));
  const profile = await resolveProfile('echo', { capabilityProfiles: [{ id: 'echo', access: 'read-only', fileTools: false,
    modules: [{ path: modulePath, sha256: sha256(await readFile(modulePath)), tools: ['sample_echo'], config: { delayMs: 1000 } }] }] });
  const task = { taskId: 'capability-test', workspace: root, route: { ...ROUTE, effort: 'high' }, access: 'read-only', maxTokens: 512,
    maxToolCalls: 1, maxModelRequests: 1, maxRequestBytes: 8192, capabilityProfile: 'echo', capabilityDigest: profile.digest,
    attempts: [{ number: 1, timeoutMs: 30000 }] };
  const prepared = await prepareRuntime({ task, home: join(root, 'home'), resolveCapabilities: async () => profile,
    env: { ...workerEnvironment(), DEEPSEEK_API_KEY: 'offline-not-a-real-key' } });
  const client = new HarnessClient(prepared.options);
  try {
    await client.initialize({ cwd: root, ...ROUTE, reasoningEffort: 'high', maxTokens: 512 });
    await confirmCapabilities(prepared, new AbortController().signal);
    assert.deepEqual(JSON.parse(await readFile(prepared.receiptPath, 'utf8')).tools, ['sample_echo']);
    assert.equal(JSON.parse(await readFile(prepared.budgetPath, 'utf8')).modelRequests, 0);
  } finally { await client.close(); }
});

test('unexpected and missing tools cannot pass the readiness gate', async t => {
  const root = await fixture(t);
  const receiptPath = join(root, 'receipt.json');
  const prepared = { receiptPath, nonce: 'current', expectedTools: ['expected'] };
  await writeFile(receiptPath, JSON.stringify({ nonce: 'current', tools: ['unexpected'] }));
  await assert.rejects(confirmCapabilities(prepared, new AbortController().signal, 100), { code: 'CAPABILITY_MISMATCH' });
  await writeFile(receiptPath, JSON.stringify({ nonce: 'current', tools: [] }));
  await assert.rejects(confirmCapabilities(prepared, new AbortController().signal, 100), { code: 'CAPABILITY_MISMATCH' });
});
