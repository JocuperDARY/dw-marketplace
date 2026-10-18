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
  for (const path of ['../outside', '..\\outside', '/etc/passwd', 'C:\\file', 'a:stream', '.env', '.env.local', '.npmrc', '.config/credentials', '.dsh-bridge-write.lock', '.git/config', '.codex/config.toml', 'foo. /x']) {
    await assert.rejects(files.read(path), { code: 'PATH_DENIED' });
  }
});

test('protected entries and Windows short aliases cannot be listed or read', async t => {
  const { files, workspace } = await fixture(t);
  await writeFile(join(workspace, '.npmrc'), 'fixture');
  await mkdir(join(workspace, '.config'));
  assert.deepEqual((await files.list()).entries, []);
  if (process.platform === 'win32') await assert.rejects(files.read('CONFIG~1/secret'), { code: 'PATH_DENIED' });
});

test('large files are paginated below the default request envelope', async t => {
  const { files, workspace } = await fixture(t);
  const text = '\u0001'.repeat(262144);
  await writeFile(join(workspace, 'large.txt'), text);
  const page = await files.read('large.txt');
  assert.equal(page.truncated, true);
  assert.equal(page.nextOffset, 16384);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 100000);
  const next = await files.read('large.txt', undefined, page.nextOffset);
  assert.equal(next.offset, 16384);
  assert.equal(next.sha256, page.sha256);
});

test('two bridge writers cannot publish from the same stale hash', async t => {
  const { files, workspace, backupDir } = await fixture(t);
  await writeFile(join(workspace, 'shared.txt'), 'original');
  const original = await files.read('shared.txt');
  const second = new WorkspaceFiles({ workspace: await realpath(workspace), backupDir, access: 'workspace-write', maxToolCalls: 4 });
  const results = await Promise.allSettled([files.write('shared.txt', 'first', original.sha256), second.write('shared.txt', 'second', original.sha256)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(['WORKSPACE_LOCKED', 'FILE_CHANGED'].includes(results.find(result => result.status === 'rejected').reason.code));
  assert.ok(['first', 'second'].includes(await readFile(join(workspace, 'shared.txt'), 'utf8')));
  assert.deepEqual((await readdir(workspace)).sort(), ['shared.txt']);
});

test('cancellation during replacement preparation preserves the original', async t => {
  const { files, workspace } = await fixture(t);
  await writeFile(join(workspace, 'sample.txt'), 'original');
  const original = await files.read('sample.txt');
  const controller = new AbortController();
  const read = files.readBytes.bind(files);
  files.readBytes = async target => { const bytes = await read(target); controller.abort(); return bytes; };
  await assert.rejects(files.write('sample.txt', 'replacement', original.sha256, controller.signal), { name: 'AbortError' });
  assert.equal(await readFile(join(workspace, 'sample.txt'), 'utf8'), 'original');
  assert.deepEqual((await readdir(workspace)).sort(), ['sample.txt']);
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
