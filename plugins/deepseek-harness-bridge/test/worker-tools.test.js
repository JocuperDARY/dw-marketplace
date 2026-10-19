import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../src/worker-tools.js';

test('tool receipts retain attempted calls whose preparation never reaches post-execute', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-tool-receipts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hooks = new Map();
  const receiptPath = join(root, 'receipt.json');
  await apply({ tools: { schemas: () => [{ name: 'pwsh' }, { name: 'echo' }] },
    on: (name, listener) => hooks.set(name, listener) },
  { workspace: root, access: 'workspace-write', fileTools: false,
    extraTools: ['pwsh', 'echo'], receiptPath, nonce: 'receipt-test' });
  const pre = hooks.get('tools/pre-execute');
  const post = hooks.get('tools/post-execute');
  // Preparation can throw after the bridge admitted a call; the SDK does not
  // deliver post-execute for this path. It is not an observed success/error.
  await assert.rejects(pre({ name: 'pwsh' }, async () => { throw new Error('preparation refused'); }), /preparation refused/);
  await pre({ name: 'echo' }, async () => ({ kind: 'allow' }));
  await post({ name: 'echo' }, { isError: false }, async () => ({ kind: 'accept' }));
  await pre({ name: 'echo' }, async () => ({ kind: 'allow' }));
  await post({ name: 'echo' }, { isError: true }, async () => ({ kind: 'accept' }));
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  assert.equal(receipt.toolCalls, 3);
  assert.deepEqual(receipt.toolOutcomes.pwsh, { attempted: 1, returned: 0, error: 0, unobserved: 1 });
  assert.deepEqual(receipt.toolOutcomes.echo, { attempted: 2, returned: 1, error: 1, unobserved: 0 });
  assert.equal(Object.values(receipt.toolOutcomes).reduce((sum, item) => sum + item.attempted, 0), receipt.toolCalls);
});
