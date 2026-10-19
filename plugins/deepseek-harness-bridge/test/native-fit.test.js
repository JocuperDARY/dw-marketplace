import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client';
import { resolveNativeProfile } from '../src/native-profile.js';
import { confirmCapabilities, prepareRuntime, ROUTE, workerEnvironment } from '../src/sdk-runner.js';
import { apply as applyBridgeFiles } from '../src/worker-tools.js';
import { WorkspaceFiles } from '../src/workspace.js';

const inventoryHome = join(homedir(), '.dsh');
const rawFileTools = ['ops_inspect_local_file', 'ops_grep', 'ops_glob', 'ops_replace'];
const readOnlyTools = ['bridge_list', 'bridge_read', 'bridge_skill_load', 'bridge_skill_search'].sort();
const teamTools = ['create', 'approve', 'edit_plan', 'add_member', 'remove_member', 'create_task', 'reassign_task',
  'claim_task', 'update_task', 'amend_task', 'send_message', 'status', 'resume', 'delete'].map(name => `agent_teams_${name}`);
const writeTools = [...readOnlyTools, 'bridge_write', 'ops_replace', 'pwsh', 'job_output', 'job_list', 'job_kill', ...teamTools].sort();
const sha = text => createHash('sha256').update(text).digest('hex');

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'native-fit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'workspace'));
  const workspace = await realpath(join(root, 'workspace'));
  await writeFile(join(workspace, 'input.txt'), 'alpha alpha');
  await writeFile(join(workspace, '.env'), 'protected fixture');
  await writeFile(join(root, 'outside.txt'), 'outside fixture');
  return { root, workspace, backupDir: join(root, 'backups') };
}

async function installedProfilePackage(name) {
  for (const profile of ['desktop', 'web']) {
    try { if ((await stat(join(inventoryHome, 'profiles', profile, 'node_modules', ...name.split('/'), 'package.json'))).isFile()) return true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return false;
}

test('DSH-FIT-001: native read-only profile never mounts raw dsh-ops file tools', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-fit-red-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'workspace'));
  const workspace = await realpath(join(root, 'workspace'));
  const profile = await resolveNativeProfile({ inventoryHome }, { workspace, access: 'read-only' });
  assert.deepEqual(profile.tools.filter(name => rawFileTools.includes(name)), [],
    'read-only native authority must expose only the bounded bridge file boundary');
  assert.equal(profile.modules.some(module => /[/\\]components[/\\]file[/\\]index\.js$/.test(module.path)), false);
});

for (const access of ['read-only', 'workspace-write']) {
  test(`DSH-FIT-001/003: files-only native ${access} needs no installed inventory or raw dsh-ops module`, async t => {
    const f = await fixture(t);
    const missingInventory = join(f.root, 'deliberately-nonexistent-inventory');
    await assert.rejects(stat(missingInventory), { code: 'ENOENT' });
    const profile = await resolveNativeProfile({ inventoryHome: missingInventory },
      { workspace: f.workspace, access, nativePlugins: ['files'] });
    assert.deepEqual(profile.native.selected, ['files']);
    assert.deepEqual(profile.tools, access === 'read-only' ? [] : ['ops_replace']);
    assert.equal(profile.fileTools, true);
    assert.equal(profile.modules.length, access === 'read-only' ? 0 : 1);
    assert.equal(profile.modules.some(module => /[/\\]dsh-ops[/\\]|[/\\]components[/\\]file[/\\]/.test(module.path)), false);
    if (access === 'workspace-write') {
      assert.match(profile.modules[0].path, /[/\\]src[/\\]native-files\.js$/);
      assert.equal(profile.modules[0].workspaceFiles, true);
    }
    await assert.rejects(stat(missingInventory), { code: 'ENOENT' });
  });
}

for (const access of ['read-only', 'workspace-write']) {
  test(`DSH-FIT-001/003: real sdk-minimal native ${access} confirms its exact tools without executing any`, { timeout: 45000 }, async t => {
    if (process.platform !== 'win32') return t.skip('Full installed native skills/shell/teams registration requires Windows.');
    for (const name of ['@michengai/dsh-skills-manager', ...(access === 'workspace-write' ? ['dsh-ops', '@nanmicoder/dsh-agent-teams'] : [])]) {
      if (!await installedProfilePackage(name)) return t.skip(`Installed native profile package ${name} is unavailable under ${inventoryHome}.`);
    }
    const f = await fixture(t);
    const home = join(f.root, 'worker-home');
    const task = { taskId: `fit-${access}`, sessionId: `fit-${access}`, workspace: f.workspace, requestedWorkspace: f.workspace,
      access, capabilityProfile: 'native', planning: { executionMode: 'single-request' }, route: { ...ROUTE, effort: 'off' },
      maxTokens: 256, maxModelRequests: 0, maxToolCalls: 0, attempts: [{ number: 1, timeoutMs: 30000 }] };
    const profile = await resolveNativeProfile({ inventoryHome }, task);
    const prepared = await prepareRuntime({ task, home, env: { ...workerEnvironment(), DEEPSEEK_API_KEY: 'native-fit-offline-fake-key' },
      resolveCapabilities: async () => profile });
    const expected = access === 'read-only' ? readOnlyTools : writeTools;
    assert.deepEqual(prepared.expectedTools, expected);
    assert.equal(profile.modules.some(module => /[/\\]components[/\\]file[/\\]index\.js$/.test(module.path)), false);
    const client = new HarnessClient({ ...prepared.options, env: { ...prepared.options.env,
      NODE_OPTIONS: `${prepared.options.env.NODE_OPTIONS ?? ''} --import=${new URL('./fixtures/offline-network.js', import.meta.url).href}` } });
    let closed = false;
    try {
      await client.initialize({ cwd: f.workspace, ...ROUTE, reasoningEffort: 'off', maxTokens: 256 });
      const tools = await confirmCapabilities(prepared, AbortSignal.timeout(30000), 30000);
      assert.deepEqual(tools, expected);
      const receipt = JSON.parse(await readFile(prepared.receiptPath, 'utf8'));
      const budget = JSON.parse(await readFile(prepared.budgetPath, 'utf8'));
      assert.equal(receipt.toolCalls, 0);
      assert.deepEqual(receipt.usedTools, []);
      assert.deepEqual(receipt.toolOutcomes, {});
      assert.equal(budget.nonce, prepared.nonce);
      assert.equal(budget.modelRequests, 0);
      assert.equal(budget.denied, null);
      t.diagnostic(JSON.stringify({ sdk: '0.2.1-rc.2', access, profile: 'sdk-minimal', tools, toolCalls: receipt.toolCalls, modelRequests: budget.modelRequests }));
    } finally { await client.close(); closed = true; }
    assert.equal(closed, true);
  });
}

async function bridgeFixture(t, access = 'read-only') {
  const f = await fixture(t);
  const tools = new Map();
  await applyBridgeFiles({ tools: { register: tool => tools.set(tool.name, tool), schemas: () => [...tools.values()] }, on() {} },
    { ...f, access, receiptPath: join(f.root, 'receipt.json'), nonce: 'native-fit-components' });
  return { ...f, tools, call: async (name, args) => JSON.parse(await tools.get(name).execute(args, {})) };
}

test('DSH-FIT-002: actual registered bridge readers use the workspace root and hide protected paths', async t => {
  const f = await bridgeFixture(t);
  assert.equal((await f.call('bridge_read', { path: 'input.txt' })).text, 'alpha alpha');
  for (const path of [join(f.root, 'outside.txt'), '../outside.txt', '.env']) {
    assert.equal((await f.call('bridge_read', { path })).error.code, 'PATH_DENIED', path);
  }
  const listing = await f.call('bridge_list', { path: '.' });
  assert.equal(listing.entries.some(entry => entry.name === '.env'), false);
  assert.ok(listing.entries.some(entry => entry.name === 'input.txt'));
});

test('DSH-FIT-002: actual registered bridge readers reject directory links and omit them from lists', async t => {
  const f = await bridgeFixture(t);
  const outside = join(f.root, 'outside-directory');
  await mkdir(outside);
  await writeFile(join(outside, 'outside.txt'), 'outside fixture');
  await symlink(outside, join(f.workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await f.call('bridge_read', { path: 'linked/outside.txt' })).error.code, 'PATH_DENIED');
  assert.equal((await f.call('bridge_list', { path: '.' })).entries.some(entry => entry.name === 'linked'), false);
});

async function replacementFixture(t, access = 'workspace-write') {
  const f = await fixture(t);
  const { apply, replaceWorkspaceText } = await import('../src/native-files.js');
  const tools = new Map();
  await apply({ tools: { register: tool => tools.set(tool.name, tool) } }, { ...f, access });
  return { ...f, tools, replaceWorkspaceText, files: new WorkspaceFiles({ ...f, access }),
    call: async args => JSON.parse(await tools.get('ops_replace').execute(args, {})) };
}

test('DSH-FIT-001/003: ops_replace registration is RW-only and retains the four required parameters', async t => {
  const ro = await replacementFixture(t, 'read-only');
  assert.equal(ro.tools.has('ops_replace'), false);
  await assert.rejects(ro.replaceWorkspaceText(ro.files, { path: 'input.txt', pattern: 'alpha', replacement: 'beta', expectedSha256: sha('alpha alpha') }), { code: 'READ_ONLY' });
  const rw = await replacementFixture(t);
  assert.deepEqual([...rw.tools.keys()], ['ops_replace']);
  const parameters = rw.tools.get('ops_replace').parameters;
  assert.deepEqual(Object.keys(parameters.properties).sort(), ['expectedSha256', 'path', 'pattern', 'replacement']);
  assert.deepEqual([...parameters.required].sort(), ['expectedSha256', 'path', 'pattern', 'replacement']);
});

test('DSH-FIT-003: actual registered ops_replace performs literal replacement with CAS and a recoverable backup', async t => {
  const f = await replacementFixture(t);
  const result = await f.call({ path: 'input.txt', pattern: 'alpha', replacement: '$&', expectedSha256: sha('alpha alpha') });
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(await readFile(join(f.workspace, 'input.txt'), 'utf8'), '$& $&');
  assert.equal(result.sha256, sha('$& $&'));
  const backups = await readdir(f.backupDir);
  assert.equal(backups.length, 1);
  assert.equal(await readFile(join(f.backupDir, backups[0]), 'utf8'), 'alpha alpha');
});

test('ops_replace shares verified backup reuse and rejects corrupt backups before publication', async t => {
  const f = await replacementFixture(t);
  await mkdir(f.backupDir);
  const backup = join(f.backupDir, `${sha('input.txt')}-${sha('alpha alpha')}.txt`);
  await writeFile(backup, 'partial');
  const args = { path: 'input.txt', pattern: 'alpha', replacement: 'beta', expectedSha256: sha('alpha alpha') };
  assert.equal((await f.call(args)).error.code, 'BACKUP_INVALID');
  assert.equal(await readFile(join(f.workspace, 'input.txt'), 'utf8'), 'alpha alpha');
  assert.equal(await readFile(backup, 'utf8'), 'partial');
  assert.deepEqual((await readdir(f.workspace)).sort(), ['.env', 'input.txt']);
  await writeFile(backup, 'alpha alpha');
  assert.equal((await f.call(args)).changed, 1);
  assert.equal(await readFile(join(f.workspace, 'input.txt'), 'utf8'), 'beta beta');
  assert.equal(await readFile(backup, 'utf8'), 'alpha alpha');
});

test('registered file tools protect Teams state across depth and case, including ops_replace', async t => {
  const f = await bridgeFixture(t, 'workspace-write');
  // Mount the replacement adapter against the same backing workspace as bridge_*.
  const { apply } = await import('../src/native-files.js');
  await apply({ tools: { register: tool => f.tools.set(tool.name, tool) } }, { ...f, access: 'workspace-write' });
  for (const prefix of ['', 'nested/']) {
    for (const name of ['.agent-teams-bridge', '.AGENT-TEAMS-BRIDGE']) {
      const path = `${prefix}${name}/team-1/state.json`;
      await mkdir(join(f.workspace, prefix, name, 'team-1'), { recursive: true });
      await writeFile(join(f.workspace, path), 'synthetic team state');
      for (const [tool, args] of [
        ['bridge_list', { path: `${prefix}${name}` }],
        ['bridge_read', { path }],
        ['bridge_write', { path, text: 'tampered', expectedSha256: sha('synthetic team state') }],
        ['ops_replace', { path, pattern: 'state', replacement: 'tampered', expectedSha256: sha('synthetic team state') }],
      ]) assert.equal((await f.call(tool, args)).error.code, 'PATH_DENIED', `${tool}: ${path}`);
      assert.equal((await f.call('bridge_list', { path: prefix || '.' })).entries.some(entry => entry.name.toLowerCase() === name.toLowerCase()), false);
      assert.equal(await readFile(join(f.workspace, path), 'utf8'), 'synthetic team state');
    }
  }
  const args = { path: 'input.txt', pattern: 'alpha', replacement: 'beta', expectedSha256: sha('alpha alpha') };
  assert.equal((await f.call('ops_replace', args)).changed, 1);
  assert.equal((await f.call('bridge_read', { path: 'input.txt' })).text, 'beta beta');
});

test('DSH-FIT-003: actual registered ops_replace rejects outside/protected paths, stale SHA and unsupported modes', async t => {
  const f = await replacementFixture(t);
  const args = { path: 'input.txt', pattern: 'alpha', replacement: 'beta', expectedSha256: sha('alpha alpha') };
  for (const path of [join(f.root, 'outside.txt'), '../outside.txt', '.env']) {
    assert.equal((await f.call({ ...args, path })).error.code, 'PATH_DENIED', path);
  }
  assert.equal((await f.call({ ...args, expectedSha256: '0'.repeat(64) })).error.code, 'FILE_CHANGED');
  for (const extra of [{ recursive: true }, { regex: true }, { dryRun: true }]) {
    assert.equal((await f.call({ ...args, ...extra })).error.code, 'INVALID_ARGUMENT');
  }
  for (const key of Object.keys(args)) {
    const missing = { ...args }; delete missing[key];
    await assert.rejects(f.call(missing), { code: 'INVALID_ARGS' }, key);
    await assert.rejects(f.replaceWorkspaceText(f.files, missing), { code: 'INVALID_ARGUMENT' }, key);
  }
  assert.equal((await f.call({ ...args, pattern: '' })).error.code, 'INVALID_ARGUMENT');
  assert.equal(await readFile(join(f.workspace, 'input.txt'), 'utf8'), 'alpha alpha');
  assert.equal(await readFile(join(f.root, 'outside.txt'), 'utf8'), 'outside fixture');
  assert.equal(await readFile(join(f.workspace, '.env'), 'utf8'), 'protected fixture');
});

test('DSH-FIT-003: ops_replace covers the whole bounded UTF-8 file past the first read page', async t => {
  const f = await replacementFixture(t);
  const original = `${'x'.repeat(17000)}TARGET末尾`;
  await writeFile(join(f.workspace, 'long.txt'), original);
  const result = await f.call({ path: 'long.txt', pattern: 'TARGET', replacement: 'DONE', expectedSha256: sha(original) });
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(await readFile(join(f.workspace, 'long.txt'), 'utf8'), original.replace('TARGET', 'DONE'));
  await writeFile(join(f.workspace, 'too-large.txt'), 'x'.repeat(262145));
  assert.equal((await f.call({ path: 'too-large.txt', pattern: 'x', replacement: 'y', expectedSha256: sha('x'.repeat(262145)) })).error.code, 'FILE_LIMIT');
});

test('DSH-FIT-003: ops_replace rejects linked paths and non-UTF-8 data without changing outside contents', async t => {
  const f = await replacementFixture(t);
  const outside = join(f.root, 'outside-directory');
  await mkdir(outside);
  await writeFile(join(outside, 'outside.txt'), 'alpha alpha');
  await symlink(outside, join(f.workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const args = { pattern: 'alpha', replacement: 'beta', expectedSha256: sha('alpha alpha') };
  assert.equal((await f.call({ ...args, path: 'linked/outside.txt' })).error.code, 'PATH_DENIED');
  assert.equal(await readFile(join(outside, 'outside.txt'), 'utf8'), 'alpha alpha');
  for (const bytes of [Buffer.from([0x61, 0, 0x62]), Buffer.from([0xff, 0xfe, 0x61])]) {
    await writeFile(join(f.workspace, 'binary.txt'), bytes);
    assert.equal((await f.call({ ...args, path: 'binary.txt', expectedSha256: sha(bytes) })).error.code, 'BINARY_FILE');
    assert.deepEqual(await readFile(join(f.workspace, 'binary.txt')), bytes);
  }
});

test('DSH-FIT-003: no-op replacement preserves bytes without backup and changed replacement preserves BOM', async t => {
  const f = await replacementFixture(t);
  const args = { path: 'input.txt', pattern: 'missing', replacement: 'beta', expectedSha256: sha('alpha alpha') };
  const noMatch = await f.call(args);
  assert.equal(noMatch.matched, 0);
  assert.equal(noMatch.changed, 0);
  assert.equal(noMatch.sha256, args.expectedSha256);
  const identical = await f.call({ ...args, pattern: 'alpha', replacement: 'alpha' });
  assert.equal(identical.matched, 2);
  assert.equal(identical.changed, 0);
  await assert.rejects(stat(f.backupDir), { code: 'ENOENT' });
  const original = '\ufeffalpha';
  await writeFile(join(f.workspace, 'bom.txt'), original);
  const changed = await f.call({ ...args, path: 'bom.txt', pattern: 'alpha', replacement: '', expectedSha256: sha(original) });
  assert.equal(changed.changed, 1);
  assert.deepEqual(await readFile(join(f.workspace, 'bom.txt')), Buffer.from('\ufeff'));
});

test('DSH-FIT-003: ops_replace rejects unpaired UTF-16 surrogates before changing bytes or creating backup', async t => {
  const f = await replacementFixture(t);
  const args = { path: 'input.txt', pattern: 'alpha', replacement: 'beta', expectedSha256: sha('alpha alpha') };
  for (const field of ['pattern', 'replacement']) {
    for (const invalid of ['\ud800', '\udc00']) {
      assert.equal((await f.call({ ...args, [field]: invalid })).error.code, 'INVALID_ARGUMENT', field);
    }
  }
  assert.equal(await readFile(join(f.workspace, 'input.txt'), 'utf8'), 'alpha alpha');
  await assert.rejects(stat(f.backupDir), { code: 'ENOENT' });
});

test('DSH-FIT-003: ops_replace refuses output expansion above 256 KiB without backup or partial write', async t => {
  const f = await replacementFixture(t);
  const result = await f.call({ path: 'input.txt', pattern: 'alpha', replacement: 'x'.repeat(131072), expectedSha256: sha('alpha alpha') });
  assert.equal(result.error.code, 'FILE_LIMIT');
  assert.equal(await readFile(join(f.workspace, 'input.txt'), 'utf8'), 'alpha alpha');
  await assert.rejects(stat(f.backupDir), { code: 'ENOENT' });
});

test('DSH-FIT-003: pre-aborted ops_replace preserves original bytes and creates no backup', async t => {
  const f = await replacementFixture(t);
  const args = { path: 'input.txt', pattern: 'alpha', replacement: 'beta', expectedSha256: sha('alpha alpha') };
  const signal = AbortSignal.abort();
  await assert.rejects(f.replaceWorkspaceText(f.files, args, signal), { name: 'AbortError' });
  const result = JSON.parse(await f.tools.get('ops_replace').execute(args, { signal }));
  assert.ok(result.error, 'the registered adapter must report failure for an already aborted operation');
  assert.equal(await readFile(join(f.workspace, 'input.txt'), 'utf8'), 'alpha alpha');
  await assert.rejects(stat(f.backupDir), { code: 'ENOENT' });
  assert.deepEqual((await readdir(f.workspace)).sort(), ['.env', 'input.txt']);
});
