import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installBudget } from '../src/budget.js';
import { prepareRuntime, ROUTE } from '../src/sdk-runner.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function nativeGate(t, overrides = {}) {
  const home = await mkdtemp(join(tmpdir(), 'bridge-team-budget-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const handlers = new Map();
  const agents = new Map();
  agents.list = () => [...agents.values()];
  agents.isOwnedBy = (id, parent) => agents.get(id)?.owner === parent;
  const config = { nonce: 'team:1', budgetPath: join(home, 'budget.json'), armedPath: join(home, 'armed'),
    captainSessionId: 'captain', maxModelRequests: 4, maxTokens: 512, maxOutputTokens: 4096,
    maxRequestBytes: 32768, effort: 'high', checkpoint: { maxTokens: 128, softDeadline: Date.now() + 60000 }, ...overrides };
  let drains = 0;
  let drainBarrier;
  let lateMessages = [];
  const emit = (event, ...args) => handlers.get(event)?.(...args);
  const ctx = {
    agents, on: (event, handler) => { assert.equal(handlers.has(event), false, event); handlers.set(event, handler); },
    subagents: { drainDescendants(roots) {
      drains++;
      assert.deepEqual(roots, [agents.get('captain')]);
      const owned = new Set(roots);
      for (const parent of owned) for (const agent of agents.values()) if (agent.owner === parent) owned.add(agent);
      for (const agent of owned) if (!roots.includes(agent)) {
        agent.cancel({ kind: 'disposed' });
        emit('session/event', agent.session, { type: 'turn/end', data: { reason: { kind: 'aborted' } } });
        emit('agent/status', { agent, status: 'idle' });
        emit('agent/disposed', { agent });
      }
      agents.get('captain').inbox.nextStep.push(...lateMessages);
      return drainBarrier?.promise ?? Promise.resolve();
    } },
  };
  if (overrides.withoutSubagents) {
    ctx.get = () => undefined;
    Object.defineProperty(ctx, 'subagents', { get() { assert.fail('undeclared optional service property access'); } });
  }
  await installBudget(ctx, config);
  await writeFile(config.armedPath, config.nonce);
  const addAgent = (id, owner = agents.get('captain')) => {
    const controller = new AbortController();
    const agent = { id, owner, session: { id }, status: 'running', signal: controller.signal, cancel: cause => controller.abort(cause),
      inbox: { nextStep: [], nextTurn: [], removed: [], remove(messageId) {
        const index = this.nextStep.findIndex(message => message.id === messageId);
        if (index < 0) return false;
        this.removed.push(this.nextStep.splice(index, 1)[0]);
        return true;
      } } };
    agents.set(id, agent);
    emit('agent/created', { agent });
    return agent;
  };
  const captain = addAgent('captain');
  const child = overrides.withoutSubagents ? undefined : addAgent('child');
  const receipt = async () => JSON.parse(await readFile(config.budgetPath, 'utf8'));
  const assemble = async (agent, next) => {
    const assembly = { sections: [{ name: 'task', text: 'Do the bounded task.' }], tools: [{ name: 'status' }] };
    const result = await emit('system-prompt/assemble', assembly, { agent, signal: agent.signal }, next ?? (async () => assembly));
    const proposal = await emit('agent/request', { agent, signal: agent.signal }, async () => ({}));
    return { ...proposal, sessionId: agent.id, signal: agent.signal, system: result.sections.map(section => section.text).join('\n'), tools: result.tools,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'work' }] }] };
  };
  const stream = async (options, adapter = async function* () { yield { type: 'usage', usage: { outputTokens: 10 } }; yield { type: 'finish', reason: 'stop' }; }) => {
    for await (const chunk of emit('llm/stream', Object.freeze(options), adapter)) { /* consume */ }
  };
  return { config, captain, child, agents, addAgent, emit, assemble, stream, receipt, drains: () => drains, holdDrain: () => (drainBarrier = deferred()),
    lateMessages: messages => { lateMessages = messages; } };
}

test('prepared captain work keeps its mode when a child reaches the last reserved request', async t => {
  const g = await nativeGate(t);
  await g.stream(await g.assemble(g.captain));
  await g.stream(await g.assemble(g.child));
  g.emit('session/event', g.child.session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'partial finding' }] } } });
  const rootWork = await g.assemble(g.captain);
  assert.equal((await g.receipt()).modelRequests, 2, 'preparation does not charge usage');
  await assert.rejects(g.assemble(g.child));
  assert.equal(g.drains(), 1);
  assert.equal(rootWork.reasoningEffort, 'high');
  await g.stream(rootWork);
  const checkpoint = await g.assemble(g.captain);
  assert.equal(checkpoint.reasoningEffort, 'off');
  assert.equal(checkpoint.maxTokens, 128);
  assert.deepEqual(checkpoint.tools, []);
  assert.match(checkpoint.system, /"drained":true/);
  assert.match(checkpoint.system, /"turnEnd":"aborted"/);
  assert.match(checkpoint.system, /partial finding/);
  await g.stream(checkpoint);
  const receipt = await g.receipt();
  assert.equal(receipt.denied, null);
  assert.deepEqual(receipt.calls.map(call => [call.effort, call.checkpoint]), [['high', false], ['high', false], ['high', false], ['off', true]]);
  assert.deepEqual(receipt.childYields, [{ sessionId: 'child', reason: 'CAPTAIN_CHECKPOINT_RESERVE' }]);
});

test('captain checkpoint waits for descendant disposal, while yielding child never awaits its own drain', async t => {
  const g = await nativeGate(t, { checkpoint: { maxTokens: 128, softDeadline: 0 } });
  const barrier = g.holdDrain();
  await assert.rejects(g.assemble(g.child));
  let prepared = false;
  const root = g.assemble(g.captain).then(request => { prepared = true; return request; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(prepared, false);
  assert.equal((await g.receipt()).modelRequests, 0);
  barrier.resolve();
  await g.stream(await root);
  assert.equal((await g.receipt()).calls[0].checkpoint, true);
  assert.equal(g.drains(), 1);
});

test('prepared output is reserved across sessions, then transferred atomically while streams overlap', async t => {
  const g = await nativeGate(t, { maxOutputTokens: 1024 });
  const root = await g.assemble(g.captain);
  const child = await g.assemble(g.child);
  assert.equal(root.maxTokens, 512);
  assert.equal(child.maxTokens, 384);
  assert.equal((await g.receipt()).modelRequests, 0);
  const entered = deferred();
  const finish = deferred();
  const streamingRoot = g.stream(root, async function* () { entered.resolve(); await finish.promise; yield { type: 'finish', reason: 'stop' }; });
  await entered.promise;
  await g.stream(child);
  assert.equal((await g.receipt()).modelRequests, 2, 'streaming is not serialized behind the captain');
  finish.resolve();
  await streamingRoot;
  const receipt = await g.receipt();
  assert.deepEqual(receipt.calls.map(call => call.reservedOutputTokens), [512, 384]);
  assert.equal(receipt.denied, null);
});

test('abort, rejected step, idle no-step, disposal and assembly failure release uncharged preparation', async t => {
  for (const cleanup of ['abort', 'reject', 'idle', 'disposed', 'assembly-error', 'request-error']) {
    await t.test(cleanup, async t => {
      const g = await nativeGate(t, { maxModelRequests: 3 });
      const abandoned = await g.assemble(g.child);
      if (cleanup === 'abort') g.child.cancel({ kind: 'user' });
      if (cleanup === 'reject') await g.emit('agent/pre-step', { agent: g.child }, async () => ({ kind: 'reject' }));
      if (cleanup === 'idle') g.emit('agent/status', { agent: g.child, status: 'idle' });
      if (cleanup === 'disposed') g.emit('agent/disposed', { agent: g.child });
      if (cleanup === 'assembly-error') await assert.rejects(g.assemble(g.child, async () => { throw new Error('assembly failed'); }), /assembly failed/);
      if (cleanup === 'request-error') await assert.rejects(g.emit('agent/request', { agent: g.child }, async () => { throw new Error('request failed'); }), /request failed/);
      const root = await g.assemble(g.captain);
      assert.equal(root.reasoningEffort, 'high');
      const other = await g.assemble(g.addAgent('other'));
      assert.equal(other.reasoningEffort, 'high', 'abandoned preparation must not force a checkpoint');
      assert.equal((await g.receipt()).modelRequests, 0);
      if (cleanup === 'abort') await assert.rejects(g.stream(abandoned));
      assert.equal((await g.receipt()).denied, null);
    });
  }
});

test('a deadline crossing after preparation preserves admitted work and checkpoints the next captain request', async t => {
  const g = await nativeGate(t);
  const root = await g.assemble(g.captain);
  g.config.checkpoint.softDeadline = 0;
  await g.stream(root);
  await g.stream(await g.assemble(g.captain));
  assert.deepEqual((await g.receipt()).calls.map(call => call.checkpoint), [false, true]);
});

test('captain abort releases its wait without abandoning the shared descendant drain', async t => {
  const g = await nativeGate(t, { checkpoint: { maxTokens: 128, softDeadline: 0 } });
  const barrier = g.holdDrain();
  const root = g.assemble(g.captain);
  await new Promise(resolve => setImmediate(resolve));
  g.captain.cancel({ kind: 'user' });
  await assert.rejects(root);
  assert.equal((await g.receipt()).modelRequests, 0);
  assert.equal((await g.receipt()).denied, null);
  barrier.resolve();
});

test('a native files-only stage checkpoints with the optional subagent service absent', async t => {
  const g = await nativeGate(t, { withoutSubagents: true, checkpoint: { maxTokens: 128, forced: true } });
  const root = await g.assemble(g.captain);
  assert.match(root.system, /"drained":true,"children":\[\]/);
  await g.stream(root);
  assert.equal((await g.receipt()).calls[0].checkpoint, true);
  assert.equal((await g.receipt()).denied, null);
});

test('captain drain folds owned late native notices once and preserves unrelated inbox work', async t => {
  const g = await nativeGate(t, { checkpoint: { maxTokens: 128, softDeadline: 0 } });
  const message = (id, kind, senderSessionId = 'child', form = 'notice') => ({ id, source: { kind, form, senderSessionId },
    content: [{ type: 'text', text: `diagnostic ${id}` }] });
  const notice = message('settled-message', 'subagent-settled');
  const steering = message('user-steering', 'user');
  const unknown = message('unknown-child', 'subagent-settled', 'unrelated-session');
  const otherForm = message('other-form', 'subagent-settled', 'child', 'message');
  g.captain.inbox.nextTurn.push(message('next-turn', 'user'));
  g.lateMessages([notice, steering, unknown, otherForm]);
  const root = await g.assemble(g.captain);
  const evidence = (await g.receipt()).teamSettlement;
  assert.deepEqual(evidence.lateNotices, [{ messageId: 'settled-message', senderSessionId: 'child', text: 'diagnostic settled-message', textTruncated: false }]);
  assert.equal(root.system.split('"messageId":"settled-message"').length - 1, 1);
  assert.match(root.system, /diagnostic settled-message/);
  assert.deepEqual(g.captain.inbox.removed, [notice]);
  assert.deepEqual(g.captain.inbox.nextStep, [steering, unknown, otherForm]);
  assert.equal(g.captain.inbox.nextTurn[0].id, 'next-turn');
  await g.stream(root);
  assert.equal((await g.receipt()).denied, null);
});

test('captain coordination is configured only for native budgeted stages', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-captain-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [native, budgeted] of [[true, true], [true, false], [false, true]]) {
    const task = { taskId: 'task', sessionId: 'root-session', workspace: root, access: 'read-only', route: { ...ROUTE, effort: 'high' },
      attempts: [{ number: 1 }], ...(budgeted ? { stageBudget: { nonce: 'stage:1', maxOutputTokens: 4096, checkpointTokens: 128 } } : {}) };
    const profile = { access: 'read-only', tools: [], modules: [], skills: [], ...(native ? { native: { selected: ['files'] } } : {}) };
    const prepared = await prepareRuntime({ task, home: join(root, `${native}-${budgeted}`), env: {}, resolveCapabilities: async () => profile });
    const patch = JSON.parse(await readFile(prepared.options.patches[0], 'utf8'));
    const budget = patch.flatMap(entry => entry.insert ?? []).find(entry => entry.id === 'bridge-budget').config;
    assert.equal(budget.captainSessionId, native && budgeted ? 'root-session' : undefined);
  }
});

test('notice folding follows exact runtime ownership through grandchildren and excludes an unrelated fork', async t => {
  const g = await nativeGate(t, { checkpoint: { maxTokens: 128, forced: true } });
  g.addAgent('grandchild', g.child);
  const fork = g.addAgent('unrelated-fork', null);
  fork.session.parentSessionId = g.captain.id;
  const notice = id => ({ id: `notice-${id}`, source: { kind: 'subagent-settled', form: 'notice', senderSessionId: id }, content: [{ type: 'text', text: id }] });
  g.lateMessages([notice('child'), notice('grandchild'), notice('unrelated-fork')]);
  await g.assemble(g.captain);
  const settlement = (await g.receipt()).teamSettlement;
  assert.deepEqual(settlement.children.map(row => row.sessionId), ['child', 'grandchild']);
  assert.deepEqual(settlement.lateNotices.map(row => row.senderSessionId), ['child', 'grandchild']);
  assert.deepEqual(g.captain.inbox.nextStep.map(message => message.source.senderSessionId), ['unrelated-fork']);
  assert.equal(fork.signal.aborted, false);
});

test('a descendant published under a detached exact owner during drain remains known after disposal', async t => {
  const g = await nativeGate(t, { checkpoint: { maxTokens: 128, forced: true } });
  const barrier = g.holdDrain();
  const request = g.assemble(g.captain);
  await new Promise(resolve => setImmediate(resolve));
  g.agents.delete(g.child.id);
  const late = g.addAgent('late-descendant', g.child);
  g.emit('agent/disposed', { agent: late });
  g.agents.delete(late.id);
  g.captain.inbox.nextStep.push({ id: 'late-notice', source: { kind: 'subagent-settled', form: 'notice', senderSessionId: late.id }, content: [{ type: 'text', text: 'late diagnostic' }] });
  barrier.resolve();
  await request;
  assert.deepEqual((await g.receipt()).teamSettlement.lateNotices.map(row => row.senderSessionId), ['late-descendant']);
  assert.equal(g.captain.inbox.nextStep.length, 0);
});

test('unrelated same-ID agent and session events cannot overwrite captured owned-child evidence', async t => {
  const g = await nativeGate(t, { checkpoint: { maxTokens: 128, forced: true } });
  g.emit('agent/disposed', { agent: g.child });
  const replacement = g.addAgent('child', null);
  g.emit('agent/status', { agent: replacement, status: 'running' });
  g.emit('session/event', replacement.session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'unrelated replacement text' }] } } });
  await g.assemble(g.captain);
  const rows = (await g.receipt()).teamSettlement.children;
  assert.deepEqual(rows, [{ sessionId: 'child', status: 'disposed' }]);
  assert.equal(replacement.signal.aborted, false);
});
