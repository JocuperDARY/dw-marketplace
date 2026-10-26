import test from 'node:test';
import assert from 'node:assert/strict';
import { readHeartbeat } from './fixtures/heartbeat.js';

test('synthetic heartbeat treats truncation windows as unobserved, never PID zero', async () => {
  for (const text of ['', '30012:', '30012', '0:1', '30012:0', '30012:9007199254740993', 'private-marker']) {
    assert.equal(await readHeartbeat('unused', async () => text), null);
  }
  const observed = await readHeartbeat('unused', async () => '30012:1793010000000');
  assert.deepEqual(observed, { raw: '30012:1793010000000', pid: 30012, timestamp: 1793010000000 });
});

test('heartbeat reads retain I/O errors instead of treating them as valid evidence', async () => {
  const error = Object.assign(new Error('fixture missing'), { code: 'ENOENT' });
  await assert.rejects(readHeartbeat('unused', async () => { throw error; }), caught => caught === error);
});
