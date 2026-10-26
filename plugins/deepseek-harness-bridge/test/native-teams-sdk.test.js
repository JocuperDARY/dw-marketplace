import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client';
import { resolveProfile } from '../src/capabilities.js';
import { createSdkRunner, workerEnvironment } from '../src/sdk-runner.js';
import { readHeartbeat } from './fixtures/heartbeat.js';
import { createTaskContext } from '../src/task-context.js';

const modulePath = fileURLToPath(new URL('./fixtures/native-teams-campaign-model.js', import.meta.url));
const networkImport = new URL('./fixtures/offline-network.js', import.meta.url).href;
const parsed = async path => JSON.parse(await readFile(path, 'utf8'));
const settlementData = request => {
  const prompt = request.messages.flatMap(message => message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
  const match = prompt.match(/Native team settlement data[^\n]*\n(\{[^\n]*\})/);
  assert.ok(match, 'Captain checkpoint must contain the native settlement section.');
  return JSON.parse(match[1]);
};
const until = async (condition, signal) => {
  while (!(await condition())) await delay(20, undefined, { signal });
};

async function setup(t, mode, overrides = {}) {
  // CI without the optional installed Teams package reports an honest skip.
  // A selected package that fails to initialize is a test failure, never a skip.
  const nativePlugins = overrides.nativePlugins ?? ['teams'];
  const profile = await resolveProfile('native', {}, { access: 'workspace-write', nativePlugins });
  if (nativePlugins.includes('teams') && !profile.native.components.some(component => component.capability === 'teams' && component.selected)) {
    t.skip('Optional native Agent Teams package is not installed in a supported profile.');
    return null;
  }
  const evidenceRoot = process.env.DSH_TEAMS_EVIDENCE_DIR || join(tmpdir(), 'bridge-native-teams-evidence');
  await mkdir(evidenceRoot, { recursive: true });
  const root = await mkdtemp(join(evidenceRoot, `${mode}-`));
  const workspace = join(root, 'workspace');
  const home = join(root, 'home');
  await mkdir(workspace);
  await writeFile(join(workspace, 'input.txt'), 'NATIVE_CHILD_FILE_FIXTURE\n');
  const task = { taskId: 'offline-native', sessionId: 'offline-native', workspace, access: 'workspace-write', capabilityProfile: 'native', nativePlugins: ['teams'],
    route: { provider: 'deepseek-official', model: 'deepseek-flash', effort: 'off' },
    maxTokens: null, maxModelRequests: null, maxToolCalls: null, maxRequestBytes: null,
    attempts: [{ number: 1, timeoutMs: 45000 }], ...overrides };
  const requestsPath = join(root, 'requests.json');
  task.taskContext = createTaskContext({ assignment: 'ROOT_ONLY_PRIVATE_CONTEXT_MARKER: scoped parent constraints.', requestId: 'root-context' });
  const heartbeat = join(root, 'child-heartbeat.txt');
  const teamRoot = join(workspace, '.agent-teams-bridge', task.taskId);
  const teamPath = join(teamRoot, 'offline-team', 'team.json');
  const budgetPath = join(home, 'worker-budget.json');
  profile.modules.push({ path: modulePath, sha256: createHash('sha256').update(await readFile(modulePath)).digest('hex'), tools: [], native: true,
    config: { mode, captainSessionId: task.sessionId, softDeadline: task.stageBudget?.softDeadline,
      receipt: requestsPath, heartbeat, teamPath, budgetPath, ...(mode === 'output-cap' ? { outputTokens: 200000 } : {}) } });
  const evidence = { mode, root, testNodeVersion: process.version, network: 'blocked by offline-network preload', externalModelCalls: 0, task, events: [], diagnostics: [], assertion: null, accepted: false };
  let runtime;
  const runner = createSdkRunner({ resolveCapabilities: async () => profile,
    env: { ...workerEnvironment(), DEEPSEEK_API_KEY: 'offline-not-a-credential' },
    clientFactory: options => {
      runtime = new HarnessClient({ ...options, env: { ...options.env, NODE_OPTIONS: `${options.env.NODE_OPTIONS} --import=${networkImport}` } });
      const subscribe = runtime.subscribe.bind(runtime);
      runtime.subscribe = filter => subscribe(notification => {
        if (notification.params?.event) evidence.events.push({ sessionId: notification.params.sessionId, event: notification.params.event });
        return filter(notification);
      });
      return runtime;
    },
  });
  t.diagnostic(`Retained offline native Teams evidence: ${root}`);
  t.after(async () => {
    evidence.diagnostics = runtime?.stderrTail ?? [];
    evidence.runtime = { pid: runtime?.child?.pid, exitCode: runtime?.child?.exitCode, signalCode: runtime?.child?.signalCode };
    await writeFile(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
  });
  const run = async signal => {
    evidence.result = await runner({ task, prompt: 'Explicitly authorized offline fixture. Create one team member to read input.txt, report once to the captain and archive after completion. All streams are fixed local fixtures.',
      home, signal: signal ?? AbortSignal.timeout(45000) });
    return evidence.result;
  };
  const verify = async assertions => {
    try { await assertions(); evidence.accepted = true; }
    catch (error) { evidence.accepted = false; evidence.assertion = { message: error.message, stack: error.stack }; throw error; }
  };
  const quiescent = expectedPid => {
    assert.ok(runtime?.child?.pid, 'The actual SDK must own a runtime subprocess.');
    if (expectedPid !== undefined) assert.equal(runtime.child.pid, expectedPid, 'Child fixture must execute inside the owned SDK process.');
    assert.ok(runtime.child.exitCode !== null || runtime.child.signalCode !== null, 'Owned runtime did not exit.');
    assert.throws(() => process.kill(runtime.child.pid, 0), { code: 'ESRCH' }, 'Owned runtime is still alive after runner cleanup.');
  };
  return { root, home, workspace, teamRoot, requestsPath, heartbeat, run, verify, quiescent };
}

test('real SDK native Teams child reads, reports to captain, archives and exits offline', { timeout: 60000 }, async t => {
  const h = await setup(t, 'success'); if (!h) return;
  const result = await h.run();
  await h.verify(async () => {
    assert.equal(result.terminal, 'completed', JSON.stringify(result));
    assert.equal(result.cleanup, 'confirmed');
    assert.equal(result.text, 'OFFLINE_TEAM_COMPLETED');
    const receipt = await parsed(h.requestsPath);
    assert.equal(receipt.requests.filter(request => !request.member).length, 4);
    assert.equal(receipt.requests.filter(request => request.member).length, 6);
    assert.ok(receipt.requests.filter(request => !request.member).every(request => JSON.stringify(request.messages).includes('ROOT_ONLY_PRIVATE_CONTEXT_MARKER')));
    assert.ok(receipt.requests.filter(request => request.member).every(request => !JSON.stringify(request.messages).includes('ROOT_ONLY_PRIVATE_CONTEXT_MARKER')));
    assert.equal(result.budget.modelRequests, receipt.requests.length);
    assert.equal(result.budget.calls.reduce((sum, call) => sum + call.usage.outputTokens, 0), 100);
    assert.equal(result.toolCalls, 8, 'Count team and file calls exactly once across parent and child.');
    for (const name of ['agent_teams_create', 'agent_teams_claim_task', 'bridge_read', 'agent_teams_send_message', 'agent_teams_status', 'agent_teams_delete']) {
      assert.equal(result.capabilities.toolOutcomes[name].returned, 1, name);
      assert.equal(result.capabilities.toolOutcomes[name].error, 0, name);
    }
    assert.ok(JSON.stringify(receipt.requests.filter(request => request.member)).includes('NATIVE_CHILD_FILE_FIXTURE'));
    assert.ok(JSON.stringify(receipt.requests.filter(request => !request.member)).includes('OFFLINE_CHILD_REPORT_TO_CAPTAIN'));
    const archived = await parsed(join(h.teamRoot, 'archive', 'offline-team', 'team.json'));
    assert.equal(archived.tasks[0].status, 'completed');
    assert.equal(archived.tasks[0].output, 'OFFLINE_CHILD_READ_CONFIRMED');
    assert.ok(archived.members.every(member => member.status === 'removed'));
    const childIds = new Set(receipt.requests.filter(request => request.member).map(request => request.sessionId));
    assert.equal(childIds.size, 1);
    assert.equal(archived.members[0].id, [...childIds][0]);
    await assert.rejects(access(join(h.teamRoot, 'offline-team', 'team.json')), { code: 'ENOENT' });
    h.quiescent(receipt.pid);
  });
});

test('native Teams parent and child share one model request cap', { timeout: 60000 }, async t => {
  const h = await setup(t, 'request-cap', { maxModelRequests: 3 }); if (!h) return;
  const result = await h.run();
  await h.verify(async () => {
    assert.equal(result.cleanup, 'confirmed');
    assert.ok(result.error, 'Request cap denial must surface as a failed result.');
    assert.equal(result.budget.denied, 'MODEL_REQUEST_LIMIT');
    assert.equal(result.budget.modelRequests, 3);
    const { requests } = await parsed(h.requestsPath);
    assert.equal(requests.length, 3);
    assert.ok(requests.some(request => request.member));
    assert.ok(requests.some(request => !request.member));
    h.quiescent();
  });
});

test('native Teams parent and child share one tool cap before file execution', { timeout: 60000 }, async t => {
  const h = await setup(t, 'tool-cap', { maxToolCalls: 2 }); if (!h) return;
  const result = await h.run();
  await h.verify(async () => {
    assert.equal(result.cleanup, 'confirmed');
    assert.equal(result.toolCalls, 2);
    assert.equal(result.capabilities.toolOutcomes.agent_teams_create.returned, 1);
    assert.equal(result.capabilities.toolOutcomes.agent_teams_claim_task.returned, 1);
    assert.ok(!result.capabilities.usedTools.includes('bridge_read'));
    const { requests } = await parsed(h.requestsPath);
    const childMessages = JSON.stringify(requests.filter(request => request.member));
    assert.match(childMessages, /explicit bridge tool call budget is exhausted/);
    assert.ok(!childMessages.includes('NATIVE_CHILD_FILE_FIXTURE'), 'Denied read must have no file side effect/result.');
    // Captain mailbox delivery can legitimately add one final text-only request.
    assert.ok(result.budget.modelRequests <= 9, 'Finite scripted attempts must not keep retrying a denied tool.');
    h.quiescent();
  });
});

test('native Teams concurrent streams share total output reservations', { timeout: 60000 }, async t => {
  const h = await setup(t, 'output-cap', { maxTokens: 256000,
    stageBudget: { nonce: 'native-output-cap', maxOutputTokens: 512000, checkpointEnabled: false } }); if (!h) return;
  const result = await h.run();
  await h.verify(async () => {
    assert.equal(result.cleanup, 'confirmed');
    assert.ok(result.error);
    assert.equal(result.budget.denied, 'TOTAL_OUTPUT_LIMIT');
    assert.ok(result.budget.modelRequests >= 2 && result.budget.modelRequests <= 3);
    const { requests } = await parsed(h.requestsPath);
    assert.equal(requests.length, result.budget.modelRequests);
    assert.ok(requests.some(request => request.member), 'Actual child stream must consume the shared allowance.');
    assert.ok(result.budget.calls.every(call => call.reservedOutputTokens === 256000));
    assert.ok(result.budget.calls.filter(call => call.finished).reduce((sum, call) => sum + call.usage.outputTokens, 0) <= 512000);
    h.quiescent();
  });
});

test('a child checkpoint cannot consume the captain stage checkpoint', { timeout: 60000 }, async t => {
  const h = await setup(t, 'checkpoint', { maxTokens: 512, maxModelRequests: 4,
    stageBudget: { nonce: 'native-checkpoint', maxOutputTokens: 4096, checkpointTokens: 128, softDeadline: null } }); if (!h) return;
  const result = await h.run();
  await h.verify(async () => {
    assert.equal(result.cleanup, 'confirmed');
    const receipt = await parsed(h.requestsPath);
    assert.equal(result.error, undefined, JSON.stringify({ error: result.error, budget: result.budget, events: receipt.events }));
    assert.ok(receipt.requests.some(request => request.member));
    assert.equal(result.terminal, 'completed');
    assert.equal(result.budget.denied, null);
    assert.equal(JSON.parse(result.text).state, 'checkpoint');
    assert.ok(receipt.requests.some(request => !request.member && request.checkpoint), 'The captain must receive a checkpoint response for the stage.');
    assert.ok(result.budget.modelRequests <= 4);
    assert.ok(result.budget.calls.filter(call => call.checkpoint).every(call => call.effort === 'off' && call.reservedOutputTokens <= 128));
    h.quiescent();
  });
});

test('captain checkpoint drains its active native child before dispatch', { timeout: 60000 }, async t => {
  const h = await setup(t, 'captain-checkpoint', { maxTokens: 512, maxModelRequests: 4,
    stageBudget: { nonce: 'native-captain-checkpoint', maxOutputTokens: 4096, checkpointTokens: 128, softDeadline: null } }); if (!h) return;
  const result = await h.run();
  await h.verify(async () => {
    assert.equal(result.cleanup, 'confirmed');
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(result.budget.denied, null);
    assert.equal(JSON.parse(result.text).state, 'checkpoint');
    const receipt = await parsed(h.requestsPath);
    const child = receipt.requests.find(request => request.member);
    const checkpoint = receipt.requests.find(request => !request.member && request.checkpoint);
    assert.ok(child && checkpoint, 'Both the active child and captain checkpoint must actually dispatch.');
    assert.ok(receipt.events.some(event => event.type === 'child-stream-settled' && event.aborted));
    assert.ok(receipt.events.some(event => event.type === 'subagent-end' && event.id === child.sessionId));
    assert.ok(JSON.stringify(checkpoint.messages).includes(child.sessionId), 'Captain checkpoint must retain its child settlement identity.');
    const settlement = settlementData(checkpoint);
    assert.equal(settlement.drained, true);
    const stoppedChild = settlement.children.find(row => row.sessionId === child.sessionId);
    assert.ok(stoppedChild);
    assert.equal(stoppedChild.status, 'disposed');
    assert.equal(stoppedChild.turnEnd, 'aborted', 'Interrupted work must retain its actual terminal state.');
    assert.equal(settlement.omittedChildren, 0);
    assert.ok(settlement.lateNotices.some(notice => notice.senderSessionId === child.sessionId), 'Late native notice must be retained in the checkpoint.');
    assert.ok(settlement.lateNotices.every(notice => typeof notice.messageId === 'string' && notice.text.length <= 512));
    assert.deepEqual(result.budget.teamSettlement.lateNotices, settlement.lateNotices, 'Late notices must be saved durably before they leave the root inbox.');
    assert.ok(!receipt.requests.some(request => request.member && request.checkpoint));
    assert.ok(result.budget.modelRequests <= 4);
    h.quiescent();
  });
});

test('native budgeted files checkpoint works without a subagent service', { timeout: 60000 }, async t => {
  const h = await setup(t, 'files-checkpoint', { nativePlugins: [], maxTokens: 512, maxModelRequests: 1,
    stageBudget: { nonce: 'native-files-checkpoint', maxOutputTokens: 512, checkpointTokens: 128, forcedCheckpoint: true, softDeadline: null } }); if (!h) return;
  const result = await h.run();
  await h.verify(async () => {
    assert.equal(result.cleanup, 'confirmed');
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(result.budget.denied, null);
    assert.equal(result.budget.modelRequests, 1);
    assert.equal(result.toolCalls, 0);
    assert.equal(JSON.parse(result.text).state, 'checkpoint');
    const receipt = await parsed(h.requestsPath);
    assert.equal(receipt.requests.length, 1);
    assert.equal(receipt.requests[0].member, false);
    assert.equal(receipt.requests[0].checkpoint, true);
    assert.deepEqual(receipt.requests[0].tools, []);
    assert.ok(!result.capabilities.registeredTools.some(name => name.startsWith('agent_teams_')));
    h.quiescent();
  });
});

test('a shared stage soft deadline stops native child work and preserves captain checkpoint', { timeout: 75000 }, async t => {
  // The SDK owns a 30s initialization allowance. Leave 10s after that allowance
  // so this real-clock boundary cannot expire merely because initialization ran.
  const softDeadline = Date.now() + 40000;
  const h = await setup(t, 'soft-deadline', { maxTokens: 512, maxModelRequests: 16,
    attempts: [{ number: 1, timeoutMs: 60000 }],
    stageBudget: { nonce: 'native-soft-deadline', maxOutputTokens: 4096, checkpointTokens: 128, softDeadline } }); if (!h) return;
  const result = await h.run(AbortSignal.timeout(65000));
  await h.verify(async () => {
    assert.equal(result.cleanup, 'confirmed');
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(result.budget.denied, null);
    assert.equal(JSON.parse(result.text).state, 'checkpoint');
    const receipt = await parsed(h.requestsPath);
    const waited = receipt.events.find(event => event.type === 'child-deadline-wait');
    const reached = receipt.events.find(event => event.type === 'child-deadline-reached');
    assert.ok(waited && reached, 'Actual native child must span the shared soft deadline.');
    assert.ok(waited.at < softDeadline && reached.at >= softDeadline);
    assert.ok(receipt.requests.some(request => !request.member && request.checkpoint));
    assert.ok(!receipt.requests.some(request => request.member && request.checkpoint));
    assert.ok(result.budget.modelRequests < 16, 'The clock boundary must trigger before the request cap.');
    h.quiescent();
  });
});

test('native Teams active child stops at the owned cancellation deadline with no orphan', { timeout: 60000 }, async t => {
  const h = await setup(t, 'cancel'); if (!h) return;
  const controller = new AbortController();
  const wall = AbortSignal.timeout(45000);
  const running = h.run(AbortSignal.any([controller.signal, wall]));
  let before;
  await until(async () => {
    try {
      const heartbeat = await readHeartbeat(h.heartbeat);
      if (!heartbeat) return false;
      const { events } = await parsed(h.requestsPath);
      const active = events.some(event => event.type === 'child-active') && events.some(event => event.type === 'captain-active');
      if (active) before = heartbeat;
      return active;
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
  }, wall);
  await delay(50, undefined, { signal: wall });
  const stoppedAt = Date.now();
  controller.abort(new Error('Offline fixture reached its explicit active-child deadline.'));
  const result = await running;
  await h.verify(async () => {
    assert.equal(result.cleanup, 'confirmed');
    // The raw SDK runner may report INCOMPLETE_TURN when shutdown wins the
    // session/wait race; the observable cancellation contract is quiescence.
    assert.ok(result.error);
    assert.notEqual(result.terminal, 'completed');
    assert.ok(Date.now() - stoppedAt < 10000, 'Cancellation must finish within the SDK teardown bound.');
    const after = await readFile(h.heartbeat, 'utf8');
    await delay(150);
    assert.equal(await readFile(h.heartbeat, 'utf8'), after, 'Child continued running after its owned runtime exited.');
    const receipt = await parsed(h.requestsPath);
    h.quiescent(receipt.pid);
    assert.equal(before.pid, receipt.pid, 'The observed active child must run in the owned SDK process.');
    assert.ok(receipt.requests.some(request => request.member));
    assert.ok(receipt.events.some(event => event.type === 'child-stream-settled' && event.aborted));
    assert.ok(receipt.events.some(event => event.type === 'captain-stream-settled' && event.aborted));
    assert.ok(!receipt.events.some(event => event.type === 'child-finished'));
  });
});
