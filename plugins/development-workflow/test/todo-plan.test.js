#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pluginRoot = path.resolve(__dirname, '..');
const cliPath = path.join(pluginRoot, 'skills', 'dw-planning', 'scripts', 'todo-plan.js');
const storePath = path.join(pluginRoot, 'skills', 'dw-planning', 'scripts', 'lib', 'todo-plan-store.js');
const renderPath = path.join(pluginRoot, 'skills', 'dw-planning', 'scripts', 'lib', 'todo-plan-render.js');

const store = require(storePath);
const render = require(renderPath);
const cli = require(cliPath);

let passed = 0;
let total = 0;

function makeTempDir(prefix = 'dw-todo-plan-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runCliSync(args, options = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: options.cwd || pluginRoot,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    input: options.input,
    encoding: 'utf8',
    timeout: options.timeoutMs || 15000,
  });
  if (result.error) throw result.error;
  let json = null;
  const trimmed = (result.stdout || '').trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { json = JSON.parse(trimmed); } catch { json = null; }
  }
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '', json };
}

function runCliAsync(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: options.cwd || pluginRoot,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (status) => {
      let json = null;
      const trimmed = stdout.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try { json = JSON.parse(trimmed); } catch { json = null; }
      }
      resolve({ status, stdout, stderr, json });
    });
    if (options.input !== undefined) child.stdin.write(options.input);
    child.stdin.end();
  });
}

function readPlanJson(planFile) {
  return JSON.parse(fs.readFileSync(planFile, 'utf8'));
}

function mustJson(args, options = {}) {
  const res = runCliSync(['--json', ...args], options);
  assert.strictEqual(res.status, 0, `expected exit 0 for ${args.join(' ')}, got ${res.status}: ${res.stdout} ${res.stderr}`);
  assert(res.json && res.json.ok === true, `expected ok JSON for ${args.join(' ')}, got: ${res.stdout}`);
  return res.json;
}

function mustFailJson(args, expectedExit, expectedCode, options = {}) {
  const res = runCliSync(['--json', ...args], options);
  assert.strictEqual(res.status, expectedExit, `expected exit ${expectedExit} for ${args.join(' ')}, got ${res.status}: ${res.stdout} ${res.stderr}`);
  assert(res.json && res.json.ok === false, `expected error JSON for ${args.join(' ')}, got: ${res.stdout}`);
  if (expectedCode) {
    assert.strictEqual(res.json.code, expectedCode, `expected code ${expectedCode}, got ${res.json.code}`);
  }
  return res.json;
}

function silentIo() {
  return {
    stdout: { write() {} },
    stderr: { write() {} },
    isTTY: false,
  };
}

async function test(name, fn) {
  total += 1;
  const tmpDir = makeTempDir();
  try {
    await fn(tmpDir);
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  await test('exports frozen contract symbols from store, render, and cli', async () => {
    for (const symbol of [
      'TodoPlanError', 'EXIT_CODES', 'VALID_STATUSES', 'VALID_ROLES', 'SCHEMA_NAME', 'SCHEMA_VERSION',
      'resolvePlanPath', 'resolveSidecarPath', 'validatePlan', 'derivePhaseStatus', 'getSummary',
      'checkComplete', 'initPlan', 'configureViews', 'loadAndValidate', 'startTask', 'claimNextTask',
      'pauseTask', 'completeTask', 'reopenTask', 'markImpossible', 'markError', 'setTaskStatus',
      'addPhase', 'updatePhase', 'removePhase', 'reorderPhases', 'addTask', 'updateTask',
      'splitTask', 'removeTask', 'reorderTasks', 'applyPatch', 'statusPlan', 'checkCompletePlan', 'recoverLock',
    ]) {
      assert(symbol in store, `missing store export: ${symbol}`);
      assert(symbol in cli, `missing cli re-export: ${symbol}`);
    }
    for (const symbol of [
      'STATUS_META', 'escapeHtml', 'safeJsonForScript', 'renderTerminal',
      'renderBrief', 'renderMarkdown', 'renderHtml', 'renderPlan',
    ]) {
      assert(symbol in render, `missing render export: ${symbol}`);
      assert(symbol in cli, `missing cli render re-export: ${symbol}`);
    }
    assert.strictEqual(typeof cli.runCli, 'function');
    assert.strictEqual(store.SCHEMA_NAME, 'DwTodoPlan1');
    assert.strictEqual(store.SCHEMA_VERSION, 1);
    assert.deepStrictEqual(store.VALID_STATUSES, ['pending', 'in_progress', 'completed', 'impossible', 'error']);
    assert.deepStrictEqual(store.VALID_ROLES, ['coordinator', 'author', 'verifier']);
  });

  // Group 1: Schema, Bounds, Sanitization & DAG
  await test('init creates DwTodoPlan1 schema and in-process runCli status works', async (tmpDir) => {
    const planFile = path.join(tmpDir, 'plan.json');
    const created = mustJson(['init', '--file', planFile, '--title', 'Test Plan', '--goal', 'Ship safely']);
    assert.strictEqual(created.revision, 1);
    const plan = readPlanJson(planFile);
    assert.strictEqual(plan.schema, 'DwTodoPlan1');
    assert.strictEqual(plan.schemaVersion, 1);
    assert.strictEqual(plan.revision, 1);
    assert.strictEqual(typeof plan.nextPhaseSeq, 'number');
    assert.strictEqual(typeof plan.nextTaskSeq, 'number');
    assert.deepStrictEqual(plan.views, { markdownPath: null, htmlPath: null });
    assert.deepStrictEqual(plan.phases, []);
    assert.deepStrictEqual(plan.archived, []);

    const inProc = await cli.runCli(['--json', 'status', '--file', planFile], silentIo());
    assert.strictEqual(inProc.exitCode, 0);
    assert.strictEqual(inProc.payload.planId, plan.planId);
  });

  await test('rejects prototype pollution payloads and NUL control characters', async (tmpDir) => {
    const planFile = path.join(tmpDir, 'plan.json');
    mustJson(['init', '--file', planFile, '--title', 'Sanitize', '--goal', 'Check']);
    mustJson(['add-phase', '--file', planFile, '--id', 'P1', '--title', 'Phase 1', '--goal', 'G1']);

    for (const badJson of [
      '{"phaseId":"P1","title":"bad","__proto__":{"polluted":true}}',
      '{"phaseId":"P1","title":"bad","constructor":{"prototype":{"x":1}}}',
      '{"phaseId":"P1","title":"bad","prototype":{}}',
    ]) {
      mustFailJson(['add-task', '--file', planFile, '--stdin'], 2, 'INVALID_ARGUMENT', { input: badJson });
    }

    const poisoned = JSON.parse('{"schema":"DwTodoPlan1","schemaVersion":1,"__proto__":{}}');
    assert.throws(
      () => store.validatePlan(poisoned),
      (err) => err instanceof store.TodoPlanError && err.code === 'INVALID_ARGUMENT' && err.exitCode === 2,
    );

    mustFailJson(
      ['add-task', '--file', planFile, '--phase', 'P1', '--stdin'],
      2,
      'INVALID_ARGUMENT',
      { input: '{"title":"nul\\u0000char"}' },
    );
  });

  await test('rejects cyclic phase deps, cyclic task deps, and dangling dependsOn without corrupting plan', async (tmpDir) => {
    const planFile = path.join(tmpDir, 'plan.json');
    mustJson(['init', '--file', planFile, '--title', 'DAG', '--goal', 'Cycles']);
    mustJson(['add-phase', '--file', planFile, '--id', 'P1', '--title', 'P1', '--goal', 'G1']);
    mustJson(['add-phase', '--file', planFile, '--id', 'P2', '--title', 'P2', '--goal', 'G2', '--depends-on', 'P1']);
    mustFailJson(['update-phase', 'P1', '--file', planFile, '--depends-on', 'P2'], 2, 'DEPENDENCY_CYCLE');
    mustFailJson(['add-phase', '--file', planFile, '--id', 'P3', '--title', 'P3', '--goal', 'G3', '--depends-on', 'P999'], 2, 'DEPENDENCY_MISSING');

    mustJson(['add-task', '--file', planFile, '--id', 'T1', '--phase', 'P1', '--title', 'Task 1']);
    mustJson(['add-task', '--file', planFile, '--id', 'T2', '--phase', 'P1', '--title', 'Task 2', '--depends-on', 'T1']);
    const beforeCycle = fs.readFileSync(planFile, 'utf8');
    mustFailJson(['update-task', 'T1', '--file', planFile, '--depends-on', 'T2'], 2, 'DEPENDENCY_CYCLE');
    mustFailJson(['add-task', '--file', planFile, '--phase', 'P1', '--title', 'Bad Dep', '--depends-on', 'T999'], 2, 'DEPENDENCY_MISSING');
    assert.strictEqual(fs.readFileSync(planFile, 'utf8'), beforeCycle);
  });

  await test('monotonic IDs never reuse archived IDs and reorders preserve existing IDs', async (tmpDir) => {
    const planFile = path.join(tmpDir, 'plan.json');
    mustJson(['init', '--file', planFile, '--title', 'Monotonic', '--goal', 'IDs']);
    mustJson(['add-phase', '--file', planFile, '--title', 'Phase One', '--goal', 'G1']);
    mustJson(['add-phase', '--file', planFile, '--title', 'Phase Two', '--goal', 'G2']);
    mustJson(['add-task', '--file', planFile, '--phase', 'P1', '--title', 'Task 1']);
    mustJson(['add-task', '--file', planFile, '--phase', 'P1', '--title', 'Task 2']);

    mustJson(['remove-task', 'P1-T2', '--file', planFile, '--reason', 'not needed']);
    mustJson(['add-task', '--file', planFile, '--phase', 'P1', '--title', 'Task 3']);
    mustJson(['remove-phase', 'P2', '--file', planFile, '--reason', 'merged']);
    mustJson(['add-phase', '--file', planFile, '--title', 'Phase Three', '--goal', 'G3']);

    let plan = readPlanJson(planFile);
    const p1TaskIds = plan.phases[0].tasks.map((t) => t.id);
    assert.strictEqual(p1TaskIds.length, 2);
    assert(!p1TaskIds.includes('P1-T2'), 'archived task ID must never be reused');
    assert.strictEqual(p1TaskIds[1], 'P1-T3');
    const phaseIds = plan.phases.map((p) => p.id);
    assert(!phaseIds.includes('P2'), 'archived phase ID must never be reused');
    assert.strictEqual(phaseIds[1], 'P3');

    mustJson(['reorder-phases', '--file', planFile, '--order', 'P3,P1', '--reason', 'prioritize P3']);
    mustJson(['reorder-tasks', '--file', planFile, '--phase', 'P1', '--order', 'P1-T3,P1-T1', '--reason', 'swap']);
    plan = readPlanJson(planFile);
    assert.deepStrictEqual(plan.phases.map((p) => p.id), ['P3', 'P1']);
    assert.deepStrictEqual(plan.phases[1].tasks.map((t) => t.id), ['P1-T3', 'P1-T1']);
  });

  // Group 2: 5-State Matrix, statusReason, pause/reopen, Cross-Level Deps & check-complete
  await test('5-state matrix, statusReason lifecycle, pause/reopen, and exclusive start', async (tmpDir) => {
    const planFile = path.join(tmpDir, 'plan.json');
    mustJson(['init', '--file', planFile, '--title', 'States', '--goal', 'All 5']);
    mustJson(['add-phase', '--file', planFile, '--id', 'P1', '--title', 'P1', '--goal', 'G1']);
    mustJson(['add-task', '--file', planFile, '--id', 'T1', '--phase', 'P1', '--title', 'T1']);
    mustJson(['add-task', '--file', planFile, '--id', 'T2', '--phase', 'P1', '--title', 'T2']);

    mustFailJson(['mark-impossible', 'T1', '--file', planFile], 2, 'REASON_REQUIRED');
    mustFailJson(['mark-error', 'T1', '--file', planFile], 2, 'REASON_REQUIRED');

    mustJson(['mark-error', 'T1', '--file', planFile, '--reason', 'timeout on port 8080']);
    let plan = readPlanJson(planFile);
    assert.strictEqual(plan.phases[0].tasks[0].status, 'error');
    assert.strictEqual(plan.phases[0].tasks[0].statusReason, 'timeout on port 8080');

    mustFailJson(['reopen', 'T1', '--file', planFile], 2, 'REASON_REQUIRED');
    mustJson(['reopen', 'T1', '--file', planFile, '--reason', 'service restored', '--note', 'ready to retry']);
    plan = readPlanJson(planFile);
    assert.strictEqual(plan.phases[0].tasks[0].status, 'pending');
    assert.strictEqual(plan.phases[0].tasks[0].statusReason, null);
    assert(JSON.stringify(plan.history).includes('timeout on port 8080'), 'previous error reason must remain in history');

    mustFailJson(['pause', 'T1', '--file', planFile, '--note', 'not running'], 2, 'INVALID_TRANSITION');
    mustFailJson(['reopen', 'T1', '--file', planFile, '--reason', 'already pending'], 2, 'INVALID_TRANSITION');

    mustJson(['start', 'T1', '--file', planFile, '--owner', 'w1']);
    mustJson(['pause', 'T1', '--file', planFile, '--note', 'waiting on fixture']);
    assert.strictEqual(readPlanJson(planFile).phases[0].tasks[0].status, 'pending');

    mustJson(['start', 'T1', '--file', planFile, '--owner', 'w1']);
    mustJson(['start', 'T2', '--file', planFile, '--owner', 'w1', '--exclusive']);
    plan = readPlanJson(planFile);
    assert.strictEqual(plan.phases[0].tasks[0].status, 'pending');
    assert.strictEqual(plan.phases[0].tasks[1].status, 'in_progress');

    mustJson(['mark-impossible', 'T1', '--file', planFile, '--reason', 'API removed']);
    mustJson(['complete', 'T1', '--file', planFile, '--note', 'recovered via workaround']);
    plan = readPlanJson(planFile);
    assert.strictEqual(plan.phases[0].tasks[0].status, 'completed');
    assert.strictEqual(plan.phases[0].tasks[0].statusReason, null);
  });

  await test('cross-level deps gate readyTasks, allow-unmet-deps logs history, upstreamBlocked & check-complete gates', async (tmpDir) => {
    const planFile = path.join(tmpDir, 'plan.json');
    mustJson(['init', '--file', planFile, '--title', 'Gates', '--goal', 'Deps']);
    mustFailJson(['check-complete', '--file', planFile], 2, 'PLAN_EMPTY');

    mustJson(['add-phase', '--file', planFile, '--id', 'P1', '--title', 'P1', '--goal', 'G1']);
    mustJson(['add-phase', '--file', planFile, '--id', 'P2', '--title', 'P2', '--goal', 'G2', '--depends-on', 'P1']);
    mustJson(['add-task', '--file', planFile, '--id', 'T1', '--phase', 'P1', '--title', 'T1']);
    mustJson(['add-task', '--file', planFile, '--id', 'T2', '--phase', 'P1', '--title', 'T2', '--depends-on', 'T1']);

    // P2 is empty -> empty phase never completed, check-complete returns PLAN_EMPTY (exit 2)
    mustFailJson(['check-complete', '--file', planFile], 2, 'PLAN_EMPTY');
    assert.strictEqual(readPlanJson(planFile).phases[1].status, 'empty');

    mustJson(['add-task', '--file', planFile, '--id', 'T3', '--phase', 'P2', '--title', 'T3']);
    let st = mustJson(['status', '--file', planFile]);
    assert.deepStrictEqual(st.summary.readyTasks.map((t) => t.id), ['T1']);

    mustFailJson(['start', 'T2', '--file', planFile], 2, 'DEPENDENCY_UNMET');
    mustFailJson(['complete', 'T3', '--file', planFile], 2, 'DEPENDENCY_UNMET');

    mustJson(['mark-error', 'T1', '--file', planFile, '--reason', 'upstream failure']);
    st = mustJson(['status', '--file', planFile]);
    const blockedT2 = st.summary.upstreamBlocked.find((b) => b.id === 'T2');
    const blockedT3 = st.summary.upstreamBlocked.find((b) => b.id === 'T3');
    assert(blockedT2 && blockedT2.blockedBy.some((x) => x.id === 'T1' && x.status === 'error'));
    assert(blockedT3 && blockedT3.blockedBy.some((x) => x.id === 'P1' && x.status === 'error'));
    mustFailJson(['check-complete', '--file', planFile], 1, 'PLAN_INCOMPLETE');

    mustJson(['start', 'T2', '--file', planFile, '--allow-unmet-deps', '--reason', 'manual bypass']);
    assert(JSON.stringify(readPlanJson(planFile).history).includes('manual bypass'));

    mustJson(['complete', 'T1', '--file', planFile]);
    mustJson(['complete', 'T2', '--file', planFile]);
    mustFailJson(['check-complete', '--file', planFile], 1, 'PLAN_INCOMPLETE');

    mustJson(['complete', 'T3', '--file', planFile]);
    const done = mustJson(['check-complete', '--file', planFile]);
    assert.strictEqual(done.code, 'PLAN_COMPLETE');
    assert.strictEqual(done.summary.counts.completed, 3);
  });

  // Group 3: Mid-Execution Dynamic Adjustments & Bounded History
  await test('add-task --before/--after/--during, move-to-phase, and UPSTREAM_PHASE_REOPENED warning', async (tmpDir) => {
    const planFile = path.join(tmpDir, 'plan.json');
    mustJson(['init', '--file', planFile, '--title', 'Dynamic', '--goal', 'Mid-flight']);
    mustJson(['add-phase', '--file', planFile, '--id', 'P1', '--title', 'P1', '--goal', 'G1']);
    mustJson(['add-phase', '--file', planFile, '--id', 'P2', '--title', 'P2', '--goal', 'G2', '--depends-on', 'P1']);
    mustJson(['add-task', '--file', planFile, '--id', 'T1', '--phase', 'P1', '--title', 'T1']);
    mustJson(['add-task', '--file', planFile, '--id', 'T2', '--phase', 'P1', '--title', 'T2']);

    mustFailJson(['add-task', '--file', planFile, '--phase', 'P1', '--title', 'Bad', '--during', 'NO_SUCH'], 2, 'NOT_FOUND');

    mustJson(['add-task', '--file', planFile, '--id', 'T_MID', '--phase', 'P1', '--title', 'Mid', '--before', 'T2', '--during', 'T1']);
    mustJson(['add-task', '--file', planFile, '--id', 'T_AFTER', '--phase', 'P1', '--title', 'After', '--after', 'T1']);

    let plan = readPlanJson(planFile);
    assert.deepStrictEqual(plan.phases[0].tasks.map((t) => t.id), ['T1', 'T_AFTER', 'T_MID', 'T2']);
    const tMid = plan.phases[0].tasks.find((t) => t.id === 'T_MID');
    assert.strictEqual(tMid.origin, 'added_during:T1');

    // Move T_AFTER to P2 and complete P1, start T_AFTER in P2, then reopen T1 in P1 -> UPSTREAM_PHASE_REOPENED
    mustJson(['update-task', 'T_AFTER', '--file', planFile, '--move-to-phase', 'P2']);
    for (const id of ['T1', 'T_MID', 'T2']) {
      mustJson(['complete', id, '--file', planFile]);
    }
    mustJson(['start', 'T_AFTER', '--file', planFile]);
    const reopened = mustJson(['reopen', 'T1', '--file', planFile, '--reason', 'edge case found']);
    assert(
      reopened.summary.dependencyWarnings.some((w) => w.code === 'UPSTREAM_PHASE_REOPENED' && w.phaseId === 'P2' && w.upstreamPhaseId === 'P1'),
      `expected UPSTREAM_PHASE_REOPENED warning, got ${JSON.stringify(reopened.summary.dependencyWarnings)}`,
    );
  });

  await test('split-task --chain and --parallel rebind dependencies and archive original without double-counting', async (tmpDir) => {
    const chainFile = path.join(tmpDir, 'chain.json');
    mustJson(['init', '--file', chainFile, '--title', 'Split Chain', '--goal', 'Chain']);
    mustJson(['add-phase', '--file', chainFile, '--id', 'P1', '--title', 'P1', '--goal', 'G1']);
    mustJson(['add-task', '--file', chainFile, '--id', 'T0', '--phase', 'P1', '--title', 'T0']);
    mustJson(['add-task', '--file', chainFile, '--id', 'T1', '--phase', 'P1', '--title', 'T1', '--depends-on', 'T0']);
    mustJson(['add-task', '--file', chainFile, '--id', 'T2', '--phase', 'P1', '--title', 'T2', '--depends-on', 'T1']);

    const splitChain = mustJson([
      'split-task', 'T1', '--file', chainFile, '--into', 'Step A', '--into', 'Step B', '--chain', '--reason', 'split chain',
    ]);
    assert.strictEqual(splitChain.summary.counts.totalTasks, 4);
    assert.strictEqual(splitChain.summary.counts.archived, 1);

    const chainPlan = readPlanJson(chainFile);
    const activeIds = chainPlan.phases[0].tasks.map((t) => t.id);
    assert(!activeIds.includes('T1'));
    const stepA = chainPlan.phases[0].tasks.find((t) => t.title === 'Step A');
    const stepB = chainPlan.phases[0].tasks.find((t) => t.title === 'Step B');
    const t2Chain = chainPlan.phases[0].tasks.find((t) => t.id === 'T2');
    assert.strictEqual(stepA.origin, 'split_from:T1');
    assert.deepStrictEqual(stepA.dependsOn, ['T0']);
    assert.deepStrictEqual(stepB.dependsOn, [stepA.id]);
    assert.deepStrictEqual(t2Chain.dependsOn, [stepB.id]);

    const parFile = path.join(tmpDir, 'parallel.json');
    mustJson(['init', '--file', parFile, '--title', 'Split Par', '--goal', 'Parallel']);
    mustJson(['add-phase', '--file', parFile, '--id', 'P1', '--title', 'P1', '--goal', 'G1']);
    mustJson(['add-task', '--file', parFile, '--id', 'T0', '--phase', 'P1', '--title', 'T0']);
    mustJson(['add-task', '--file', parFile, '--id', 'T1', '--phase', 'P1', '--title', 'T1', '--depends-on', 'T0']);
    mustJson(['add-task', '--file', parFile, '--id', 'T2', '--phase', 'P1', '--title', 'T2', '--depends-on', 'T1']);

    const splitPar = mustJson([
      'split-task', 'T1', '--file', parFile, '--into', 'Par A', '--into', 'Par B', '--parallel', '--reason', 'split parallel',
    ]);
    assert.strictEqual(splitPar.summary.counts.totalTasks, 4);
    const parPlan = readPlanJson(parFile);
    const parA = parPlan.phases[0].tasks.find((t) => t.title === 'Par A');
    const parB = parPlan.phases[0].tasks.find((t) => t.title === 'Par B');
    const t2Par = parPlan.phases[0].tasks.find((t) => t.id === 'T2');
    assert.deepStrictEqual(parA.dependsOn, ['T0']);
    assert.deepStrictEqual(parB.dependsOn, ['T0']);
    assert.deepStrictEqual(t2Par.dependsOn, [parA.id, parB.id]);
  });

  await test('remove-task and remove-phase handle DEPENDENCY_IN_USE, --unlink-deps, and --purge', async (tmpDir) => {
    const planFile = path.join(tmpDir, 'plan.json');
    mustJson(['init', '--file', planFile, '--title', 'Remove', '--goal', 'Archive & Purge']);
    mustJson(['add-phase', '--file', planFile, '--id', 'P1', '--title', 'P1', '--goal', 'G1']);
    mustJson(['add-phase', '--file', planFile, '--id', 'P2', '--title', 'P2', '--goal', 'G2', '--depends-on', 'P1']);
    mustJson(['add-task', '--file', planFile, '--id', 'T1', '--phase', 'P1', '--title', 'T1']);
    mustJson(['add-task', '--file', planFile, '--id', 'T2', '--phase', 'P1', '--title', 'T2', '--depends-on', 'T1']);
    mustJson(['add-task', '--file', planFile, '--id', 'T3', '--phase', 'P2', '--title', 'T3']);

    mustFailJson(['remove-task', 'T1', '--file', planFile, '--reason', 'drop'], 2, 'DEPENDENCY_IN_USE');
    mustJson(['remove-task', 'T1', '--file', planFile, '--reason', 'drop', '--unlink-deps']);
    let plan = readPlanJson(planFile);
    assert.deepStrictEqual(plan.phases[0].tasks[0].dependsOn, []);
    assert(plan.archived.some((a) => a.id === 'T1'));

    mustJson(['remove-task', 'T2', '--file', planFile, '--reason', 'purge task', '--purge']);
    plan = readPlanJson(planFile);
    assert(!plan.archived.some((a) => a.id === 'T2'));

    mustFailJson(['remove-phase', 'P1', '--file', planFile, '--reason', 'drop phase'], 2, 'DEPENDENCY_IN_USE');
    mustJson(['remove-phase', 'P1', '--file', planFile, '--reason', 'drop phase', '--unlink-deps']);
    plan = readPlanJson(planFile);
    assert.deepStrictEqual(plan.phases.map((p) => p.id), ['P2']);
    assert.deepStrictEqual(plan.phases[0].dependsOn, []);
    assert(plan.archived.some((a) => a.id === 'P1'));
  });

  await test('apply --stdin with UTF-8 BOM executes atomically and rolls back on error', async (tmpDir) => {
    const planFile = path.join(tmpDir, 'plan.json');
    mustJson(['init', '--file', planFile, '--title', 'Apply', '--goal', 'Atomicity']);
    mustJson(['add-phase', '--file', planFile, '--id', 'P1', '--title', 'P1', '--goal', 'G1']);
    mustJson(['add-task', '--file', planFile, '--id', 'T1', '--phase', 'P1', '--title', 'T1']);
    mustJson(['add-task', '--file', planFile, '--id', 'T2', '--phase', 'P1', '--title', 'T2']);
    mustJson(['add-task', '--file', planFile, '--id', 'T3', '--phase', 'P1', '--title', 'T3']);

    const revBefore = readPlanJson(planFile).revision;
    const goodPatch = `\uFEFF${JSON.stringify({
      reason: 'batch update',
      ops: [
        { op: 'complete', taskId: 'T1', note: 'done in batch' },
        { op: 'add_task', phaseId: 'P1', id: 'T4', title: 'T4' },
        { op: 'remove_task', taskId: 'T2', reason: 'obsolete' },
      ],
    })}`;
    const applied = mustJson(['apply', '--file', planFile, '--stdin'], { input: goodPatch });
    assert.strictEqual(applied.revision, revBefore + 1);

    const afterGood = readPlanJson(planFile);
    assert.strictEqual(afterGood.phases[0].tasks.find((t) => t.id === 'T1').status, 'completed');
    assert(afterGood.phases[0].tasks.some((t) => t.id === 'T4'));
    assert(!afterGood.phases[0].tasks.some((t) => t.id === 'T2'));

    const snapshot = fs.readFileSync(planFile, 'utf8');
    const badPatch = `\uFEFF${JSON.stringify({
      reason: 'should roll back',
      ops: [
        { op: 'complete', taskId: 'T3' },
        { op: 'remove_task', taskId: 'NO_SUCH_TASK', reason: 'fail' },
      ],
    })}`;
    mustFailJson(['apply', '--file', planFile, '--stdin'], 2, 'NOT_FOUND', { input: badPatch });
    assert.strictEqual(fs.readFileSync(planFile, 'utf8'), snapshot);
  });

  await test('history[] is capped at maxHistoryEntries and increments truncatedHistoryCount', async (tmpDir) => {
    const planFile = path.join(tmpDir, 'plan.json');
    await cli.runCli(['--json', 'init', '--file', planFile, '--title', 'History', '--goal', 'Bound'], silentIo());
    await cli.runCli(['--json', 'add-phase', '--file', planFile, '--id', 'P1', '--title', 'P1', '--goal', 'G1'], silentIo());
    for (let i = 1; i <= 205; i += 1) {
      const res = await cli.runCli(['--json', 'add-task', '--file', planFile, '--phase', 'P1', '--title', `Task ${i}`, '--no-sync'], silentIo());
      assert.strictEqual(res.exitCode, 0, `add-task ${i} failed: ${res.stdout}`);
    }
    const plan = readPlanJson(planFile);
    assert.strictEqual(plan.history.length, plan.maxHistoryEntries);
    assert(plan.truncatedHistoryCount >= 5, `expected truncatedHistoryCount >= 5, got ${plan.truncatedHistoryCount}`);
  });

  // Group 4: Renderers, Sidecar Auto-Sync, Path Security & --watch
  await test('render formats (terminal, text, brief, markdown, html), NO_COLOR, and XSS neutralization', async (tmpDir) => {
    const planFile = path.join(tmpDir, 'plan.json');
    const xssTitle = 'Plan </script><img src=x onerror=alert(1)> & "quotes"';
    mustJson(['init', '--file', planFile, '--title', xssTitle, '--goal', 'Render test']);
    mustJson(['add-phase', '--file', planFile, '--id', 'P1', '--title', 'Phase 1', '--goal', 'G1']);
    mustJson(['add-task', '--file', planFile, '--id', 'T1', '--phase', 'P1', '--title', 'Done task']);
    mustJson(['add-task', '--file', planFile, '--id', 'T2', '--phase', 'P1', '--title', 'Active </script> task']);
    mustJson(['add-task', '--file', planFile, '--id', 'T3', '--phase', 'P1', '--title', 'Error task']);
    mustJson(['add-task', '--file', planFile, '--id', 'T4', '--phase', 'P1', '--title', 'Impossible task']);
    mustJson(['complete', 'T1', '--file', planFile]);
    mustJson(['start', 'T2', '--file', planFile, '--owner', 'worker-a']);
    mustJson(['mark-error', 'T3', '--file', planFile, '--reason', 'boom <script>']);
    mustJson(['mark-impossible', 'T4', '--file', planFile, '--reason', 'blocked']);

    const term = runCliSync(['render', '--file', planFile, '--format', 'terminal'], { env: { NO_COLOR: '1' } });
    assert.strictEqual(term.status, 0);
    assert(!/\x1b\[/.test(term.stdout), 'NO_COLOR must strip ANSI escape sequences');
    for (const badge of ['[✓ 已完成]', '[▶ 进行中]', '[✗ 出错]', '[⊘ 无法完成]']) {
      assert(term.stdout.includes(badge), `terminal output missing badge ${badge}`);
    }

    const txt = runCliSync(['render', '--file', planFile, '--format', 'text']);
    assert.strictEqual(txt.status, 0);
    assert(!/\x1b\[/.test(txt.stdout), 'text format must not include ANSI escape sequences');

    const brief = runCliSync(['render', '--file', planFile, '--format', 'brief']);
    assert.strictEqual(brief.status, 0);
    assert(brief.stdout.includes('T2') && brief.stdout.includes('T3'));

    const md = runCliSync(['render', '--file', planFile, '--format', 'markdown']);
    assert.strictEqual(md.status, 0);
    assert(md.stdout.includes('- [x]'));
    assert(md.stdout.includes('- [ ]'));
    assert(md.stdout.includes('<details>'));

    const htmlRes = runCliSync(['render', '--file', planFile, '--format', 'html']);
    assert.strictEqual(htmlRes.status, 0);
    const html = htmlRes.stdout;
    assert(html.includes("default-src 'none'"));
    assert(html.includes('role="progressbar"'));
    assert(html.includes('aria-pressed'));
    const plan = readPlanJson(planFile);
    assert(html.includes(plan.updatedAt), 'html must display updatedAt');
    assert(html.includes('&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;'), 'html body must escape XSS');
    assert(html.includes('\\u003c/script\\u003e'), 'embedded JSON script must escape </script>');
    assert(!html.includes('</script><img'), 'raw XSS payload must never appear in HTML');
  });

  await test('sidecar auto-sync updates TODO.md and progress.html and preserves plan on VIEW_SYNC_FAILED', async (tmpDir) => {
    const planFile = path.join(tmpDir, 'plan.json');
    const mdFile = path.join(tmpDir, 'TODO.md');
    const htmlFile = path.join(tmpDir, 'progress.html');
    mustJson(['init', '--file', planFile, '--title', 'Sidecars', '--goal', 'Auto sync', '--sync-md', 'TODO.md', '--sync-html', 'progress.html']);
    assert(fs.existsSync(mdFile));
    assert(fs.existsSync(htmlFile));

    mustJson(['add-phase', '--file', planFile, '--id', 'P1', '--title', 'P1', '--goal', 'G1']);
    mustJson(['add-task', '--file', planFile, '--id', 'T1', '--phase', 'P1', '--title', 'Task One']);
    assert(fs.readFileSync(mdFile, 'utf8').includes('Task One'));
    assert(fs.readFileSync(htmlFile, 'utf8').includes('Task One'));

    // Point markdown view to an existing directory so atomic write/rename fails cleanly with VIEW_SYNC_FAILED
    const badDir = path.join(tmpDir, 'dir-as-md-view');
    fs.mkdirSync(badDir);
    mustJson(['configure-views', '--file', planFile, '--sync-md', 'dir-as-md-view']);
    const afterWarn = mustJson(['complete', 'T1', '--file', planFile]);
    assert(
      Array.isArray(afterWarn.warnings) && afterWarn.warnings.some((w) => w.code === 'VIEW_SYNC_FAILED'),
      `expected VIEW_SYNC_FAILED warning, got ${JSON.stringify(afterWarn.warnings)}`,
    );
    assert.strictEqual(readPlanJson(planFile).phases[0].tasks[0].status, 'completed');
  });

  await test('path security enforces --root containment, rejects symlinks when creatable, and guards non-TTY watch', async (tmpDir) => {
    const sandbox = path.join(tmpDir, 'sandbox');
    fs.mkdirSync(sandbox);
    const outsidePlan = path.join(tmpDir, 'outside.json');

    mustFailJson(
      ['init', '--file', '../outside.json', '--root', sandbox, '--title', 'Escape', '--goal', 'Blocked'],
      4,
      'PATH_SECURITY_VIOLATION',
      { cwd: sandbox },
    );
    assert(!fs.existsSync(outsidePlan));

    // Symlink check: skip gracefully only if the OS denies creating symlinks (e.g. Windows without Developer Mode)
    const symlinkTarget = path.join(tmpDir, 'real-target.json');
    fs.writeFileSync(symlinkTarget, '{}', 'utf8');
    const symlinkPath = path.join(sandbox, 'link-plan.json');
    let symlinkCreated = false;
    try {
      fs.symlinkSync(symlinkTarget, symlinkPath, 'file');
      symlinkCreated = true;
    } catch (err) {
      if (!err || !['EPERM', 'EACCES'].includes(err.code)) throw err;
    }
    if (symlinkCreated) {
      mustFailJson(['status', '--file', symlinkPath, '--root', sandbox], 4, 'PATH_SECURITY_VIOLATION');
    }

    const validPlan = path.join(sandbox, 'plan.json');
    mustJson(['init', '--file', validPlan, '--root', sandbox, '--title', 'Watch', '--goal', 'Guard']);

    const forbiddenWatch = runCliSync(['--json', 'render', '--file', validPlan, '--format', 'text', '--watch']);
    assert.strictEqual(forbiddenWatch.status, 2);
    assert.strictEqual(forbiddenWatch.json.code, 'WATCH_NON_TTY_FORBIDDEN');

    const boundedWatch = runCliSync([
      'render', '--file', validPlan, '--format', 'text', '--watch', '--allow-non-tty', '--max-seconds', '3', '--max-events', '1',
    ], { timeoutMs: 8000 });
    assert.strictEqual(boundedWatch.status, 0, `bounded watch failed: ${boundedWatch.stderr}`);
    assert(boundedWatch.stdout.includes('Watch'));
  });

  // Group 5: Real Multi-Process Concurrency & V1.2 Race Protection Tests
  await test('8 concurrent multi-process updates preserve every update, revision, and synced views', async (tmpDir) => {
    const planFile = path.join(tmpDir, 'plan.json');
    mustJson([
      'init', '--file', planFile, '--title', 'Concurrency', '--goal', 'No lost updates',
      '--sync-md', 'TODO.md', '--sync-html', 'progress.html',
    ]);
    mustJson(['add-phase', '--file', planFile, '--id', 'P1', '--title', 'P1', '--goal', 'G1']);
    for (let i = 1; i <= 4; i += 1) {
      mustJson(['add-task', '--file', planFile, '--id', `T${i}`, '--phase', 'P1', '--title', `Initial ${i}`]);
    }
    const baseRevision = readPlanJson(planFile).revision;

    const jobs = [
      runCliAsync(['--json', 'complete', 'T1', '--file', planFile, '--lock-wait-ms', '10000']),
      runCliAsync(['--json', 'complete', 'T2', '--file', planFile, '--lock-wait-ms', '10000']),
      runCliAsync(['--json', 'complete', 'T3', '--file', planFile, '--lock-wait-ms', '10000']),
      runCliAsync(['--json', 'complete', 'T4', '--file', planFile, '--lock-wait-ms', '10000']),
      runCliAsync(['--json', 'add-task', '--file', planFile, '--phase', 'P1', '--title', 'Added A', '--lock-wait-ms', '10000']),
      runCliAsync(['--json', 'add-task', '--file', planFile, '--phase', 'P1', '--title', 'Added B', '--lock-wait-ms', '10000']),
      runCliAsync(['--json', 'add-task', '--file', planFile, '--phase', 'P1', '--title', 'Added C', '--lock-wait-ms', '10000']),
      runCliAsync(['--json', 'add-task', '--file', planFile, '--phase', 'P1', '--title', 'Added D', '--lock-wait-ms', '10000']),
    ];
    const results = await Promise.all(jobs);
    for (const r of results) {
      assert.strictEqual(r.status, 0, `concurrent write failed: ${r.stdout} ${r.stderr}`);
    }

    const finalPlan = readPlanJson(planFile);
    assert.strictEqual(finalPlan.revision, baseRevision + 8);
    assert.strictEqual(finalPlan.phases[0].tasks.length, 8);
    assert.strictEqual(finalPlan.phases[0].tasks.filter((t) => t.status === 'completed').length, 4);
    const mdText = fs.readFileSync(path.join(tmpDir, 'TODO.md'), 'utf8');
    const htmlText = fs.readFileSync(path.join(tmpDir, 'progress.html'), 'utf8');
    assert(mdText.includes(String(finalPlan.revision)), 'TODO.md must reflect final revision');
    assert(htmlText.includes(String(finalPlan.revision)), 'progress.html must reflect final revision');
  });

  await test('6 concurrent claim-next processes yield strictly 3 unique claims and 3 NO_READY_TASK', async (tmpDir) => {
    const planFile = path.join(tmpDir, 'plan.json');
    mustJson(['init', '--file', planFile, '--title', 'Claim', '--goal', 'Exclusive']);
    mustJson(['add-phase', '--file', planFile, '--id', 'P1', '--title', 'P1', '--goal', 'G1']);
    for (let i = 1; i <= 3; i += 1) {
      mustJson(['add-task', '--file', planFile, '--id', `T${i}`, '--phase', 'P1', '--title', `Ready ${i}`]);
    }

    const workers = Array.from({ length: 6 }, (_, i) => runCliAsync([
      '--json', 'claim-next', '--file', planFile, '--owner', `worker-${i + 1}`,
      '--actor', `worker-${i + 1}`, '--role', 'author', '--lock-wait-ms', '10000',
    ]));
    const results = await Promise.all(workers);
    for (const r of results) {
      assert.strictEqual(r.status, 0, `claim-next failed: ${r.stdout} ${r.stderr}`);
    }

    const claimed = results.filter((r) => r.json && r.json.claimed === true);
    const empty = results.filter((r) => r.json && r.json.claimed === false && r.json.code === 'NO_READY_TASK');
    assert.strictEqual(claimed.length, 3, `expected 3 claims, got ${claimed.length}`);
    assert.strictEqual(empty.length, 3, `expected 3 NO_READY_TASK, got ${empty.length}`);

    const claimedIds = new Set(claimed.map((r) => r.json.task.id));
    const claimedOwners = new Set(claimed.map((r) => r.json.task.owner));
    assert.strictEqual(claimedIds.size, 3, 'every claimed taskId must be unique');
    assert.strictEqual(claimedOwners.size, 3, 'every claim owner must be unique');
  });

  await test('role and ownership guards enforce TASK_ALREADY_CLAIMED, NOT_TASK_OWNER, ROLE_FORBIDDEN, and coordinator reassign', async (tmpDir) => {
    const planFile = path.join(tmpDir, 'plan.json');
    mustJson(['init', '--file', planFile, '--title', 'Roles', '--goal', 'Isolation']);
    mustJson(['add-phase', '--file', planFile, '--id', 'P1', '--title', 'P1', '--goal', 'G1']);
    mustJson(['add-task', '--file', planFile, '--id', 'T1', '--phase', 'P1', '--title', 'T1']);

    mustJson(['start', 'T1', '--file', planFile, '--owner', 'w1', '--actor', 'w1', '--role', 'author']);
    mustFailJson(['start', 'T1', '--file', planFile, '--owner', 'w2'], 3, 'TASK_ALREADY_CLAIMED');
    mustFailJson(['complete', 'T1', '--file', planFile, '--actor', 'w2', '--role', 'author'], 3, 'NOT_TASK_OWNER');
    mustFailJson(['add-phase', '--file', planFile, '--title', 'P2', '--goal', 'G2', '--actor', 'w2', '--role', 'author'], 3, 'ROLE_FORBIDDEN');

    mustFailJson(['complete', 'T1', '--file', planFile, '--actor', 'v1', '--role', 'verifier'], 3, 'ROLE_FORBIDDEN');
    mustFailJson(['add-task', '--file', planFile, '--phase', 'P1', '--title', 'X', '--actor', 'v1', '--role', 'verifier'], 3, 'ROLE_FORBIDDEN');
    mustJson(['update-task', 'T1', '--file', planFile, '--actor', 'v1', '--role', 'verifier', '--evidence', 'test/log.txt', '--note', 'checked']);
    mustJson(['mark-error', 'T1', '--file', planFile, '--actor', 'v1', '--role', 'verifier', '--reason', 'regression found']);

    mustJson(['reopen', 'T1', '--file', planFile, '--actor', 'coord', '--role', 'coordinator', '--reason', 'fix assigned']);
    mustJson(['start', 'T1', '--file', planFile, '--owner', 'w1', '--actor', 'coord', '--role', 'coordinator']);
    mustJson(['start', 'T1', '--file', planFile, '--owner', 'w2', '--reassign', '--reason', 'handoff', '--actor', 'coord', '--role', 'coordinator']);
    assert.strictEqual(readPlanJson(planFile).phases[0].tasks[0].owner, 'w2');
  });

  await test('lock contention preserves foreign lock and recover-lock requires exact expected nonce', async (tmpDir) => {
    const planFile = path.join(tmpDir, 'plan.json');
    const lockFile = `${planFile}.lock`;
    mustJson(['init', '--file', planFile, '--title', 'Locking', '--goal', 'Safe recovery']);
    mustJson(['add-phase', '--file', planFile, '--id', 'P1', '--title', 'P1', '--goal', 'G1']);

    const foreignLock = {
      nonce: 'foreign-nonce-1',
      pid: 999999,
      actor: 'other-worker',
      acquiredAt: new Date().toISOString(),
    };
    fs.writeFileSync(lockFile, JSON.stringify(foreignLock), 'utf8');

    mustFailJson(
      ['add-task', '--file', planFile, '--phase', 'P1', '--title', 'Blocked', '--lock-wait-ms', '150'],
      3,
      'STATE_LOCKED',
    );
    assert(fs.existsSync(lockFile), 'STATE_LOCKED must never remove foreign lock');
    assert.strictEqual(JSON.parse(fs.readFileSync(lockFile, 'utf8')).nonce, 'foreign-nonce-1');

    mustFailJson(['recover-lock', '--file', planFile, '--expected-nonce', 'wrong-nonce'], 3, 'LOCK_RECOVERY_MISMATCH');
    assert(fs.existsSync(lockFile));

    const recovered = mustJson(['recover-lock', '--file', planFile, '--expected-nonce', 'foreign-nonce-1']);
    assert.strictEqual(recovered.code, 'LOCK_RECOVERED');
    assert(!fs.existsSync(lockFile), 'recover-lock with matching nonce must remove .lock');
  });

  await test('requestId idempotency replay/conflict, DW_TODO_PLAN_PATH env, and SHARED_RELATIVE_PATH_WARNING', async (tmpDir) => {
    const planFile = path.join(tmpDir, 'plan.json');
    mustJson(['init', '--file', planFile, '--title', 'Idempotency', '--goal', 'Replay']);
    mustJson(['add-phase', '--file', planFile, '--id', 'P1', '--title', 'P1', '--goal', 'G1']);

    const first = mustJson(['add-task', '--file', planFile, '--phase', 'P1', '--title', 'Unique Task', '--request-id', 'req-1']);
    assert.strictEqual(Boolean(first.idempotentReplay), false);

    const replay = mustJson(['add-task', '--file', planFile, '--phase', 'P1', '--title', 'Unique Task', '--request-id', 'req-1']);
    assert.strictEqual(replay.idempotentReplay, true);
    assert.strictEqual(replay.revision, first.revision);
    assert.strictEqual(readPlanJson(planFile).phases[0].tasks.length, 1);

    mustFailJson(
      ['add-task', '--file', planFile, '--phase', 'P1', '--title', 'Different Task', '--request-id', 'req-1'],
      2,
      'REQUEST_ID_CONFLICT',
    );

    const viaEnv = mustJson(['status'], { env: { DW_TODO_PLAN_PATH: planFile } });
    assert.strictEqual(viaEnv.summary.counts.totalTasks, 1);

    const relWarn = mustJson(
      ['add-task', '--file', 'plan.json', '--phase', 'P1', '--title', 'Relative Path Task', '--actor', 'w1', '--role', 'author'],
      { cwd: tmpDir },
    );
    assert(
      Array.isArray(relWarn.warnings) && relWarn.warnings.some((w) => w.code === 'SHARED_RELATIVE_PATH_WARNING'),
      `expected SHARED_RELATIVE_PATH_WARNING, got ${JSON.stringify(relWarn.warnings)}`,
    );
  });

  if (!process.exitCode) {
    console.log(`${passed}/${total} todo-plan tests passed`);
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
