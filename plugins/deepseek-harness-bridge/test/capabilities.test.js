import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client';
import { execFileSync, spawnSync } from 'node:child_process';
import { installedInventory, resolveProfile, capabilities } from '../src/capabilities.js';
import { createSdkRunner, prepareRuntime, confirmCapabilities, workerEnvironment, ROUTE } from '../src/sdk-runner.js';

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
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));
  const allowed = [packageRoot, join(profile, 'package.json'), join(module, 'package.json'),
    join(profile, 'node_modules', 'missing-plugin', 'package.json'), join(root, 'profiles', 'web', 'package.json')];
  const script = `import { installedInventory } from ${JSON.stringify(new URL('../src/capabilities.js', import.meta.url).href)}; console.log(JSON.stringify(await installedInventory(${JSON.stringify({ inventoryHome: root })})));`;
  // Node's permission boundary rejects even discarded reads of the credential fixture.
  const result = JSON.parse(execFileSync(process.execPath, ['--permission', ...allowed.map(path => `--allow-fs-read=${path}`), '--input-type=module', '-e', script], { encoding: 'utf8' }));
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
  assert.equal((await capabilities(config)).capabilityProfiles.length, 4);
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
  let readyAtPrompt = false;
  let prompts = 0;
  const home = join(root, 'home');
  const runner = createSdkRunner({ resolveCapabilities: async () => profile, env: { ...workerEnvironment(), DEEPSEEK_API_KEY: 'offline-not-a-real-key' },
    clientFactory(options) {
      const client = new HarnessClient(options);
      client.prompt = async () => {
        prompts++;
        readyAtPrompt = JSON.stringify(JSON.parse(await readFile(join(home, 'worker-capabilities.json'), 'utf8')).tools) === '["sample_echo"]';
        throw new Error('Offline recording client: stop before inference.');
      };
      return client;
    },
  });
  const result = await runner({ task, home, prompt: 'offline only', resume: false, signal: new AbortController().signal });
  assert.equal(prompts, 1);
  assert.equal(readyAtPrompt, true);
  assert.equal(result.budget.modelRequests, 0);
  assert.equal(result.cleanup, 'confirmed');
});

test('duplicate and built-in capability IDs are rejected', async () => {
  for (const capabilityProfiles of [[{ id: 'files' }], [{ id: 'same' }, { id: 'same' }]]) {
    await assert.rejects(resolveProfile('files', { capabilityProfiles }), { code: 'INVALID_PROFILE' });
  }
});

test('worker load hook rejects an entry replaced after profile resolution', async t => {
  const root = await fixture(t);
  const modulePath = join(root, 'entry.mjs');
  await writeFile(modulePath, 'export const apply = () => {};');
  const profile = await resolveProfile('pinned', { capabilityProfiles: [{ id: 'pinned', access: 'read-only', fileTools: false,
    modules: [{ path: modulePath, sha256: sha256(await readFile(modulePath)), tools: [] }] }] });
  const prepared = await prepareRuntime({ task: { taskId: 'pin', workspace: root, route: { ...ROUTE, effort: 'high' }, access: 'read-only', maxTokens: 512,
    maxToolCalls: 0, maxModelRequests: 1, maxRequestBytes: 8192, capabilityProfile: 'pinned', capabilityDigest: profile.digest, attempts: [{ number: 1, timeoutMs: 1000 }] },
    home: join(root, 'home'), resolveCapabilities: async () => profile, env: workerEnvironment() });
  await writeFile(modulePath, 'throw new Error("UNREVIEWED_ENTRY_EXECUTED");');
  const child = spawnSync(process.execPath, [modulePath], { env: prepared.options.env, encoding: 'utf8' });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /Pinned module source changed/);
  assert.doesNotMatch(child.stderr, /Error: UNREVIEWED_ENTRY_EXECUTED/);
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
