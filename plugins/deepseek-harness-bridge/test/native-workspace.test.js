import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectNativeWorkspace, prepareNativeWorkspace, validateNativeShellWorkspace } from '../src/native-workspace.js';
import { resolveNativeProfile } from '../src/native-profile.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'native-workspace-'));
  await mkdir(join(root, 'state'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const windows = { skip: process.platform !== 'win32', timeout: 30000 };

test('native workspace preparation creates exactly one new directory with the calling worker owner', windows, async t => {
  const root = await fixture(t);
  // Shell metacharacters remain literal path data in the fixed probe.
  const workspace = join(root, '中文字-literal-$(no-command)-directory');
  const dataDir = join(root, 'state');
  const result = await prepareNativeWorkspace({ workspace, dataDir });
  assert.equal(result.created, true);
  assert.equal(result.aclChanged, false);
  assert.equal(result.modelRequests, 0);
  assert.equal(result.shellExecutionVerified, false);
  assert.equal(result.evidence.ownerSid, result.evidence.currentSid);
  assert.deepEqual(result.evidence.reparseAncestors, []);
  assert.equal((await stat(workspace)).isDirectory(), true);
  assert.deepEqual(await validateNativeShellWorkspace(workspace), result.evidence);
  await assert.rejects(prepareNativeWorkspace({ workspace, dataDir }), { code: 'NATIVE_WORKSPACE_EXISTS' });
});

test('preparation preserves existing contents and never creates missing ancestors', windows, async t => {
  const root = await fixture(t);
  const dataDir = join(root, 'state');
  const existing = join(root, 'existing');
  await mkdir(existing);
  await writeFile(join(existing, 'sentinel.txt'), 'preserve');
  await assert.rejects(prepareNativeWorkspace({ workspace: existing, dataDir }), { code: 'NATIVE_WORKSPACE_EXISTS' });
  assert.equal(await readFile(join(existing, 'sentinel.txt'), 'utf8'), 'preserve');
  await assert.rejects(prepareNativeWorkspace({ workspace: join(root, 'missing', 'child'), dataDir }), { code: 'NATIVE_WORKSPACE_UNVERIFIED' });
  await assert.rejects(stat(join(root, 'missing')), { code: 'ENOENT' });
});

test('wrong owner remains rejected even when the worker might have broad ACL rights', async () => {
  const evidence = { workspace: 'fixture', directory: true, currentSid: 'S-1-5-21-1', ownerSid: 'S-1-5-21-2', reparseAncestors: [] };
  await assert.rejects(validateNativeShellWorkspace('fixture', { inspect: async () => evidence }), error => {
    assert.equal(error.code, 'NATIVE_WORKSPACE_OWNER');
    assert.match(error.message, /S-1-5-21-2 differs from worker account S-1-5-21-1/);
    assert.match(error.message, /dsh_prepare_workspace/);
    assert.match(error.message, /exclude shell/);
    return true;
  });
});

test('failed new-directory owner verification removes only the new empty directory', windows, async t => {
  const root = await fixture(t);
  const workspace = join(root, 'new');
  const inspect = async path => {
    const evidence = await inspectNativeWorkspace(path);
    return path === workspace ? { ...evidence, ownerSid: 'S-1-5-21-999' } : evidence;
  };
  await assert.rejects(prepareNativeWorkspace({ workspace, dataDir: join(root, 'state') }, { inspect }), { code: 'NATIVE_WORKSPACE_OWNER' });
  await assert.rejects(stat(workspace), { code: 'ENOENT' });
  assert.equal((await stat(root)).isDirectory(), true);
});

test('junction roots and junction ancestors are rejected without creating children', windows, async t => {
  const root = await fixture(t);
  const actual = join(root, 'actual');
  await mkdir(actual);
  await mkdir(join(actual, 'nested'));
  const link = join(root, 'link');
  await symlink(actual, link, 'junction');
  await assert.rejects(validateNativeShellWorkspace(link), { code: 'NATIVE_WORKSPACE_REPARSE' });
  await assert.rejects(validateNativeShellWorkspace(join(link, 'nested')), { code: 'NATIVE_WORKSPACE_REPARSE' });
  await assert.rejects(prepareNativeWorkspace({ workspace: join(link, 'new'), dataDir: join(root, 'state') }), { code: 'NATIVE_WORKSPACE_REPARSE' });
  await assert.rejects(stat(join(actual, 'new')), { code: 'ENOENT' });
});

test('preparation refuses bridge state overlap before attempting creation', windows, async t => {
  const root = await fixture(t);
  const dataDir = join(root, 'state');
  for (const workspace of [dataDir, join(dataDir, 'new'), root]) {
    await assert.rejects(prepareNativeWorkspace({ workspace, dataDir }), { code: 'INVALID_ARGUMENT' });
  }
  await assert.rejects(stat(join(dataDir, 'new')), { code: 'ENOENT' });
});

test('preparation works before state exists and still rejects future state overlap', windows, async t => {
  const root = await fixture(t);
  const dataDir = join(root, 'future-state', 'tasks');
  const result = await prepareNativeWorkspace({ workspace: join(root, 'new-workspace'), dataDir });
  assert.equal(result.created, true);
  await assert.rejects(stat(join(root, 'future-state')), { code: 'ENOENT' });
  for (const workspace of [join(root, 'future-state'), join(dataDir, 'new')]) {
    await assert.rejects(prepareNativeWorkspace({ workspace, dataDir }), { code: 'INVALID_ARGUMENT' });
  }
});

test('native profile validates Shell workspace before loading any native modules', windows, async t => {
  const root = await fixture(t);
  const target = join(root, 'target');
  await mkdir(target);
  const link = join(root, 'link');
  await symlink(target, link, 'junction');
  // Missing inventory cannot hide an invalid authority root.
  await assert.rejects(resolveNativeProfile({ inventoryHome: join(root, 'no-inventory') }, {
    workspace: link, access: 'workspace-write', nativePlugins: ['shell'],
  }), { code: 'NATIVE_WORKSPACE_REPARSE' });
  await assert.rejects(resolveNativeProfile({ inventoryHome: root }, {
    workspace: target, requestedWorkspace: link, access: 'workspace-write', nativePlugins: ['shell'],
  }), { code: 'NATIVE_WORKSPACE_REPARSE' });
  const profile = await resolveNativeProfile({ inventoryHome: root }, {
    workspace: target, access: 'workspace-write', nativePlugins: ['shell'],
  });
  assert.ok(profile.tools.includes('pwsh'));
  assert.ok(profile.modules.some(module => module.runtimeId === 'pwsh-sandbox'));
  assert.equal((await resolveNativeProfile({ inventoryHome: root }, {
    workspace: target, requestedWorkspace: target, access: 'workspace-write', nativePlugins: ['shell'],
  })).digest, profile.digest);
});
