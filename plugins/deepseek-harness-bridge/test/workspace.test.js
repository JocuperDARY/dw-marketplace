import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { WorkspaceFiles } from '../src/workspace.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const backupName = (path, text) => `${sha(path)}-${sha(text)}.txt`;

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

test('verified same-name backups can be reused without replacing their contents', async t => {
  const { files, workspace, backupDir } = await fixture(t);
  await writeFile(join(workspace, 'sample.txt'), 'original');
  await mkdir(backupDir);
  const backup = join(backupDir, backupName('sample.txt', 'original'));
  await writeFile(backup, 'original');
  await files.write('sample.txt', 'replacement', sha('original'));
  assert.equal(await readFile(join(workspace, 'sample.txt'), 'utf8'), 'replacement');
  assert.equal(await readFile(backup, 'utf8'), 'original');
  assert.deepEqual(await readdir(backupDir), [backupName('sample.txt', 'original')]);
});

for (const content of ['', 'orig', 'different']) {
  test(`corrupt same-name backup (${JSON.stringify(content)}) blocks publication and preserves evidence`, async t => {
    const { files, workspace, backupDir } = await fixture(t);
    await writeFile(join(workspace, 'sample.txt'), 'original');
    await mkdir(backupDir);
    const backup = join(backupDir, backupName('sample.txt', 'original'));
    await writeFile(backup, content);
    await assert.rejects(files.write('sample.txt', 'replacement', sha('original')), { code: 'BACKUP_INVALID' });
    assert.equal(await readFile(join(workspace, 'sample.txt'), 'utf8'), 'original');
    assert.equal(await readFile(backup, 'utf8'), content);
    assert.deepEqual(await readdir(workspace), ['sample.txt']);
  });
}

for (const kind of ['symlink', 'hardlink', 'directory']) {
  test(`same-name backup must be an ordinary file with one link: ${kind}`, async t => {
    const { files, root, workspace, backupDir } = await fixture(t);
    await writeFile(join(workspace, 'sample.txt'), 'original');
    await mkdir(backupDir);
    const backup = join(backupDir, backupName('sample.txt', 'original'));
    const source = join(root, 'backup-source');
    await writeFile(source, 'original');
    try {
      if (kind === 'symlink') await symlink(source, backup, 'file');
      else if (kind === 'hardlink') await link(source, backup);
      else await mkdir(backup);
    } catch (error) {
      if (['EPERM', 'ENOTSUP', 'EACCES'].includes(error.code)) return t.skip(`${kind} unavailable: ${error.code}`);
      throw error;
    }
    await assert.rejects(files.write('sample.txt', 'replacement', sha('original')), { code: 'BACKUP_INVALID' });
    assert.equal(await readFile(join(workspace, 'sample.txt'), 'utf8'), 'original');
    assert.equal(await readFile(source, 'utf8'), 'original');
    assert.deepEqual(await readdir(workspace), ['sample.txt']);
  });
}

test('backup failure never takes over an existing workspace writer lock', async t => {
  const { files, workspace, backupDir } = await fixture(t);
  await writeFile(join(workspace, 'sample.txt'), 'original');
  await mkdir(backupDir);
  const backup = join(backupDir, backupName('sample.txt', 'original'));
  await writeFile(backup, 'corrupt');
  await writeFile(join(workspace, '.dsh-bridge-write.lock'), 'existing-owner');
  await assert.rejects(files.write('sample.txt', 'replacement', sha('original')), { code: 'WORKSPACE_LOCKED' });
  assert.equal(await readFile(join(workspace, '.dsh-bridge-write.lock'), 'utf8'), 'existing-owner');
  assert.equal(await readFile(join(workspace, 'sample.txt'), 'utf8'), 'original');
  assert.equal(await readFile(backup, 'utf8'), 'corrupt');
});

test('unreadable same-name backup fails clearly without changing target or backup', async t => {
  const { files, workspace, backupDir } = await fixture(t);
  await writeFile(join(workspace, 'sample.txt'), 'original');
  await mkdir(backupDir);
  const backup = join(backupDir, backupName('sample.txt', 'original'));
  await writeFile(backup, 'original');
  const read = files.readBytes.bind(files);
  files.readBytes = async target => {
    if (target === backup) throw Object.assign(new Error('synthetic backup access denied'), { code: 'EACCES' });
    return read(target);
  };
  await assert.rejects(files.write('sample.txt', 'replacement', sha('original')), error => {
    assert.equal(error.code, 'BACKUP_INVALID');
    assert.match(error.message, /unreadable/);
    assert.ok(!error.message.includes('synthetic backup access denied'));
    return true;
  });
  assert.equal(await readFile(join(workspace, 'sample.txt'), 'utf8'), 'original');
  assert.equal(await readFile(backup, 'utf8'), 'original');
  assert.deepEqual(await readdir(workspace), ['sample.txt']);
});

test('Teams state is protected at every depth and case for list/read/write while project files work', async t => {
  const { files, workspace } = await fixture(t, 'workspace-write', 128);
  for (const prefix of ['', 'nested/']) {
    for (const name of ['.agent-teams-bridge', '.AGENT-TEAMS-BRIDGE']) {
      const directory = prefix + name;
      const path = `${directory}/team-1/state.json`;
      await mkdir(dirname(join(workspace, path)), { recursive: true });
      await writeFile(join(workspace, path), 'synthetic state');
      await assert.rejects(files.list(directory), { code: 'PATH_DENIED' });
      await assert.rejects(files.read(path), { code: 'PATH_DENIED' });
      await assert.rejects(files.write(path, 'tampered', sha('synthetic state')), { code: 'PATH_DENIED' });
      await assert.rejects(files.write(`${directory}/new.json`, 'tampered', 'new'), { code: 'PATH_DENIED' });
      assert.equal((await files.list(prefix || '.')).entries.some(entry => entry.name.toLowerCase() === name.toLowerCase()), false);
      assert.equal(await readFile(join(workspace, path), 'utf8'), 'synthetic state');
    }
  }
  await files.write('project.json', 'ordinary', 'new');
  assert.equal((await files.read('project.json')).text, 'ordinary');
  assert.equal((await files.list()).entries.some(entry => entry.name === 'project.json'), true);
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

test('credential names are denied at every depth without hiding ordinary project files', async t => {
  const { files, workspace } = await fixture(t, 'workspace-write', 512);
  const protectedPaths = ['.env', '.envrc', '.envrc.local', '.netrc', '_netrc', '.pgpass', 'pgpass.conf',
    '.git-credentials', '.pypirc', '.kube/config', '.docker/config.json',
    'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'id_ecdsa_sk', 'id_ed25519_sk', 'ID_RSA'];
  const ordinaryPaths = ['package.json', 'README.md', 'config.json', 'id_rsa.pub', 'id_ed25519.pub', 'identity.js'];
  for (const prefix of ['', 'nested/']) {
    for (const path of [...protectedPaths, ...ordinaryPaths]) {
      await mkdir(dirname(join(workspace, prefix + path)), { recursive: true });
      await writeFile(join(workspace, prefix + path), 'synthetic fixture');
    }
    const exposed = [];
    for (const path of protectedPaths) {
      for (const [operation, run] of [
        ['resolve', () => files.resolve(prefix + path)],
        ['read', () => files.read(prefix + path)],
        ['write', () => files.write(prefix + path, 'replacement', 'new')],
        ['list', () => files.list(prefix + path)],
      ]) {
        try { await run(); exposed.push({ path: prefix + path, operation, code: 'ALLOWED' }); }
        catch (error) { if (error.code !== 'PATH_DENIED') exposed.push({ path: prefix + path, operation, code: error.code }); }
      }
    }
    assert.deepEqual(exposed, [], 'Known credential paths must fail before any file operation');
    const entries = (await files.list(prefix || '.')).entries.map(entry => entry.name);
    for (const path of protectedPaths) assert.ok(!entries.includes(path.split('/')[0]), path);
    for (const path of ordinaryPaths) {
      assert.ok(entries.includes(path), path);
      assert.equal((await files.read(prefix + path)).text, 'synthetic fixture');
    }
  }
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
