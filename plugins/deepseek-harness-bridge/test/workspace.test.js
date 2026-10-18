import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceFiles } from '../src/workspace.js';

async function fixture(t, access = 'workspace-write', maxToolCalls = 32) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const backupDir = join(root, 'backups');
  return { root, workspace, backupDir, files: new WorkspaceFiles({ workspace: await realpath(workspace), backupDir, access, maxToolCalls }) };
}

test('read, guarded replacement and original-content backup', async t => {
  const { files, workspace, backupDir } = await fixture(t);
  await writeFile(join(workspace, 'sample.txt'), 'before');
  const original = await files.read('sample.txt');
  await files.write('sample.txt', 'after', original.sha256);
  assert.equal(await readFile(join(workspace, 'sample.txt'), 'utf8'), 'after');
  const backups = await readdir(backupDir);
  assert.equal(backups.length, 1);
  assert.equal(await readFile(join(backupDir, backups[0]), 'utf8'), 'before');
  await assert.rejects(files.write('sample.txt', 'stale', original.sha256), { code: 'FILE_CHANGED' });
  await assert.rejects(files.write('sample.txt', 'overwrite', 'new'), { code: 'EEXIST' });
  await files.write('new.txt', 'created', 'new');
});

test('relative paths reject traversal, protected metadata and alternate streams', async t => {
  const { files } = await fixture(t);
  for (const path of ['../outside', '..\\outside', '/etc/passwd', 'C:\\file', 'a:stream', '.env', '.env.local', '.git/config', '.codex/config.toml', 'foo. /x']) {
    await assert.rejects(files.read(path), { code: 'PATH_DENIED' });
  }
});

test('junctions and hard links cannot expose external files', async t => {
  const { files, root, workspace } = await fixture(t);
  const outside = join(root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'secret'), 'outside');
  await symlink(outside, join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(files.read('escape/secret'), { code: 'PATH_DENIED' });
  await link(join(outside, 'secret'), join(workspace, 'hardlink'));
  await assert.rejects(files.read('hardlink'), { code: 'PATH_DENIED' });
  assert.deepEqual((await files.list()).entries.map(entry => entry.name), ['hardlink']);
});

test('read-only, byte, call and cancellation limits are enforced', async t => {
  const { files, workspace } = await fixture(t, 'read-only', 4);
  await assert.rejects(files.write('new.txt', 'no', 'new'), { code: 'READ_ONLY' });
  await writeFile(join(workspace, 'large'), Buffer.alloc(262145, 65));
  await assert.rejects(files.read('large'), { code: 'FILE_LIMIT' });
  await writeFile(join(workspace, 'binary'), Buffer.from([255]));
  await assert.rejects(files.read('binary'), { code: 'BINARY_FILE' });
  await files.list();
  await assert.rejects(files.list(), { code: 'TOOL_LIMIT' });
  await assert.rejects(files.list('.', AbortSignal.abort()), { name: 'AbortError' });
});
