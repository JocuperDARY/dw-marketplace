import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client';
import { TaskManager } from '../src/tasks.js';
import { createSdkRunner, workerEnvironment } from '../src/sdk-runner.js';
import { resolveNativeProfile } from '../src/native-profile.js';
import { resolveProfile } from '../src/capabilities.js';
import { createUserMessage } from '@deepseek-ai/dsh-llm/message';

async function until(probe, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (true) { const value = await probe(); if (value) return value; assert.ok(Date.now() < deadline, 'Expected state was not reached'); await delay(30); }
}
async function setup(t, modes) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-agent-sdk-')); const workspaces = [];
  const path = fileURLToPath(new URL('./fixtures/agent-model.js', import.meta.url));
  const digest = createHash('sha256').update(await readFile(path)).digest('hex');
  for (const [index] of modes.entries()) { const dir = join(root, `workspace-${index}`); await mkdir(dir); workspaces.push(await realpath(dir)); await writeFile(join(dir, 'input.txt'), 'bounded input'); }
  const resolveCapabilities = async (id, _env, selection) => {
    const profile = id === 'inference-only' ? await resolveProfile(id, {}, selection) : await resolveNativeProfile({}, selection);
    const index = workspaces.indexOf(selection.workspace);
    profile.modules.push({ path, sha256: digest, tools: [], native: true,
      config: { receipt: join(selection.workspace, 'requests.json'), ...modes[index],
        ...(modes[index]?.closingBarrier ? { closingBarrier: join(selection.workspace, 'closing') } : {}),
        ...(modes[index]?.barrier ? { barrier: join(selection.workspace, 'release') } : {}) } });
    return profile;
  };
  const runner = createSdkRunner({ resolveCapabilities, env: { ...workerEnvironment(), DEEPSEEK_API_KEY: 'offline-synthetic-not-a-secret' },
    clientFactory: options => new HarnessClient({ ...options, env: { ...options.env,
      NODE_OPTIONS: `${options.env.NODE_OPTIONS ?? ''} --import=${new URL('./fixtures/offline-network.js', import.meta.url).href}` } }) });
  const create = () => new TaskManager({ dataDir: join(root, 'state'), runner, resolveCapabilities }).open();
  const a = await create(); const b = await create();
  t.after(async () => { await Promise.all([a.close(), b.close()]); if (t.passed) await rm(root, { recursive: true, force: true }); else t.diagnostic(`Retained: ${root}`); });
  const spawn = (manager, index, extra = {}) => manager.spawnAgent({ requestId: `spawn-${index}`, workspace: workspaces[index], prompt: 'Do the assigned offline task; retain parent constraints.',
    executionMode: 'automatic', capabilityProfile: 'native', nativePlugins: [], effort: 'off', ...extra });
  const requests = async index => { try { return JSON.parse(await readFile(join(workspaces[index], 'requests.json'), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
  return { root, workspaces, a, b, spawn, requests };
}

test('official SDK parent question, idle queue, waking reply and durable event cursors', { timeout: 90000 }, async t => {
  const f = await setup(t, [{ question: true }]); const first = await f.spawn(f.a, 0);
  const done = await f.a.wait({ taskId: first.agentId, timeoutMs: 30000 });
  assert.equal(done.status, 'paused', JSON.stringify(done));
  await until(async () => (await f.a.agents.journal(await f.a.record(first.agentId)).read()).availability === 'needs_input');
  const update = await f.b.waitAgents({ targets: [{ agentId: first.agentId }], timeoutMs: 0 });
  const question = update.updates[0].events.find(event => event.kind === 'question_open'); assert.ok(question);
  const before = (await f.requests(0)).length;
  await assert.rejects(f.b.sendMessage({ agentId: first.agentId, requestId: 'foreign', text: 'Unauthorized' }), { code: 'NOT_OWNER' });
  const message = await f.a.sendMessage({ agentId: first.agentId, requestId: 'queue', text: 'DO_NOT_RETRAIN' });
  assert.equal(message.availability, 'needs_input'); assert.equal((await f.requests(0)).length, before);
  await f.b.followupTask({ agentId: first.agentId, controlToken: first.controlToken, requestId: 'answer', replyTo: question.messageId, text: 'ANSWER_COLOR_BLUE' });
  assert.equal((await f.b.wait({ taskId: first.agentId, timeoutMs: 30000 })).status, 'completed');
  const result = await f.b.result({ taskId: first.agentId }); assert.match(result.text, /"blue":true/); assert.match(result.text, /"noRetrain":true/);
  assert.equal((await f.requests(0)).length, before + 1);
  const tail = await f.a.waitAgents({ targets: [{ agentId: first.agentId, afterCursor: update.updates[0].cursor }], timeoutMs: 0 });
  assert.ok(tail.updates[0].events.length); assert.equal(tail.errors.length, 0);
});

test('runtime close waits for the closing writer to release its transaction lock', { timeout: 90000 }, async t => {
  const f = await setup(t, [{ closingBarrier: true }]); const agent = await f.spawn(f.a, 0);
  const gate = join(f.workspaces[0], 'closing');
  try {
    await until(async () => { try { return await readFile(gate + '.entered', 'utf8'); } catch (error) { if (error.code === 'ENOENT') return false; throw error; } });
    const journal = f.a.agents.journal(await f.a.record(agent.agentId));
    assert.equal((await journal.read()).runtime.status, 'closing');
    const owner = await readFile(join(journal.directory, 'transaction.lock'), 'utf8');
    await delay(100);
    assert.equal(await readFile(join(journal.directory, 'transaction.lock'), 'utf8'), owner);
    assert.equal((await f.a.status({ taskId: agent.agentId })).status, 'running');
  } finally { await writeFile(gate + '.release', 'release owned writer'); }
  const done = await f.a.wait({ taskId: agent.agentId, timeoutMs: 30000 });
  assert.equal(done.status, 'completed', JSON.stringify(done));
  assert.equal(done.cleanup, 'confirmed');
  const journal = f.a.agents.journal(await f.a.record(agent.agentId));
  await until(async () => (await journal.read()).runtime === null);
  await assert.rejects(readFile(join(journal.directory, 'transaction.lock')), { code: 'ENOENT' });
});

test('official SDK running inject and steer stay in one activity and preserve frozen input revisions', { timeout: 90000 }, async t => {
  const f = await setup(t, [{ barrier: true, readStep: true }]);
  const first = await f.spawn(f.a, 0);
  await until(async () => (await f.requests(0)).length === 1);
  await f.a.sendMessage({ agentId: first.agentId, requestId: 'inject', text: 'DO_NOT_RETRAIN' });
  await f.b.followupTask({ agentId: first.agentId, controlToken: first.controlToken, requestId: 'steer', text: 'ANSWER_COLOR_BLUE' });
  await writeFile(join(f.workspaces[0], 'release'), 'continue');
  const done = await f.a.wait({ taskId: first.agentId, timeoutMs: 30000 });
  assert.equal(done.status, 'completed', JSON.stringify(done)); assert.equal(done.number, 1);
  const requests = await f.requests(0); assert.equal(requests.length, 2);
  assert.doesNotMatch(JSON.stringify(requests[0].messages), /DO_NOT_RETRAIN/);
  assert.match(JSON.stringify(requests[1].messages), /DO_NOT_RETRAIN/);
  assert.match(JSON.stringify(requests[1].messages), /ANSWER_COLOR_BLUE/);
});

test('two independent SDK workers: interrupt A, finish B, resume A without resetting ownership or usage', { timeout: 90000 }, async t => {
  const f = await setup(t, [{ barrier: true }, { barrier: true, readStep: true }]);
  const [a, b] = await Promise.all([f.spawn(f.a, 0), f.spawn(f.b, 1)]);
  await until(async () => (await f.requests(0)).length === 1 && (await f.requests(1)).length === 1);
  await f.a.sendMessage({ agentId: a.agentId, requestId: 'keep-after-stop', text: 'DO_NOT_RETRAIN' });
  const requested = await f.a.interruptAgent({ agentId: a.agentId, requestId: 'interrupt-A', waitTimeoutMs: 30000 });
  assert.equal(requested.activityStopped, true, JSON.stringify(requested));
  assert.equal(requested.descendantsStopped, true); assert.equal(requested.runtimeCleanup, 'confirmed');
  assert.equal((await f.b.status({ taskId: b.agentId })).status, 'running');
  await writeFile(join(f.workspaces[1], 'release'), 'continue B');
  assert.equal((await f.b.wait({ taskId: b.agentId, timeoutMs: 30000 })).status, 'completed');
  await f.b.followupTask({ agentId: a.agentId, controlToken: a.controlToken, requestId: 'resume-A', text: 'RESUME_AFTER_INTERRUPT' });
  const replayed = await f.a.interruptAgent({ agentId: a.agentId, requestId: 'interrupt-A' });
  assert.equal(replayed.duplicate, true); assert.equal(replayed.targetActivityId, `${a.agentId}:1`);
  assert.equal((await f.a.agents.journal(await f.a.record(a.agentId)).read()).interrupt, null);
  const final = await f.b.wait({ taskId: a.agentId, timeoutMs: 30000 });
  assert.equal(final.status, 'completed', JSON.stringify(final)); assert.equal(final.number, 2);
  const result = await f.b.result({ taskId: a.agentId }); assert.match(result.text, /"resumed":true/); assert.match(result.text, /"noRetrain":true/);
  assert.equal((await f.b.record(a.agentId)).attempts[0].status, 'interrupted');
  assert.equal((await f.requests(1)).length, 2);
});

test('legacy continue enters the persistent agent journal and survives a later followup', { timeout: 90000 }, async t => {
  const f = await setup(t, [{}]); const agent = await f.spawn(f.a, 0);
  await f.a.wait({ taskId: agent.agentId, timeoutMs: 30000 });
  await f.a.continue({ taskId: agent.agentId, requestId: 'legacy-continue', prompt: 'DO_NOT_RETRAIN' });
  assert.equal((await f.a.wait({ taskId: agent.agentId, timeoutMs: 30000 })).status, 'completed');
  await f.b.followupTask({ agentId: agent.agentId, controlToken: agent.controlToken, requestId: 'new-followup', text: 'Only revise report wording.' });
  assert.equal((await f.b.wait({ taskId: agent.agentId, timeoutMs: 30000 })).status, 'completed');
  assert.match(JSON.stringify((await f.requests(0)).at(-1).messages), /DO_NOT_RETRAIN/);
  assert.ok((await f.b.agents.journal(await f.b.record(agent.agentId)).context()).entries.some(item => item.text === 'DO_NOT_RETRAIN'));
});

test('twelve alternating activities retain explicit constraints across two chats and an ownership handoff', { timeout: 180000 }, async t => {
  const f = await setup(t, [{}, {}]);
  const [a, b] = await Promise.all([f.spawn(f.a, 0), f.spawn(f.b, 1)]);
  await Promise.all([f.a.wait({ taskId: a.agentId, timeoutMs: 30000 }), f.b.wait({ taskId: b.agentId, timeoutMs: 30000 })]);
  for (let round = 1; round <= 12; round++) {
    const jobs = [[a, f.a], [b, f.b]].map(async ([agent, owner]) => {
      const sender = round % 2 ? owner : owner === f.a ? f.b : f.a;
      await sender.followupTask({ agentId: agent.agentId, controlToken: agent.controlToken, requestId: `round-${round}`,
        text: round === 1 ? 'DO_NOT_RETRAIN; retain this for every subsequent correction.' : `Correct report item ${round} without repeating completed work.` });
      // A receipt can be queued behind terminal publication/lease release.
      // Wait for this activity rather than accepting the previous final again.
      await until(async () => (await sender.status({ taskId: agent.agentId })).number === round + 1);
      assert.equal((await sender.wait({ taskId: agent.agentId, timeoutMs: 30000 })).status, 'completed');
      const result = await sender.result({ taskId: agent.agentId }); assert.match(result.text, /"noRetrain":true/);
    });
    await Promise.all(jobs);
  }
  assert.equal((await f.requests(0)).length, 13); assert.equal((await f.requests(1)).length, 13);
  const listed = await f.a.listAgents({ scope: 'store' }); assert.equal(listed.agents.length, 2);
  assert.ok(listed.agents.every(agent => agent.pendingMessageCount === 0 && agent.parentAcceptance === 'not_assessed'));
});

test('single-request and zero-tool workers gain no communication tool or hidden extra inference', { timeout: 90000 }, async t => {
  const f = await setup(t, [{}, {}]);
  const zero = await f.spawn(f.a, 0, { maxToolCalls: 0 });
  assert.equal((await f.a.wait({ taskId: zero.agentId, timeoutMs: 30000 })).status, 'completed');
  assert.ok(!(await f.requests(0))[0].tools.includes('bridge_send_message'));
  // Single-request uses the same guarded public entry but cannot opt into native communication.
  await assert.rejects(f.a.spawnAgent({ requestId: 'single-invalid', workspace: f.workspaces[0], prompt: 'one request',
    executionMode: 'single-request', communication: 'native' }), { code: 'COMMUNICATION_DISABLED' });
  const single = await f.a.spawnAgent({ requestId: 'single-valid', workspace: f.workspaces[1], prompt: 'Return one final response.', executionMode: 'single-request' });
  assert.equal((await f.a.wait({ taskId: single.agentId, timeoutMs: 30000 })).status, 'completed');
  const requests = await f.requests(1); assert.equal(requests.length, 1); assert.equal((requests[0].tools ?? []).length, 0);
  for (const name of ['sendMessage', 'followupTask']) await assert.rejects(f.a[name]({ agentId: single.agentId,
    requestId: `single-${name}`, text: 'Another request' }), { code: 'COMMUNICATION_DISABLED' });
  assert.equal((await f.requests(1)).length, 1);
});

test('terminal publication keeps its lease until journal settlement and queues a foreign followup', { timeout: 90000 }, async t => {
  const f = await setup(t, [{}]); let release;
  const barrier = new Promise(resolve => { release = resolve; }); let entered = false;
  const finish = f.a.agents.afterActivity.bind(f.a.agents);
  f.a.agents.afterActivity = async (record, attempt) => {
    if (attempt.number === 1) { entered = true; await barrier; }
    return finish(record, attempt);
  };
  const agent = await f.spawn(f.a, 0);
  try {
    await until(() => entered);
    const before = await f.b.status({ taskId: agent.agentId });
    assert.equal(before.status, 'completed'); assert.equal(before.leasePending, true);
    const accepted = await f.b.followupTask({ agentId: agent.agentId, controlToken: agent.controlToken,
      requestId: 'handoff-race', text: 'DO_NOT_RETRAIN' });
    assert.equal(accepted.accepted, true); assert.equal(accepted.pendingMessageCount, 1);
    assert.equal((await f.requests(0)).length, 1);
  } finally { release(); }
  await until(async () => (await f.b.status({ taskId: agent.agentId })).number === 2);
  assert.equal((await f.b.wait({ taskId: agent.agentId, timeoutMs: 30000 })).status, 'completed');
  assert.equal((await f.requests(0)).length, 2);
  assert.match((await f.b.result({ taskId: agent.agentId })).text, /"noRetrain":true/);
});

test('an explicit post-interruption followup survives the old lease release window', { timeout: 90000 }, async t => {
  const f = await setup(t, [{ barrier: true }]); let release;
  const barrier = new Promise(resolve => { release = resolve; }); let entered = false;
  const releaseLease = f.a.store.release.bind(f.a.store);
  f.a.store.release = async (...args) => { entered = true; await barrier; return releaseLease(...args); };
  const agent = await f.spawn(f.a, 0);
  await until(async () => (await f.requests(0)).length === 1);
  await f.a.sendMessage({ agentId: agent.agentId, requestId: 'before-stop', text: 'DO_NOT_RETRAIN' });
  await f.a.interruptAgent({ agentId: agent.agentId, requestId: 'stop-for-handoff' });
  try {
    await until(() => entered);
    const journal = f.a.agents.journal(await f.a.record(agent.agentId));
    assert.equal((await journal.read()).availability, 'interrupted');
    assert.equal((await f.b.status({ taskId: agent.agentId })).leasePending, true);
    const resumed = await f.b.followupTask({ agentId: agent.agentId, controlToken: agent.controlToken,
      requestId: 'after-stop-explicit', text: 'RESUME_AFTER_INTERRUPT' });
    assert.equal(resumed.accepted, true); assert.equal((await f.requests(0)).length, 1);
  } finally { release(); }
  await until(async () => (await f.b.status({ taskId: agent.agentId })).number === 2);
  assert.equal((await f.b.wait({ taskId: agent.agentId, timeoutMs: 30000 })).status, 'completed');
  assert.equal((await f.requests(0)).length, 2);
});

test('connection close waits for deferred-wake evidence and leaves no background journal writes', { timeout: 90000 }, async t => {
  const f = await setup(t, [{}]); let release; let entered = false;
  const barrier = new Promise(resolve => { release = resolve; });
  f.a.agents.wake = async () => { throw new Error('Synthetic admission unavailable'); };
  const openJournal = f.a.agents.journal.bind(f.a.agents);
  f.a.agents.journal = record => {
    const journal = openJournal(record); const transact = journal.transaction.bind(journal);
    journal.transaction = (operation, options) => transact(async tx => {
      const emit = tx.emit; tx.emit = async (...args) => {
        if (args[0] === 'wake_deferred') { entered = true; await barrier; }
        return emit(...args);
      };
      return operation(tx);
    }, options);
    return journal;
  };
  const agent = await f.spawn(f.a, 0); let closed = false;
  try {
    await until(() => entered);
    const closing = f.a.close().then(() => { closed = true; });
    await delay(50); assert.equal(closed, false, 'close must await pending evidence publication');
    release(); await closing;
    const record = await f.b.record(agent.agentId);
    assert.ok((await f.b.agents.journal(record).events()).events.some(item => item.kind === 'wake_deferred'));
  } finally { release(); }
});

test('concurrent identical followups wake once and explicit supersession survives real SDK resume', { timeout: 90000 }, async t => {
  const f = await setup(t, [{}]); const agent = await f.spawn(f.a, 0);
  await f.a.wait({ taskId: agent.agentId, timeoutMs: 30000 });
  const original = await f.a.sendMessage({ agentId: agent.agentId, requestId: 'old-rule', text: 'OLD_RULE_SENTINEL' });
  const replacement = await f.a.sendMessage({ agentId: agent.agentId, requestId: 'new-rule', text: 'NEW_RULE_SENTINEL',
    change: 'replace', targetMessageIds: [original.messageId], expectedContextRevision: original.contextRevision });
  await f.a.sendMessage({ agentId: agent.agentId, requestId: 'one-turn', text: 'ONE_ACTIVITY_SENTINEL', scope: 'turn' });
  const args = { agentId: agent.agentId, controlToken: agent.controlToken, requestId: 'same-wake', text: 'Consume pending input.' };
  const receipts = await Promise.all([f.a.followupTask(args), f.b.followupTask(args)]);
  assert.equal(receipts[0].messageId, receipts[1].messageId);
  assert.equal((await f.a.wait({ taskId: agent.agentId, timeoutMs: 30000 })).status, 'completed');
  assert.equal((await f.requests(0)).length, 2);
  const journal = f.a.agents.journal(await f.a.record(agent.agentId));
  await until(async () => (await journal.read()).availability === 'idle');
  const context = await journal.context();
  assert.equal(context.entries.find(item => item.id === original.messageId).status, 'inactive');
  assert.equal(context.entries.find(item => item.text === 'ONE_ACTIVITY_SENTINEL').status, 'inactive');
  await f.a.followupTask({ agentId: agent.agentId, requestId: 'retract-rule', change: 'retract',
    targetMessageIds: [replacement.messageId], expectedContextRevision: context.revision });
  assert.equal((await f.a.wait({ taskId: agent.agentId, timeoutMs: 30000 })).status, 'completed');
  const messages = (await f.requests(0)).at(-1).messages;
  const latest = messages.flatMap(message => message.source?.kind === 'runtime-context' ? message.source.sections ?? [] : [])
    .findLast(section => section.name === 'bridge:parent-context').text;
  assert.doesNotMatch(latest, /OLD_RULE_SENTINEL|NEW_RULE_SENTINEL|ONE_ACTIVITY_SENTINEL/);
});

for (const uncertain of [false, true]) test(`native prepared-message recovery ${uncertain ? 'stops unknown dispatch' : 'retains the original native identity'}`, { timeout: 90000 }, async t => {
  const f = await setup(t, [{}]); const agent = await f.spawn(f.a, 0);
  await f.a.wait({ taskId: agent.agentId, timeoutMs: 30000 });
  const pending = await f.a.sendMessage({ agentId: agent.agentId, requestId: 'prepared', text: 'DO_NOT_RETRAIN' });
  const journal = f.a.agents.journal(await f.a.record(agent.agentId));
  const message = createUserMessage({ content: [{ type: 'text', text: 'DO_NOT_RETRAIN' }], source: { kind: 'bridge-parent', bridgeMessageId: pending.messageId } });
  await writeFile(join(journal.directory, 'native', `${pending.messageId}.json`), JSON.stringify({ epoch: 'old-runtime', dispatchStarted: uncertain, message }));
  const before = (await f.requests(0)).length;
  await f.a.followupTask({ agentId: agent.agentId, requestId: 'recover', text: 'Continue the same task.' });
  const final = await f.a.wait({ taskId: agent.agentId, timeoutMs: 30000 });
  if (uncertain) {
    assert.equal(final.status, 'failed'); assert.equal((await f.requests(0)).length, before);
    const state = await journal.read(); assert.equal(state.recoveryRequired, true);
    assert.equal(state.pending.find(item => item.messageId === pending.messageId).delivery, 'deliveryUnknown');
  } else {
    assert.equal(final.status, 'completed', JSON.stringify(final)); assert.equal((await f.requests(0)).length, before + 1);
    const events = await journal.events();
    assert.ok(events.events.some(event => event.kind === 'message_enqueued' && event.nativeMessageId === message.id));
  }
});
