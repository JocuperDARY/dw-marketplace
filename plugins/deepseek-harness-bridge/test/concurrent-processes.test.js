import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixturePath = fileURLToPath(new URL('./fixtures/concurrent-host.mjs', import.meta.url));
const LIMIT = 15000;

class Host {
  constructor(state) {
    this.events = [];
    this.waiters = new Set();
    this.requests = new Map();
    this.sequence = 0;
    this.stderr = '';
    this.child = fork(fixturePath, [state], { execPath: process.execPath,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'], execArgv: [] });
    this.exited = new Promise(resolve => this.child.once('exit', resolve));
    this.child.on('message', value => {
      this.events.push(value);
      for (const check of [...this.waiters]) check();
    });
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', (code, signal) => this.fail(new Error(`Fixture exited ${code ?? signal}; ${this.stderr}`)));
    this.child.stderr.on('data', data => { this.stderr += data.toString(); });
    let buffered = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      buffered += chunk;
      let end;
      while ((end = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); }
        catch { this.fail(new Error(`Fixture emitted invalid MCP JSON: ${line}`)); continue; }
        const request = this.requests.get(message.id);
        if (!request) continue;
        this.requests.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
        else request.resolve(message.result);
      }
    });
  }

  fail(error) {
    this.failure = error;
    for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(error); }
    this.requests.clear();
    for (const check of [...this.waiters]) check();
  }

  event(name, predicate = () => true) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(check); reject(new Error(`Timed out awaiting ${name}; ${this.stderr}`)); }, LIMIT);
      const check = () => {
        const found = this.events.find(value => value.event === name && predicate(value));
        if (!found && !this.failure) return;
        clearTimeout(timer);
        this.waiters.delete(check);
        if (found) resolve(found); else reject(this.failure);
      };
      this.waiters.add(check);
      check();
    });
  }

  rpc(method, params) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      if (this.failure) { reject(this.failure); return; }
      const timer = setTimeout(() => { this.requests.delete(id); reject(new Error(`MCP ${method} timed out; ${this.stderr}`)); }, LIMIT);
      this.requests.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async open() {
    await this.event('ready');
    await this.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'offline-process-test', version: '1' } });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    return this;
  }

  async call(method, input = {}) {
    const response = await this.rpc('tools/call', { name: `dsh_${method}`, arguments: input });
    const value = response.structuredContent ?? JSON.parse(response.content[0].text);
    if (response.isError) throw Object.assign(new Error(value.error.message), value.error);
    return value;
  }

  release(run, outcome = {}) { this.child.send({ type: 'release', runId: run.runId, outcome }); }
  started(task) { return this.event('runner-started', value => value.taskId === task.taskId); }
  async close() {
    if (this.closed) { await this.exited; return; }
    this.closed = true;
    // Fixture cleanup releases only runner gates owned by this exact child.
    for (const run of this.events.filter(value => value.event === 'runner-started')) {
      if (this.child.connected) this.release(run, { terminal: 'aborted', text: 'test teardown', cleanup: 'confirmed' });
    }
    if (!this.child.connected) { await this.exited; return; }
    this.child.send({ type: 'close', id: 'close' });
    try { await this.event('closed'); }
    finally { if (this.child.exitCode === null) this.child.kill(); await this.exited; }
  }
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-processes-'));
  const state = join(root, 'state');
  const workspace = join(root, 'workspace');
  const another = join(root, 'another');
  await Promise.all([mkdir(workspace), mkdir(another)]);
  const hosts = [];
  t.after(async () => {
    await Promise.all(hosts.map(host => host.close()));
    await rm(root, { recursive: true, force: true });
  });
  const host = async () => { const value = new Host(state); hosts.push(value); return value.open(); };
  const input = (requestId, extra = {}) => ({ requestId, prompt: 'Offline isolated task', workspace,
    executionMode: 'single-request', ...extra });
  return { root, state, workspace, another, host, input };
}

test('two MCP host processes overlap, observe committed state and keep output and usage isolated', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const a = await f.host();
  const first = await a.call('submit', f.input('parallel-a'));
  assert.equal(typeof first.controlToken, 'string');
  assert.ok(first.controlToken.length >= 32);
  const runningA = await a.started(first);
  const b = await f.host();
  assert.notEqual(a.child.pid, b.child.pid);
  assert.equal((await b.call('status', { taskId: first.taskId })).status, 'running');
  const second = await b.call('submit', f.input('parallel-b'));
  const runningB = await b.started(second);
  // Both runner-started events exist before either gate is released.
  assert.equal((await a.call('status', { taskId: first.taskId })).status, 'running');
  assert.equal((await a.call('status', { taskId: second.taskId })).status, 'running');
  const all = await b.call('list', { scope: 'store' });
  assert.deepEqual(new Set(all.activeTaskIds), new Set([first.taskId, second.taskId]));
  assert.deepEqual((await a.call('list')).activeTaskIds, [first.taskId]);
  assert.deepEqual((await b.call('list')).activeTaskIds, [second.taskId]);
  for (const observation of [all, await b.call('usage', { scope: 'store' }), await b.call('status', { taskId: first.taskId }), runningA.task]) {
    assert.ok(!JSON.stringify(observation).includes(first.controlToken));
    assert.ok(!JSON.stringify(observation).includes('controlTokenHash'));
  }
  a.release(runningA, { text: 'only A', usage: { inputTokens: 10, outputTokens: 7, totalTokens: 17 },
    budget: { modelRequests: 1, calls: [{ number: 1, finished: true, usage: { inputTokens: 10, outputTokens: 7, totalTokens: 17 } }] } });
  b.release(runningB, { text: 'only B', budget: { modelRequests: 1, calls: [{ number: 1, finished: true, usage: { inputTokens: 20, outputTokens: 11, totalTokens: 31 } }] } });
  assert.equal((await a.call('wait', { taskId: first.taskId, timeoutMs: 3000 })).status, 'completed');
  assert.equal((await b.call('wait', { taskId: second.taskId, timeoutMs: 3000 })).status, 'completed');
  assert.equal((await b.call('result', { taskId: first.taskId })).text, 'only A');
  assert.equal((await a.call('result', { taskId: second.taskId })).text, 'only B');
  assert.equal((await a.call('usage', { taskId: first.taskId })).tokens.totalTokens.reported, 17);
  assert.equal((await b.call('usage', { taskId: second.taskId })).tokens.totalTokens.reported, 31);
  assert.equal((await a.call('usage')).tokens.totalTokens.reported, 17);
  assert.equal((await b.call('usage')).tokens.totalTokens.reported, 31);
  assert.equal((await b.call('usage', { scope: 'store' })).tokens.totalTokens.reported, 48);
});

test('cross-process request replay launches once and conflicting input never executes', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([f.host(), f.host()]);
  const input = f.input('same-request');
  const receipts = await Promise.all([a.call('submit', input), b.call('submit', input)]);
  assert.equal(receipts[0].taskId, receipts[1].taskId);
  assert.equal(receipts.filter(value => value.duplicate).length, 1);
  assert.equal(receipts.filter(value => typeof value.controlToken === 'string').length, 1);
  const owner = receipts[0].duplicate ? b : a;
  const observer = owner === a ? b : a;
  const run = await owner.started(receipts[0]);
  await assert.rejects(observer.call('submit', { ...input, prompt: 'Conflicting input' }), { code: 'REQUEST_CONFLICT' });
  assert.equal(owner.events.filter(value => value.event === 'runner-started').length, 1);
  assert.equal(observer.events.filter(value => value.event === 'runner-started').length, 0);
  owner.release(run);
  assert.equal((await observer.call('wait', { taskId: receipts[0].taskId, timeoutMs: 3000 })).status, 'completed');
});

test('two processes retain independent authorized totals and charge only their own budgeted stages', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([f.host(), f.host()]);
  const budgetA = { totalModelRequests: 1, totalOutputTokens: 101, totalToolCalls: 0 };
  const budgetB = { totalModelRequests: 5, totalOutputTokens: 4000, totalToolCalls: 0 };
  const common = { executionMode: 'budgeted', capabilityProfile: 'inference-only', maxTokens: 512, maxModelRequests: 1 };
  const first = await a.call('submit', f.input('budget-a', { ...common, budget: budgetA }));
  const second = await b.call('submit', f.input('budget-b', { ...common, budget: budgetB }));
  const [runA, runB] = await Promise.all([a.started(first), b.started(second)]);
  assert.notEqual(runA.task.stageBudget.nonce, runB.task.stageBudget.nonce);
  a.release(runA, { text: JSON.stringify({ state: 'completed', summary: 'A deliverable', nextSteps: '' }),
    usage: { inputTokens: 10, outputTokens: 101, totalTokens: 111 } });
  const doneA = await b.call('wait', { taskId: first.taskId, timeoutMs: 3000 });
  assert.equal(doneA.status, 'completed');
  await assert.rejects(a.call('continue', { taskId: first.taskId, requestId: 'exhausted-a', prompt: 'More' }), { code: 'TOTAL_BUDGET_EXHAUSTED' });
  const stillRunningB = await a.call('status', { taskId: second.taskId });
  assert.equal(stillRunningB.status, 'running');
  assert.equal(stillRunningB.orchestration.authorized.totalOutputTokens, 4000);
  b.release(runB, { text: JSON.stringify({ state: 'completed', summary: 'B deliverable', nextSteps: '' }),
    usage: { inputTokens: 20, outputTokens: 203, totalTokens: 223 } });
  const doneB = await a.call('wait', { taskId: second.taskId, timeoutMs: 3000 });
  assert.equal(doneB.status, 'completed');
  assert.equal(doneA.orchestration.authorized.totalOutputTokens, 101);
  assert.equal(doneB.orchestration.authorized.totalOutputTokens, 4000);
  assert.deepEqual(doneA.orchestration.charged, { modelRequests: 1, outputTokens: 101, toolCalls: 0 });
  assert.deepEqual(doneB.orchestration.charged, { modelRequests: 1, outputTokens: 203, toolCalls: 0 });
  assert.equal(doneA.orchestration.remaining.outputTokens, 0);
  assert.equal(doneB.orchestration.remaining.outputTokens, 3797);
  assert.equal((await b.call('usage', { scope: 'store' })).orchestrationCharged.outputTokens, 304);
});

test('foreign control needs a capability and cancellation confirms the actual owner teardown', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([f.host(), f.host()]);
  const first = await a.call('submit', f.input('cancel-a'));
  const second = await b.call('submit', f.input('unaffected-b'));
  const [runA, runB] = await Promise.all([a.started(first), b.started(second)]);
  for (const controlToken of [undefined, 'x'.repeat(43)]) {
    await assert.rejects(b.call('cancel', { taskId: first.taskId, ...(controlToken ? { controlToken } : {}) }), { code: 'NOT_OWNER' });
  }
  assert.equal((await a.call('status', { taskId: first.taskId })).status, 'running');
  const pending = await b.call('cancel', { taskId: first.taskId, controlToken: first.controlToken, timeoutMs: 0 });
  await a.event('runner-aborted', value => value.taskId === first.taskId);
  assert.ok(['running', 'cancelling'].includes(pending.status));
  assert.ok(['running', 'cancelling'].includes((await b.call('status', { taskId: first.taskId })).status));
  assert.equal((await b.call('status', { taskId: second.taskId })).status, 'running');
  a.release(runA, { terminal: 'aborted', text: 'A cleanup complete', cleanup: 'confirmed' });
  const done = await b.call('wait', { taskId: first.taskId, timeoutMs: 3000 });
  assert.equal(done.status, 'cancelled');
  assert.equal(done.cleanup, 'confirmed');
  b.release(runB, { text: 'B finished independently' });
  assert.equal((await b.call('wait', { taskId: second.taskId, timeoutMs: 3000 })).status, 'completed');
});

test('same-task continuation races launch at most one new attempt across processes', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([f.host(), f.host()]);
  const first = await a.call('submit', f.input('initial-conversation', { executionMode: 'automatic', capabilityProfile: 'inference-only' }));
  a.release(await a.started(first));
  assert.equal((await a.call('wait', { taskId: first.taskId, timeoutMs: 3000 })).status, 'completed');
  await assert.rejects(b.call('continue', { taskId: first.taskId, requestId: 'unauthorized', prompt: 'More' }), { code: 'NOT_OWNER' });
  const request = { taskId: first.taskId, prompt: 'Continue offline', controlToken: first.controlToken };
  const results = await Promise.allSettled([a.call('continue', { ...request, requestId: 'race-a' }), b.call('continue', { ...request, requestId: 'race-b' })]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(results.filter(value => value.status === 'rejected').length, 1);
  assert.equal(results.find(value => value.status === 'rejected').reason.code, 'TASK_BUSY');
  const current = await b.call('status', { taskId: first.taskId });
  assert.equal(current.number, 2);
  const winner = results[0].status === 'fulfilled' ? a : b;
  const run = await winner.event('runner-started', value => value.taskId === first.taskId && value.resume);
  winner.release(run);
  assert.equal((await a.call('wait', { taskId: first.taskId, timeoutMs: 3000 })).status, 'completed');
  const attempts = (await a.call('usage', { taskId: first.taskId })).attempts;
  assert.equal(attempts, 2);
});

test('closing one host aborts its owned work while the other host keeps running', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([f.host(), f.host()]);
  const first = await a.call('submit', f.input('close-a'));
  const second = await b.call('submit', f.input('close-b'));
  const [runA, runB] = await Promise.all([a.started(first), b.started(second)]);
  a.child.send({ type: 'close', id: 'explicit-close' });
  await a.event('runner-aborted', value => value.taskId === first.taskId);
  assert.equal((await b.call('status', { taskId: second.taskId })).status, 'running');
  a.release(runA, { terminal: 'aborted', cleanup: 'confirmed' });
  await a.event('closed', value => value.id === 'explicit-close');
  a.closed = true;
  assert.equal((await b.call('status', { taskId: first.taskId })).status, 'cancelled');
  assert.equal((await b.call('status', { taskId: second.taskId })).status, 'running');
  b.release(runB);
  assert.equal((await b.call('wait', { taskId: second.taskId, timeoutMs: 3000 })).status, 'completed');
});

test('workspace write conflicts reject while independent and shared read-only tasks remain available', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([f.host(), f.host()]);
  const input = f.input('writer', { executionMode: 'automatic', capabilityProfile: 'inference-only', access: 'workspace-write' });
  const writer = await a.call('submit', input);
  const run = await a.started(writer);
  await assert.rejects(b.call('submit', f.input('blocked-reader')), { code: 'WORKSPACE_BUSY' });
  await assert.rejects(b.call('submit', { ...input, requestId: 'blocked-writer' }), { code: 'WORKSPACE_BUSY' });
  const independent = await b.call('submit', f.input('independent', { workspace: f.another }));
  const independentRun = await b.started(independent);
  assert.equal((await a.call('status', { taskId: writer.taskId })).status, 'running');
  a.release(run);
  b.release(independentRun);
  await a.call('wait', { taskId: writer.taskId, timeoutMs: 3000 });
  const [readA, readB] = await Promise.all([a.call('submit', f.input('read-a')), b.call('submit', f.input('read-b'))]);
  const [readRunA, readRunB] = await Promise.all([a.started(readA), b.started(readB)]);
  assert.equal((await a.call('status', { taskId: readA.taskId })).status, 'running');
  assert.equal((await b.call('status', { taskId: readB.taskId })).status, 'running');
  a.release(readRunA);
  b.release(readRunB);
});

test('unverified teardown quarantines the affected workspace without blocking another host workspace', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([f.host(), f.host()]);
  const bad = await a.call('submit', f.input('unknown-cleanup', { executionMode: 'automatic', capabilityProfile: 'inference-only', access: 'workspace-write' }));
  const independent = await b.call('submit', f.input('safe-independent', { workspace: f.another }));
  const [badRun, independentRun] = await Promise.all([a.started(bad), b.started(independent)]);
  a.release(badRun, { terminal: 'error', cleanup: 'unverified', text: '' });
  assert.equal((await b.call('wait', { taskId: bad.taskId, timeoutMs: 3000 })).status, 'cleanup_failed');
  await assert.rejects(b.call('submit', f.input('quarantined')), { code: 'WORKSPACE_BUSY' });
  assert.equal((await b.call('status', { taskId: independent.taskId })).status, 'running');
  b.release(independentRun, { text: 'independent success' });
  assert.equal((await b.call('wait', { taskId: independent.taskId, timeoutMs: 3000 })).status, 'completed');
  const next = await b.call('submit', f.input('still-available', { workspace: f.another }));
  b.release(await b.started(next));
  assert.equal((await b.call('wait', { taskId: next.taskId, timeoutMs: 3000 })).status, 'completed');
});

test('a legacy exclusive owner lock prevents new host mutation and remains byte-for-byte intact', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await mkdir(f.state);
  const lock = JSON.stringify({ pid: process.pid, instanceId: 'offline-old-host', startedAt: new Date().toISOString() });
  await writeFile(join(f.state, 'owner.lock'), lock);
  const b = await f.host();
  await assert.rejects(b.call('submit', f.input('old-host-guard')), { code: 'UPGRADE_REQUIRED' });
  assert.equal(await readFile(join(f.state, 'owner.lock'), 'utf8'), lock);
  assert.equal(b.events.filter(value => value.event === 'runner-started').length, 0);
});
