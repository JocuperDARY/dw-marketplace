import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConcurrentStore as OldStore } from './fixtures/protocol-v3-store.js';
import { ConcurrentStore } from '../src/concurrent-store.js';
import { upgradeStore } from '../src/protocol-upgrade.js';

test('new and already-open v3 writers are fenced before admission after explicit v4 migration', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-fencing-')); const dataDir = join(root, 'state');
  await mkdir(join(root, 'workspace')); const workspace = await realpath(join(root, 'workspace'));
  t.after(async () => { if (t.passed) await rm(root, { recursive: true, force: true }); });
  const old = new OldStore({ dataDir });
  const record = { schemaVersion: 3, taskId: randomUUID(), sessionId: `bridge-${randomUUID()}`, workspace, access: 'read-only',
    attempts: [{ number: 1, requestId: 'first', fingerprint: 'a'.repeat(64), status: 'running', cleanup: 'pending' }] };
  const receipt = await old.admit(record, { requestId: 'first', fingerprint: 'a'.repeat(64) });
  record.attempts[0].status = 'completed'; record.attempts[0].cleanup = 'confirmed';
  await old.persist(record); await old.release(record.taskId, { cleanup: 'confirmed' });
  const current = new ConcurrentStore({ dataDir });
  await assert.rejects(current.read(), { code: 'UPGRADE_REQUIRED' });
  assert.equal((await upgradeStore({ dataDir })).protocol, 4);
  const another = { ...record, taskId: randomUUID(), attempts: [{ ...record.attempts[0], requestId: 'new', status: 'running', cleanup: 'pending' }] };
  for (const host of [old, new OldStore({ dataDir })]) {
    await assert.rejects(host.admit(another, { requestId: 'new', fingerprint: 'a'.repeat(64) }), { code: 'UPGRADE_REQUIRED' });
    await assert.rejects(host.requestCancel(record.taskId, { controlToken: receipt.controlToken }), { code: 'UPGRADE_REQUIRED' });
  }
  const read = await current.read(); assert.equal(read.records.length, 1); assert.equal(read.leases.length, 0);
  assert.deepEqual(read.records[0], record);
  assert.equal((await current.admit(another, { requestId: 'new', fingerprint: 'a'.repeat(64) })).duplicate, false);
  another.attempts[0].status = 'completed'; another.attempts[0].cleanup = 'confirmed';
  await current.persist(another); await current.release(another.taskId, { cleanup: 'confirmed' });
});
