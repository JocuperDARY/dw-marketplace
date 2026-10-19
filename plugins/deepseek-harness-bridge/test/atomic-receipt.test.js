import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAtomicReceiptWriter, writeAtomicReceipt } from '../src/atomic-receipt.js';

const filesystemError = code => Object.assign(new Error(`fixture ${code}`), { code, syscall: 'rename' });

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'bridge-atomic-receipt-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const target = join(home, 'receipt.json');
  await writeFile(target, '{"old":true}');
  return { home, target };
}

test('Windows sharing failures retry only rename while preserving the old complete receipt', async t => {
  const { home, target } = await fixture(t);
  let attempts = 0;
  let elapsed = 0;
  const waits = [];
  const writer = createAtomicReceiptWriter({ platform: 'win32', now: () => elapsed,
    wait: async ms => { waits.push(ms); elapsed += ms; },
    renameFile: async (source, destination) => {
      attempts++;
      assert.equal(destination, target);
      assert.equal(await readFile(source, 'utf8'), '{"new":true}');
      assert.equal(await readFile(target, 'utf8'), '{"old":true}');
      if (attempts < 3) throw filesystemError(attempts === 1 ? 'EPERM' : 'EBUSY');
      await rename(source, destination);
    } });
  await writer(target, '{"new":true}');
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [10, 20]);
  assert.equal(await readFile(target, 'utf8'), '{"new":true}');
  assert.deepEqual(await readdir(home), ['receipt.json']);
});

test('permanent sharing failures stop after six attempts and preserve the exact final error', async t => {
  const { home, target } = await fixture(t);
  let attempts = 0;
  let elapsed = 0;
  let last;
  const waits = [];
  const writer = createAtomicReceiptWriter({ platform: 'win32', now: () => elapsed,
    wait: async ms => { waits.push(ms); elapsed += ms; },
    renameFile: async () => { attempts++; last = filesystemError('EPERM'); throw last; } });
  await assert.rejects(writer(target, '{"new":true}'), error => error === last && error.code === 'EPERM');
  assert.equal(attempts, 6);
  assert.deepEqual(waits, [10, 20, 40, 80, 160]);
  assert.equal(elapsed, 310);
  assert.equal(await readFile(target, 'utf8'), '{"old":true}');
  assert.deepEqual(await readdir(home), ['receipt.json']);
});

test('an overslept monotonic retry deadline prevents another rename attempt', async t => {
  const { target } = await fixture(t);
  let elapsed = 0;
  let attempts = 0;
  const failure = filesystemError('EBUSY');
  const writer = createAtomicReceiptWriter({ platform: 'win32', now: () => elapsed,
    wait: async () => { elapsed += 501; }, renameFile: async () => { attempts++; throw failure; } });
  await assert.rejects(writer(target, '{}'), error => error === failure);
  assert.equal(attempts, 1);
});

test('other errors and non-Windows permission errors are immediately visible without retry', async t => {
  for (const [platform, code] of [['win32', 'EACCES'], ['win32', 'ENOENT'], ['win32', 'EIO'], ['linux', 'EPERM']]) {
    const { target } = await fixture(t);
    const failure = filesystemError(code);
    let attempts = 0;
    const writer = createAtomicReceiptWriter({ platform, wait: async () => assert.fail('unexpected retry'),
      renameFile: async () => { attempts++; throw failure; } });
    await assert.rejects(writer(target, '{}'), error => error === failure);
    assert.equal(attempts, 1);
  }
});

test('an exclusive-open failure never removes an unowned temporary path', async t => {
  const { target } = await fixture(t);
  const failure = filesystemError('EEXIST');
  const writer = createAtomicReceiptWriter({ openFile: async (_path, flag, mode) => {
    assert.equal(flag, 'wx'); assert.equal(mode, 0o600); throw failure;
  }, unlinkFile: async () => assert.fail('unowned path must not be cleaned'), renameFile: async () => assert.fail('nothing was staged') });
  await assert.rejects(writer(target, '{}'), error => error === failure);
  assert.equal(await readFile(target, 'utf8'), '{"old":true}');
});

test('a staged write failure closes and cleans its own temporary without replacing the target', async t => {
  const { home, target } = await fixture(t);
  const failure = filesystemError('ENOSPC');
  let closed = false;
  const writer = createAtomicReceiptWriter({ openFile: async (...args) => {
    const handle = await open(...args);
    return { writeFile: async () => { await handle.writeFile('partial'); throw failure; }, close: async () => { closed = true; await handle.close(); } };
  }, renameFile: async () => assert.fail('partial receipt must not be published') });
  await assert.rejects(writer(target, '{}'), error => error === failure);
  assert.equal(closed, true);
  assert.equal(await readFile(target, 'utf8'), '{"old":true}');
  assert.deepEqual(await readdir(home), ['receipt.json']);
});

test('concurrent publishers use unique owned temporaries and leave unrelated evidence untouched', async t => {
  const { home, target } = await fixture(t);
  const unrelated = join(home, 'unrelated.tmp');
  await writeFile(unrelated, 'retain this evidence');
  const paths = new Set();
  const writer = createAtomicReceiptWriter({ renameFile: async (source, destination) => {
    paths.add(source);
    await rename(source, destination);
  } });
  await Promise.all([writer(target, '{"writer":1}'), writer(target, '{"writer":2}')]);
  assert.equal(paths.size, 2);
  assert.ok([1, 2].includes(JSON.parse(await readFile(target, 'utf8')).writer));
  assert.equal(await readFile(unrelated, 'utf8'), 'retain this evidence');
  assert.deepEqual((await readdir(home)).sort(), ['receipt.json', 'unrelated.tmp']);
  await writeAtomicReceipt(target, '{"default":true}');
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { default: true });
});

test('cleanup failure remains visible together with the original publication failure', async t => {
  const { target } = await fixture(t);
  const publication = filesystemError('EIO');
  const cleanup = filesystemError('EBUSY');
  const writer = createAtomicReceiptWriter({ renameFile: async () => { throw publication; }, unlinkFile: async () => { throw cleanup; } });
  await assert.rejects(writer(target, '{}'), error => error instanceof AggregateError && error.cause === publication
    && error.errors[0] === publication && error.errors[1] === cleanup);
});
