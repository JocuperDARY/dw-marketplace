import test from 'node:test';
import assert from 'node:assert/strict';
import { readPublished, readPublishedSync } from '../src/publication-read.js';

for (const [name, read] of [['async', readPublished], ['sync', readPublishedSync]]) {
  test(`${name} mutable-pointer read survives a transient Windows miss and reruns validation`, async () => {
    let attempts = 0; const waits = [];
    const result = await read(() => { if (++attempts < 3) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return { revision: 2 }; },
      { platform: 'win32', wait: value => { waits.push(value); } });
    assert.deepEqual(result, { revision: 2 }); assert.equal(attempts, 3); assert.deepEqual(waits, [5, 10]);
  });
  test(`${name} missing, malformed, unsafe and non-Windows paths fail without repair`, async () => {
    for (const [platform, code, expectedAttempts] of [['win32', 'ENOENT', 4], ['win32', 'INVALID_STATE', 1],
      ['win32', 'EACCES', 1], ['win32', undefined, 1], ['linux', 'ENOENT', 1]]) {
      let attempts = 0; const original = Object.assign(new Error('preserved failure'), { code });
      await assert.rejects(async () => read(() => { attempts++; throw original; }, { platform, wait: () => {} }), error => error === original);
      assert.equal(attempts, expectedAttempts);
    }
  });
}
