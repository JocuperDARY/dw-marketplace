import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskManager } from '../src/tasks.js';
import { assessDelivery, deliveryPrompt } from '../src/delivery.js';
import { assignment, contract, delivery } from './fixtures/delegation-evidence-data.js';

test('rendered delivery obligations distinguish authority, reviewed claims, and derived prerequisites', () => {
  for (const orchestrated of [false, true]) {
    const prompt = deliveryPrompt(assignment, contract, orchestrated);
    assert.ok(prompt.startsWith(assignment), 'Original rules and reviewed claims remain intact.');
    for (const phrase of ['Authoritative rules and facts', 'claims under review',
      'explicit requirement', 'checkable derivation', 'general rule', 'numerical instance', 'identity metadata', 'compound claim', 'ties']) {
      assert.match(prompt, new RegExp(phrase, 'i'), `Missing generic review obligation: ${phrase}`);
    }
    assert.ok(prompt.includes('For every asserted or newly added prerequisite'),
      'Review obligations must cover asserted prerequisites as well as newly added ones.');
    assert.ok(prompt.includes('A valid locator alone, like a known rule ID, does not establish that the text supports the conclusion.'),
      'Neither a valid locator nor a known rule ID alone establishes source support.');
  }
});

test('known rule references check membership only, for both counterexamples and legitimate controls', () => {
  // Authored reference judgments are review material, not an automated prose oracle.
  for (const value of [delivery(), delivery({ counterexamples: true })]) {
    const report = assessDelivery(JSON.stringify(value), contract, { status: 'completed' });
    assert.equal(report.status, 'structure_complete');
    assert.equal(report.scope, 'structure_only');
    assert.equal(Object.hasOwn(report, 'accepted'), false);
  }
  const unknown = delivery({ counterexamples: true });
  unknown.cases[0].ruleIds = ['UNSUPPLIED_RULE'];
  const report = assessDelivery(JSON.stringify(unknown), contract, { status: 'completed' });
  assert.equal(report.status, 'incomplete');
  assert.deepEqual(report.issues, [{ code: 'UNKNOWN_RULE', path: 'cases.reviewed_authority.ruleIds.UNSUPPLIED_RULE' }]);
});

for (const mode of ['single-request', 'budgeted']) {
  test(`${mode}: completed counterexamples preserve actual output without semantic acceptance, recovery, or replay`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-evidence-offline-'));
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    const dataDir = join(root, 'state');
    const fabricated = delivery({ counterexamples: true });
    const payloadText = JSON.stringify(fabricated);
    const outputText = mode === 'budgeted'
      ? JSON.stringify({ state: 'completed', summary: payloadText, nextSteps: '' }) : payloadText;
    let launches = 0;
    let receiptNonce;
    let reservedOutputTokens;
    const options = { dataDir, resolveCapabilities: async id => ({ id, digest: 'offline', access: 'read-only' }) };
    const manager = await new TaskManager({ ...options, runner: async ({ task }) => {
      launches++;
      receiptNonce = mode === 'budgeted' ? task.stageBudget.nonce : 'offline-single-request';
      reservedOutputTokens = task.maxTokens;
      return { terminal: 'completed', text: outputText, cleanup: 'confirmed', toolCalls: 0,
        budget: { nonce: receiptNonce, modelRequests: 1, maxRequestBytesObserved: 256, denied: null,
          calls: [{ number: 1, reservedOutputTokens: task.maxTokens, usage: { outputTokens: 100 }, finished: true }] } };
    } }).open();
    let restarted;
    t.after(async () => {
      await manager.close();
      if (restarted) await restarted.close();
      await rm(root, { recursive: true, force: true });
    });
    const input = { requestId: `evidence-${mode}`, prompt: assignment, workspace, reviewContract: contract,
      ...(mode === 'single-request' ? { executionMode: mode } : { capabilityProfile: 'inference-only', maxModelRequests: 2,
        budget: { totalModelRequests: 2, totalOutputTokens: 16384, totalToolCalls: 0, totalDurationMs: 60000 } }) };
    const submitted = await manager.submit(input);
    await manager.wait({ taskId: submitted.taskId });
    const done = await manager.result({ taskId: submitted.taskId });
    const expectedReceipt = { nonce: receiptNonce, modelRequests: 1, maxRequestBytesObserved: 256, denied: null,
      calls: [{ number: 1, reservedOutputTokens, usage: { outputTokens: 100 }, finished: true }] };
    const assertPreserved = receipt => {
      assert.equal(receipt.terminal, 'completed');
      assert.equal(receipt.status, 'completed');
      assert.equal(receipt.cleanup, 'confirmed');
      assert.equal(receipt.toolCalls, 0);
      assert.equal(receipt.error, null);
      assert.deepEqual(receipt.budget, expectedReceipt, 'Retain the complete authored usage receipt, including call usage and denial state.');
      assert.equal(receipt.recovery, undefined);
    };
    assertPreserved(done);
    assertPreserved((await manager.record(submitted.taskId)).attempts[0]);
    assert.equal(done.outputValidation.status, 'valid');
    assert.equal(done.deliveryValidation.status, 'structure_complete');
    assert.equal(done.parentAcceptance, 'not_assessed');
    assert.equal(done.text, outputText, 'Actual runner output must be preserved byte-for-byte.');
    const decoded = mode === 'budgeted' ? JSON.parse(JSON.parse(done.text).summary) : JSON.parse(done.text);
    assert.deepEqual(decoded, fabricated);
    assert.equal(launches, 1, 'Semantic defects do not trigger an automatic retry.');
    assert.equal((await manager.record(submitted.taskId)).attempts.length, 1);
    assert.equal((await manager.record(submitted.taskId)).attempts[0].recovery, undefined);
    if (mode === 'budgeted') {
      assert.equal(done.orchestration.stages, 1);
      assert.deepEqual(done.orchestration.charged, { modelRequests: 1, outputTokens: 100, toolCalls: 0 });
      const stage = (await manager.record(submitted.taskId)).orchestration.stages[0];
      assert.equal(stage.terminal, 'completed');
      assert.equal(stage.status, 'completed');
      assert.deepEqual(stage.budget, expectedReceipt);
    } else {
      await assert.rejects(manager.continue({ taskId: submitted.taskId, requestId: 'forbidden-repair', prompt: 'Repair the semantics.' }), { code: 'NOT_RESUMABLE' });
    }
    await manager.close();
    restarted = await new TaskManager({ ...options, runner: () => assert.fail('Restart/replay must not invoke a worker.') }).open();
    const replay = await restarted.submit(input);
    assert.equal(replay.duplicate, true);
    assertPreserved(replay);
    assertPreserved(await restarted.result({ taskId: submitted.taskId }));
    assertPreserved((await restarted.record(submitted.taskId)).attempts[0]);
    if (mode === 'budgeted') {
      assert.deepEqual(replay.orchestration.charged, { modelRequests: 1, outputTokens: 100, toolCalls: 0 });
      const stage = (await restarted.record(submitted.taskId)).orchestration.stages[0];
      assert.equal(stage.terminal, 'completed');
      assert.equal(stage.status, 'completed');
      assert.deepEqual(stage.budget, expectedReceipt);
    }
    assert.equal(replay.parentAcceptance, 'not_assessed');
    assert.equal(replay.deliveryValidation.status, 'structure_complete');
    assert.equal((await restarted.result({ taskId: submitted.taskId })).text, outputText);
    assert.equal((await restarted.record(submitted.taskId)).attempts.length, 1);
    assert.equal(launches, 1);
  });
}
