#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  ResourceAwareQueue,
  evaluateGpuTarget,
} = require('../skills/dw-collaboration/scripts/lib/resource-aware-queue');
const {
  TaskResourceTracker,
} = require('../skills/dw-collaboration/scripts/lib/task-resource-tracker');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const policy = {
  maxConcurrent: 2,
  maxWaitMs: 30000,
  backfillWindowMs: 10000,
  gpuOptimizationTarget: 0.85,
  allowGpuOptimization: true,
  maxTasks: 20,
};

function profile(taskId, overrides = {}) {
  const base = {
    version: 1,
    taskId,
    priority: 10,
    dependencies: [],
    authorizationRef: `authorization:${taskId}`,
    trackedResourceIds: [`resource:${taskId}`],
    scopeBinding: {
      ownerId: 'root',
      runId: 'queue-run',
      scopeId: `scope:${taskId}`,
      generation: 1,
    },
    resources: {
      cpuCores: 2,
      ramBytes: 1024,
      ioUnits: 1,
      gpu: {
        count: 1,
        vramSoftBytes: 2000,
        vramHardBytes: 3000,
        capabilities: ['compute'],
        deviceMode: 'exclusive',
      },
    },
    duration: { expectedMs: 5000, maxMs: 10000, confidence: 'measured' },
    preemptible: false,
    checkpoint: null,
    enqueuedAt: 1000,
  };
  return {
    ...base,
    ...overrides,
    resources: { ...base.resources, ...(overrides.resources || {}) },
    duration: { ...base.duration, ...(overrides.duration || {}) },
  };
}

function observation(overrides = {}) {
  const base = {
    observed: true,
    nowMs: 2000,
    cpuCores: 8,
    ramBytes: 16000,
    ioUnits: 8,
    foregroundHealthy: true,
    externalLeasesProtected: true,
    thermalSafe: true,
    powerSafe: true,
    oomRisk: false,
    gpu: {
      count: 1,
      physicalVramBytes: 12000,
      driverVramBytes: 1000,
      desktopVramBytes: 1000,
      externalVramBytes: 1000,
      foregroundReserveVramBytes: 1000,
      safetyReserveVramBytes: 1000,
      taskVramBytes: 0,
      usefulComputeUtilization: 0.0,
      capabilities: ['compute', 'tensor-cores'],
    },
  };
  return {
    ...base,
    ...overrides,
    gpu: { ...base.gpu, ...(overrides.gpu || {}) },
  };
}

function makeHarness(policyOverrides = {}, queueOverrides = {}) {
  const tracker = new TaskResourceTracker({
    ownerId: 'root',
    runId: 'queue-run',
    generation: 1,
    trustedObservationResolver: () => true,
  });
  const root = tracker.openRootScope({ scopeId: 'queue-root', purpose: 'queue root' });
  const scopes = new Map();
  const registeredResources = new Map();
  const releasedResources = new Set();
  const taskProfiles = new Map();
  const queue = new ResourceAwareQueue({
    policy: { ...policy, ...policyOverrides },
    tracker,
    authorizationResolver: queueOverrides.authorizationResolver
      || (({ profile: input }) => input.authorizationRef === `authorization:${input.taskId}`),
  });
  return {
    queue,
    tracker,
    enqueue(input, { createScope = true } = {}) {
      const binding = input.scopeBinding;
      if (createScope && binding && !scopes.has(binding.scopeId)) {
        scopes.set(binding.scopeId, root.openChild({
          scopeId: binding.scopeId,
          ownerId: 'root',
          purpose: `queue task ${input.taskId}`,
        }));
      }
      const scope = binding ? scopes.get(binding.scopeId) : null;
      if (scope && Array.isArray(input.trackedResourceIds)) {
        for (const resourceId of input.trackedResourceIds) {
          if (registeredResources.has(resourceId)) continue;
          const identity = { kind: 'synthetic-queue-resource', resourceId };
          scope.register({
            resourceId,
            type: 'artifact',
            purpose: `queue allocation ${resourceId}`,
            teardownCondition: 'task_scope_close',
            quota: { kind: 'synthetic-test', value: 1 },
            evidenceRefs: [`declare:${resourceId}`],
          });
          scope.bind(resourceId, {
            identity,
            generation: 1,
            evidenceRefs: [`bind:${resourceId}`],
          });
          registeredResources.set(resourceId, { identity, scopeId: binding.scopeId });
        }
      }
      taskProfiles.set(input.taskId, input);
      return queue.enqueue(input);
    },
    close(taskId) {
      const input = taskProfiles.get(taskId);
      const scope = scopes.get(input.scopeBinding.scopeId);
      for (const resourceId of input.trackedResourceIds) {
        if (releasedResources.has(resourceId)) continue;
        const registered = registeredResources.get(resourceId);
        scope.confirmRelease(resourceId, {
          identity: registered.identity,
          generation: 1,
          absenceVerified: true,
          evidenceRefs: [`release:${resourceId}`],
        });
        releasedResources.add(resourceId);
      }
      return scope.close('queue task finished');
    },
  };
}

test('blocks admission when profile, observation, authorization, or root scope is incomplete', () => {
  assert.throws(() => new ResourceAwareQueue({ policy }), /TRACKER_REQUIRED/);
  const harness = makeHarness();
  harness.enqueue(profile('missing-profile', { resources: { gpu: { count: 1 } } }));
  harness.enqueue(profile('unauthorized', { authorizationRef: 'not-authorized' }));
  harness.enqueue(profile('no-scope', {
    scopeBinding: { ownerId: 'root', runId: 'queue-run', scopeId: 'missing', generation: 1 },
  }), { createScope: false });
  const unobserved = harness.queue.schedule({ ...observation(), observed: false });
  assert.deepStrictEqual(unobserved.start, []);
  assert.strictEqual(unobserved.action, 'HOLD');
  const observed = harness.queue.schedule(observation());
  assert.strictEqual(observed.tasks['missing-profile'].state, 'blocked');
  assert.strictEqual(observed.tasks.unauthorized.state, 'blocked');
  assert.strictEqual(observed.tasks['no-scope'].state, 'blocked');
});

test('requires tracked resources and gives one task the exclusive claim on a scope', () => {
  const harness = makeHarness();
  const missingResources = harness.enqueue(profile('missing-resources', { trackedResourceIds: [] }));
  const sharedBinding = {
    ownerId: 'root',
    runId: 'queue-run',
    scopeId: 'scope:shared-claim',
    generation: 1,
  };
  const first = harness.enqueue(profile('first-claim', {
    scopeBinding: sharedBinding,
    trackedResourceIds: ['resource:shared-claim'],
  }));
  const second = harness.enqueue(profile('second-claim', {
    scopeBinding: sharedBinding,
    trackedResourceIds: ['resource:shared-claim'],
  }));

  assert.strictEqual(missingResources.state, 'blocked');
  assert(missingResources.reasons.includes('TRACKED_RESOURCE_IDS_INVALID'));
  assert.strictEqual(first.state, 'ready');
  assert.strictEqual(second.state, 'blocked');
  assert(second.reasons.includes('TASK_SCOPE_CLAIM_REJECTED'));
  assert.deepStrictEqual(harness.queue.schedule(observation()).start, ['first-claim']);
});

test('rejects synchronous schedule reentry without starting the same task twice', () => {
  let queue;
  let authorizationCalls = 0;
  let reentrantResult = null;
  let reentrantError = null;
  const harness = makeHarness({}, {
    authorizationResolver: () => {
      authorizationCalls += 1;
      if (authorizationCalls === 2) {
        try {
          reentrantResult = queue.schedule(observation());
        } catch (error) {
          reentrantError = error;
        }
      }
      return true;
    },
  });
  queue = harness.queue;
  harness.enqueue(profile('reentrant'));

  const result = queue.schedule(observation());

  assert.strictEqual(reentrantResult, null);
  assert.strictEqual(reentrantError && reentrantError.code, 'QUEUE_REENTRANT_OPERATION');
  assert.deepStrictEqual(result.start, ['reentrant']);
  assert.strictEqual(result.tasks.reentrant.state, 'running');
  assert.strictEqual(result.tasks.reentrant.startedAt, 2000);
});

test('fits CPU, RAM, IO, GPU count, VRAM hard budget, and the concurrency cap together', () => {
  const harness = makeHarness({ maxConcurrent: 1 });
  harness.enqueue(profile('first'));
  harness.enqueue(profile('second'));
  const result = harness.queue.schedule(observation());
  assert.deepStrictEqual(result.start, ['first']);
  assert.strictEqual(result.tasks.first.state, 'running');
  assert.strictEqual(result.tasks.second.state, 'ready');
  assert.strictEqual(result.capacity.schedulableVramBytes, 7000);
});

test('reports capacity after applying starts from the current scheduling decision', () => {
  const harness = makeHarness({ maxConcurrent: 1 });
  harness.enqueue(profile('started'));

  const result = harness.queue.schedule(observation());

  assert.deepStrictEqual(result.start, ['started']);
  assert.deepStrictEqual(result.capacity.used, {
    cpuCores: 2,
    ramBytes: 1024,
    ioUnits: 1,
    gpuDevices: 1,
    vramBytes: 3000,
  });
  assert.strictEqual(result.capacity.available.gpuDevices, 0);
  assert.strictEqual(result.capacity.available.vramBytes, 4000);
});

test('backfills a fitting short task while keeping a reservation for an aging head task', () => {
  const harness = makeHarness();
  harness.enqueue(profile('long-task', {
    priority: 20,
    enqueuedAt: 0,
    resources: { gpu: { count: 1, vramSoftBytes: 6500, vramHardBytes: 7500, capabilities: ['compute'], deviceMode: 'exclusive' } },
    duration: { expectedMs: 30000, maxMs: 60000, confidence: 'measured' },
  }));
  harness.enqueue(profile('short-task', {
    priority: 5,
    enqueuedAt: 15000,
    resources: { gpu: { count: 1, vramSoftBytes: 1000, vramHardBytes: 1500, capabilities: ['compute'], deviceMode: 'exclusive' } },
    duration: { expectedMs: 2000, maxMs: 4000, confidence: 'measured' },
  }));
  const result = harness.queue.schedule(observation({ nowMs: 20000 }));
  assert.deepStrictEqual(result.start, ['short-task']);
  assert.strictEqual(result.tasks['long-task'].state, 'ready');
  assert(result.reservations.some((item) => item.taskId === 'long-task'));
});

test('prevents starvation by refusing backfill that crosses the reserved start window', () => {
  const harness = makeHarness();
  harness.enqueue(profile('aging-task', {
    priority: 20,
    enqueuedAt: 0,
    resources: { gpu: { count: 1, vramSoftBytes: 6500, vramHardBytes: 7500, capabilities: ['compute'], deviceMode: 'exclusive' } },
  }));
  harness.enqueue(profile('too-long-backfill', {
    priority: 5,
    enqueuedAt: 29999,
    duration: { expectedMs: 5000, maxMs: 10000, confidence: 'measured' },
  }));
  const result = harness.queue.schedule(observation({ nowMs: 29999 }));
  assert.deepStrictEqual(result.start, []);
  assert(result.reservations.some((item) => item.taskId === 'aging-task'));
});

test('does not treat checkpoint metadata as implemented backfill preemption', () => {
  const harness = makeHarness();
  harness.enqueue(profile('aging-task', {
    priority: 20,
    enqueuedAt: 0,
    resources: { gpu: { count: 1, vramSoftBytes: 6500, vramHardBytes: 7500, capabilities: ['compute'], deviceMode: 'exclusive' } },
  }));
  harness.enqueue(profile('preemptible-too-long', {
    priority: 5,
    enqueuedAt: 29999,
    duration: { expectedMs: 5000, maxMs: 10000, confidence: 'measured' },
    preemptible: true,
    checkpoint: { resumeSupported: true, maxPauseLatencyMs: 0 },
  }));

  const result = harness.queue.schedule(observation({ nowMs: 29999 }));

  assert.deepStrictEqual(result.start, []);
  assert.strictEqual(result.tasks['preemptible-too-long'].state, 'ready');
});

test('does not refill capacity until the tracker close result proves release', () => {
  const harness = makeHarness({ maxConcurrent: 1 });
  harness.enqueue(profile('task-a'));
  harness.enqueue(profile('task-b'));
  assert.deepStrictEqual(harness.queue.schedule(observation()).start, ['task-a']);
  assert.strictEqual(harness.queue.beginDrain('task-a', 'completed').state, 'draining');
  assert.deepStrictEqual(harness.queue.schedule(observation()).start, []);
  assert.strictEqual(harness.queue.confirmReleased('task-a', { status: 'CLOSED' }).state, 'draining');
  assert.deepStrictEqual(harness.queue.schedule(observation()).start, []);
  const exactClose = harness.close('task-a');
  assert.strictEqual(harness.queue.confirmReleased('task-a', {
    ...exactClose,
    scopeId: 'scope:other-task',
  }).state, 'draining');
  assert.strictEqual(harness.queue.confirmReleased('task-a', exactClose).state, 'completed');
  assert.deepStrictEqual(harness.queue.schedule(observation()).start, ['task-b']);
});

test('keeps dependencies blocked until their accepted result and release are both recorded', () => {
  const harness = makeHarness();
  harness.enqueue(profile('parent'));
  harness.enqueue(profile('child', { dependencies: ['parent'] }));
  harness.queue.schedule(observation());
  harness.queue.beginDrain('parent', 'completed');
  let result = harness.queue.schedule(observation());
  assert.strictEqual(result.tasks.child.state, 'blocked');
  harness.queue.confirmReleased('parent', harness.close('parent'));
  result = harness.queue.schedule(observation());
  assert(result.start.includes('child'));
});

test('reduces concurrency before chasing utilization when OOM, thermal, power, or foreground risk appears', () => {
  for (const unsafe of [
    { oomRisk: true },
    { thermalSafe: false },
    { powerSafe: false },
    { foregroundHealthy: false },
    { externalLeasesProtected: false },
  ]) {
    const harness = makeHarness();
    harness.enqueue(profile(`unsafe-${Object.keys(unsafe)[0]}`));
    const result = harness.queue.schedule(observation(unsafe));
    assert.deepStrictEqual(result.start, []);
    assert(['REDUCE_CONCURRENCY', 'HOLD'].includes(result.action));
  }
});

test('reports schedulable VRAM and useful compute separately as conditional targets', () => {
  const report = evaluateGpuTarget({
    policy,
    observation: observation({
      gpu: { taskVramBytes: 5040, usefulComputeUtilization: 0.91 },
    }),
    usefulRunnableWork: true,
    workloadParallelizable: true,
  });
  assert.strictEqual(report.applicable, true);
  assert.strictEqual(report.schedulableVramOccupancy, 0.72);
  assert.strictEqual(report.usefulComputeUtilization, 0.91);
  assert.strictEqual(report.met, false);
  assert.strictEqual(report.action, 'CONTINUE_SAFE_WORK');
  assert.strictEqual(report.target, 0.85);
});

test('keeps the GPU target applicable for useful running work without a ready candidate', () => {
  const harness = makeHarness({ maxConcurrent: 1 });
  harness.enqueue(profile('running-gpu'));
  assert.deepStrictEqual(harness.queue.schedule(observation()).start, ['running-gpu']);

  const result = harness.queue.schedule(observation({ nowMs: 3000 }));

  assert.deepStrictEqual(result.start, []);
  assert.strictEqual(result.gpuTarget.applicable, true);
  assert.strictEqual(result.gpuTarget.runningUsefulWork, true);
  assert.strictEqual(result.gpuTarget.schedulableCandidateWork, false);
});

test('requires a bounded sustained GPU observation window before reporting the target met', () => {
  const targetInput = (gpuOverrides) => ({
    policy,
    observation: observation({
      nowMs: 3000,
      gpu: {
        taskVramBytes: 6300,
        usefulComputeUtilization: 0.95,
        ...gpuOverrides,
      },
    }),
    usefulRunnableWork: true,
    workloadParallelizable: true,
  });
  const sample = (timestampMs, taskVramBytes, usefulComputeUtilization) => ({
    timestampMs,
    schedulableVramBytes: 7000,
    taskVramBytes,
    usefulComputeUtilization,
  });

  const pointOnly = evaluateGpuTarget(targetInput({}));
  const spike = evaluateGpuTarget(targetInput({
    window: {
      version: 1,
      samples: [
        sample(1000, 1400, 0.2),
        sample(2000, 1400, 0.2),
        sample(3000, 6300, 0.95),
      ],
    },
  }));
  const sustainedInput = targetInput({
    window: {
      version: 1,
      samples: [
        sample(1000, 6300, 0.9),
        sample(2000, 6300, 0.9),
        sample(3000, 6300, 0.9),
      ],
    },
  });
  const sustained = evaluateGpuTarget(sustainedInput);
  const tooManySamples = Array.from({ length: 121 }, (_, index) => (
    sample(index * 500, 6300, 0.9)
  ));
  const oversized = evaluateGpuTarget({
    ...targetInput({ window: { version: 1, samples: tooManySamples } }),
    observation: observation({
      nowMs: 60000,
      gpu: {
        taskVramBytes: 6300,
        usefulComputeUtilization: 0.95,
        window: { version: 1, samples: tooManySamples },
      },
    }),
  });

  assert.strictEqual(pointOnly.met, false);
  assert(pointOnly.reasons.includes('GPU_WINDOW_REQUIRED'));
  assert.strictEqual(spike.met, false);
  assert.strictEqual(spike.window.sustained, false);
  assert.strictEqual(sustained.met, true);
  assert.strictEqual(sustained.window.sampleCount, 3);
  assert.strictEqual(sustained.window.durationMs, 2000);
  assert(Object.isFrozen(sustained.window));
  assert.strictEqual(oversized.met, false);
  assert(oversized.reasons.includes('GPU_WINDOW_INVALID'));

  const scheduled = makeHarness();
  scheduled.enqueue(profile('window-snapshot'));
  scheduled.queue.schedule(sustainedInput.observation);
  sustainedInput.observation.gpu.window.samples[0].taskVramBytes = 0;
  const snapshot = scheduled.queue.snapshot();
  assert.strictEqual(snapshot.lastObservation.gpu.window.samples[0].taskVramBytes, 6300);
  assert(Object.isFrozen(snapshot.lastObservation.gpu.window.samples));
});

test('does not apply the 85 percent target to unsuitable work or manufacture filler load', () => {
  for (const input of [
    { usefulRunnableWork: false, workloadParallelizable: true, bottleneck: null },
    { usefulRunnableWork: true, workloadParallelizable: false, bottleneck: 'low_parallelism' },
    { usefulRunnableWork: true, workloadParallelizable: true, bottleneck: 'io' },
    { usefulRunnableWork: true, workloadParallelizable: true, bottleneck: 'memory' },
  ]) {
    const report = evaluateGpuTarget({ policy, observation: observation(), ...input });
    assert.strictEqual(report.applicable, false);
    assert.strictEqual(report.action, 'NOT_APPLICABLE');
    assert.strictEqual(report.syntheticLoadAllowed, false);
  }
});

test('returns deterministic immutable snapshots', () => {
  const harness = makeHarness();
  harness.enqueue(profile('stable'));
  const result = harness.queue.schedule(observation());
  assert(Object.isFrozen(result));
  assert(Object.isFrozen(result.tasks));
  assert.deepStrictEqual(harness.queue.snapshot(), harness.queue.snapshot());
});

test('keeps public policy and tracker authority references read-only', () => {
  const harness = makeHarness();
  const originalPolicy = harness.queue.policy;
  const originalTracker = harness.queue.tracker;
  const originalAuthorizationResolver = harness.queue.authorizationResolver;

  assert.throws(() => { harness.queue.policy = { ...policy, maxConcurrent: 99 }; }, TypeError);
  assert.throws(() => { harness.queue.tracker = null; }, TypeError);
  assert.throws(() => { harness.queue.authorizationResolver = () => true; }, TypeError);
  assert.strictEqual(harness.queue.policy, originalPolicy);
  assert.strictEqual(harness.queue.tracker, originalTracker);
  assert.strictEqual(harness.queue.authorizationResolver, originalAuthorizationResolver);
});

test('promotes an aged low-priority task ahead of a fresh high-priority task', () => {
  const harness = makeHarness({ maxConcurrent: 1 });
  harness.enqueue(profile('aged', { priority: 1, enqueuedAt: 0, resources: { gpu: { count: 0, vramSoftBytes: 0, vramHardBytes: 0, capabilities: [], deviceMode: 'none' } } }));
  harness.enqueue(profile('fresh', { priority: 100, enqueuedAt: 30000, resources: { gpu: { count: 0, vramSoftBytes: 0, vramHardBytes: 0, capabilities: [], deviceMode: 'none' } } }));
  assert.deepStrictEqual(harness.queue.schedule(observation({ nowMs: 30001 })).start, ['aged']);
});

test('accounts for exclusive GPU devices and required capabilities', () => {
  const harness = makeHarness({ maxConcurrent: 3 });
  harness.enqueue(profile('first'));
  harness.enqueue(profile('second'));
  harness.enqueue(profile('unsupported', {
    resources: { gpu: { count: 1, vramSoftBytes: 1000, vramHardBytes: 1000, capabilities: ['fp64-special'], deviceMode: 'exclusive' } },
  }));
  const result = harness.queue.schedule(observation({ gpu: { count: 1 } }));
  assert.deepStrictEqual(result.start, ['first']);
  assert.strictEqual(result.tasks.unsupported.state, 'ready');
  assert.strictEqual(result.capacity.available.gpuDevices, 0);
});

test('does not mix shared and exclusive work on an unidentified GPU device', () => {
  for (const [firstMode, secondMode] of [
    ['shared', 'exclusive'],
    ['exclusive', 'shared'],
  ]) {
    const harness = makeHarness({ maxConcurrent: 3 });
    const firstTaskId = `a-${firstMode}`;
    const secondTaskId = `b-${secondMode}`;
    for (const [taskId, deviceMode] of [
      [firstTaskId, firstMode],
      [secondTaskId, secondMode],
    ]) {
      harness.enqueue(profile(taskId, {
        resources: {
          gpu: {
            count: 1,
            vramSoftBytes: 1000,
            vramHardBytes: 1000,
            capabilities: ['compute'],
            deviceMode,
          },
        },
      }));
    }

    const result = harness.queue.schedule(observation({ gpu: { count: 1 } }));

    assert.deepStrictEqual(result.start, [firstTaskId]);
    assert.strictEqual(result.tasks[secondTaskId].state, 'ready');
  }
});

test('rejects reserved task IDs and bounds retained terminal tasks', () => {
  const harness = makeHarness({ maxTasks: 1 });
  assert.throws(() => harness.enqueue(profile('__proto__')), /TASK_ID_INVALID/);
  harness.enqueue(profile('one'));
  assert.throws(() => harness.enqueue(profile('two')), /QUEUE_TASK_LIMIT_REACHED/);
  harness.queue.schedule(observation());
  harness.queue.beginDrain('one', 'completed');
  harness.queue.confirmReleased('one', harness.close('one'));
  assert.strictEqual(harness.queue.removeTerminal('one').taskId, 'one');
  harness.enqueue(profile('two'));
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (caught) {
    console.error(`not ok - ${name}`);
    console.error(caught && caught.stack ? caught.stack : caught);
    process.exitCode = 1;
  }
}

if (!process.exitCode) console.log(`resource-aware queue contract passed (${passed}/${tests.length})`);
