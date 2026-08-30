'use strict';

const { createDetachedJsonSnapshot } = require('./canonical-json');
const { TaskResourceTracker } = require('./task-resource-tracker');

const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);
const BOTTLENECK_EXEMPTIONS = new Set([
  'low_parallelism',
  'io',
  'memory',
  'data_loading',
  'compute',
]);
const RESERVED_TASK_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const QUEUE_OPERATION_STATE = new WeakMap();
const GPU_WINDOW_VERSION = 1;
const GPU_WINDOW_MIN_SAMPLES = 3;
const GPU_WINDOW_MAX_SAMPLES = 120;
const GPU_WINDOW_MIN_DURATION_MS = 1000;
const GPU_WINDOW_MAX_DURATION_MS = 60000;

class ResourceQueueError extends Error {
  constructor(code, message = code) {
    super(`${code}: ${message}`);
    this.name = 'ResourceQueueError';
    this.code = code;
  }
}

function detached(value) {
  return createDetachedJsonSnapshot(value).snapshot;
}

function finiteNonNegative(value) {
  return Number.isFinite(value) && value >= 0;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function uniqueStrings(value) {
  return Array.isArray(value)
    && value.every(nonEmpty)
    && new Set(value).size === value.length;
}

function validatePolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)
    || !positiveInteger(policy.maxConcurrent)
    || !positiveInteger(policy.maxTasks)
    || !finiteNonNegative(policy.maxWaitMs)
    || !finiteNonNegative(policy.backfillWindowMs)
    || !Number.isFinite(policy.gpuOptimizationTarget)
    || policy.gpuOptimizationTarget <= 0
    || policy.gpuOptimizationTarget > 1
    || typeof policy.allowGpuOptimization !== 'boolean') {
    throw new ResourceQueueError('QUEUE_POLICY_INVALID');
  }
  return detached(policy);
}

function validateProfile(profile) {
  const reasons = [];
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return ['PROFILE_INVALID'];
  if (profile.version !== 1) reasons.push('PROFILE_VERSION_UNSUPPORTED');
  if (!nonEmpty(profile.taskId) || RESERVED_TASK_IDS.has(profile.taskId)) reasons.push('TASK_ID_INVALID');
  if (!Number.isFinite(profile.priority)) reasons.push('PRIORITY_INVALID');
  if (!uniqueStrings(profile.dependencies)) reasons.push('DEPENDENCIES_INVALID');
  if (!nonEmpty(profile.authorizationRef)) reasons.push('TASK_NOT_AUTHORIZED');
  if (!uniqueStrings(profile.trackedResourceIds) || profile.trackedResourceIds.length === 0) {
    reasons.push('TRACKED_RESOURCE_IDS_INVALID');
  }
  const binding = profile.scopeBinding;
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)
    || !nonEmpty(binding.ownerId) || !nonEmpty(binding.runId) || !nonEmpty(binding.scopeId)
    || !positiveInteger(binding.generation)) reasons.push('ROOT_SCOPE_NOT_READY');
  if (!finiteNonNegative(profile.enqueuedAt)) reasons.push('ENQUEUE_TIME_INVALID');

  const resources = profile.resources;
  if (!resources || typeof resources !== 'object' || Array.isArray(resources)
    || !finiteNonNegative(resources.cpuCores)
    || !finiteNonNegative(resources.ramBytes)
    || !finiteNonNegative(resources.ioUnits)) {
    reasons.push('RESOURCE_PROFILE_INCOMPLETE');
  }
  const gpu = resources && resources.gpu;
  if (!gpu || typeof gpu !== 'object' || Array.isArray(gpu)
    || !Number.isSafeInteger(gpu.count) || gpu.count < 0
    || !finiteNonNegative(gpu.vramSoftBytes)
    || !finiteNonNegative(gpu.vramHardBytes)
    || gpu.vramHardBytes < gpu.vramSoftBytes
    || !uniqueStrings(gpu.capabilities)
    || !['none', 'exclusive', 'shared'].includes(gpu.deviceMode)
    || (gpu.count === 0 && gpu.deviceMode !== 'none')
    || (gpu.count > 0 && gpu.deviceMode === 'none')) {
    reasons.push('GPU_PROFILE_INCOMPLETE');
  }
  const duration = profile.duration;
  if (!duration || typeof duration !== 'object' || Array.isArray(duration)
    || !finiteNonNegative(duration.expectedMs)
    || !finiteNonNegative(duration.maxMs)
    || duration.maxMs < duration.expectedMs
    || !nonEmpty(duration.confidence)) {
    reasons.push('DURATION_PROFILE_INCOMPLETE');
  }
  if (typeof profile.preemptible !== 'boolean') reasons.push('PREEMPTIBILITY_INVALID');
  if (profile.preemptible === true && (!profile.checkpoint || typeof profile.checkpoint !== 'object'
    || profile.checkpoint.resumeSupported !== true
    || !finiteNonNegative(profile.checkpoint.maxPauseLatencyMs))) {
    reasons.push('CHECKPOINT_REQUIRED');
  }
  return Array.from(new Set(reasons));
}

function validateObservation(observation) {
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)
    || observation.observed !== true
    || !finiteNonNegative(observation.nowMs)
    || !finiteNonNegative(observation.cpuCores)
    || !finiteNonNegative(observation.ramBytes)
    || !finiteNonNegative(observation.ioUnits)
    || typeof observation.foregroundHealthy !== 'boolean'
    || typeof observation.externalLeasesProtected !== 'boolean'
    || typeof observation.thermalSafe !== 'boolean'
    || typeof observation.powerSafe !== 'boolean'
    || typeof observation.oomRisk !== 'boolean') return false;
  const gpu = observation.gpu;
  return Boolean(gpu && typeof gpu === 'object' && !Array.isArray(gpu)
    && Number.isSafeInteger(gpu.count) && gpu.count >= 0
    && uniqueStrings(gpu.capabilities)
    && [
      'physicalVramBytes',
      'driverVramBytes',
      'desktopVramBytes',
      'externalVramBytes',
      'foregroundReserveVramBytes',
      'safetyReserveVramBytes',
      'taskVramBytes',
      'usefulComputeUtilization',
    ].every((field) => finiteNonNegative(gpu[field]))
    && gpu.usefulComputeUtilization <= 1);
}

function schedulableVram(observation) {
  const gpu = observation.gpu;
  return Math.max(0, gpu.physicalVramBytes
    - gpu.driverVramBytes
    - gpu.desktopVramBytes
    - gpu.externalVramBytes
    - gpu.foregroundReserveVramBytes
    - gpu.safetyReserveVramBytes);
}

function unsafeAction(observation) {
  if (observation.foregroundHealthy !== true || observation.externalLeasesProtected !== true) return 'HOLD';
  if (observation.oomRisk === true || observation.thermalSafe !== true || observation.powerSafe !== true) {
    return 'REDUCE_CONCURRENCY';
  }
  return null;
}

function gpuWindowSummary(observation, target) {
  const window = observation.gpu.window;
  if (window === undefined) return { valid: false, reason: 'GPU_WINDOW_REQUIRED' };
  if (!window || typeof window !== 'object' || Array.isArray(window)
    || window.version !== GPU_WINDOW_VERSION
    || !Array.isArray(window.samples)
    || window.samples.length < GPU_WINDOW_MIN_SAMPLES
    || window.samples.length > GPU_WINDOW_MAX_SAMPLES) {
    return { valid: false, reason: 'GPU_WINDOW_INVALID' };
  }

  let previousTimestamp = -1;
  let occupancyTotal = 0;
  let utilizationTotal = 0;
  let sustained = true;
  for (const sample of window.samples) {
    if (!sample || typeof sample !== 'object' || Array.isArray(sample)
      || !finiteNonNegative(sample.timestampMs)
      || !Number.isFinite(sample.schedulableVramBytes) || sample.schedulableVramBytes <= 0
      || !finiteNonNegative(sample.taskVramBytes)
      || !finiteNonNegative(sample.usefulComputeUtilization)
      || sample.usefulComputeUtilization > 1
      || sample.timestampMs <= previousTimestamp) {
      return { valid: false, reason: 'GPU_WINDOW_INVALID' };
    }
    const occupancy = Math.min(1, sample.taskVramBytes / sample.schedulableVramBytes);
    occupancyTotal += occupancy;
    utilizationTotal += sample.usefulComputeUtilization;
    sustained = sustained && occupancy >= target && sample.usefulComputeUtilization >= target;
    previousTimestamp = sample.timestampMs;
  }

  const firstTimestamp = window.samples[0].timestampMs;
  const lastTimestamp = window.samples[window.samples.length - 1].timestampMs;
  const durationMs = lastTimestamp - firstTimestamp;
  if (lastTimestamp !== observation.nowMs
    || durationMs < GPU_WINDOW_MIN_DURATION_MS
    || durationMs > GPU_WINDOW_MAX_DURATION_MS) {
    return { valid: false, reason: 'GPU_WINDOW_INVALID' };
  }
  return {
    valid: true,
    summary: {
      version: GPU_WINDOW_VERSION,
      sampleCount: window.samples.length,
      startedAtMs: firstTimestamp,
      endedAtMs: lastTimestamp,
      durationMs,
      schedulableVramOccupancy: occupancyTotal / window.samples.length,
      usefulComputeUtilization: utilizationTotal / window.samples.length,
      sustained,
    },
  };
}

function evaluateGpuTarget(input = {}) {
  const policy = validatePolicy(input.policy);
  if (!validateObservation(input.observation)) {
    return detached({
      applicable: false,
      action: 'HOLD',
      reasons: ['RESOURCE_OBSERVATION_INCOMPLETE'],
      syntheticLoadAllowed: false,
    });
  }
  const observation = input.observation;
  const safetyAction = unsafeAction(observation);
  if (safetyAction !== null) {
    return detached({
      applicable: false,
      action: safetyAction,
      reasons: ['RESOURCE_SAFETY_LIMIT'],
      syntheticLoadAllowed: false,
    });
  }
  const runningUsefulWork = input.runningUsefulWork === true;
  const schedulableCandidateWork = input.schedulableCandidateWork === true;
  const usefulRunnableWork = input.usefulRunnableWork === true
    || runningUsefulWork
    || schedulableCandidateWork;
  const reasons = [];
  if (policy.allowGpuOptimization !== true) reasons.push('HOST_POLICY_DISABLED');
  if (!usefulRunnableWork) reasons.push('NO_USEFUL_RUNNABLE_WORK');
  if (input.workloadParallelizable !== true) reasons.push('WORKLOAD_NOT_PARALLELIZABLE');
  if (nonEmpty(input.bottleneck) && BOTTLENECK_EXEMPTIONS.has(input.bottleneck)) {
    reasons.push(`BOTTLENECK_${input.bottleneck.toUpperCase()}`);
  }
  const capacity = schedulableVram(observation);
  if (capacity <= 0) reasons.push('NO_SCHEDULABLE_VRAM');
  if (reasons.length > 0) {
    return detached({
      applicable: false,
      action: 'NOT_APPLICABLE',
      reasons,
      runningUsefulWork,
      schedulableCandidateWork,
      syntheticLoadAllowed: false,
    });
  }
  const schedulableVramOccupancy = Math.min(1, observation.gpu.taskVramBytes / capacity);
  const usefulComputeUtilization = observation.gpu.usefulComputeUtilization;
  const target = policy.gpuOptimizationTarget;
  const window = gpuWindowSummary(observation, target);
  return detached({
    applicable: true,
    action: 'CONTINUE_SAFE_WORK',
    target,
    schedulableVramBytes: capacity,
    schedulableVramOccupancy,
    usefulComputeUtilization,
    met: window.valid === true
      && window.summary.sustained
      && window.summary.schedulableVramOccupancy >= target
      && window.summary.usefulComputeUtilization >= target,
    reasons: window.valid === true ? [] : [window.reason],
    window: window.valid === true ? window.summary : null,
    runningUsefulWork,
    schedulableCandidateWork,
    syntheticLoadAllowed: false,
  });
}

class ResourceAwareQueue {
  constructor(options = {}) {
    const policy = validatePolicy(options.policy);
    if (!(options.tracker instanceof TaskResourceTracker)) throw new ResourceQueueError('TRACKER_REQUIRED');
    if (typeof options.authorizationResolver !== 'function') {
      throw new ResourceQueueError('AUTHORIZATION_RESOLVER_REQUIRED');
    }
    Object.defineProperty(this, 'policy', {
      value: policy,
      enumerable: true,
      configurable: false,
      writable: false,
    });
    Object.defineProperty(this, 'tracker', {
      value: options.tracker,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    Object.defineProperty(this, 'authorizationResolver', {
      value: options.authorizationResolver,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    this._tasks = new Map();
    this._sequence = 0;
    this._lastObservation = null;
    QUEUE_OPERATION_STATE.set(this, { active: false, version: 0 });
  }

  enqueue(profile) {
    return this._withStateOperation('enqueue', () => this._enqueue(profile));
  }

  _enqueue(profile) {
    const safeProfile = detached(profile);
    const taskId = safeProfile && safeProfile.taskId;
    if (!nonEmpty(taskId) || RESERVED_TASK_IDS.has(taskId)) throw new ResourceQueueError('TASK_ID_INVALID');
    if (this._tasks.has(taskId)) throw new ResourceQueueError('TASK_ALREADY_QUEUED');
    if (this._tasks.size >= this.policy.maxTasks) throw new ResourceQueueError('QUEUE_TASK_LIMIT_REACHED');
    const reasons = validateProfile(safeProfile);
    if (reasons.length === 0 && !this.tracker.hasOpenScope(safeProfile.scopeBinding)) {
      reasons.push('ROOT_SCOPE_NOT_READY');
    }
    if (reasons.length === 0 && !this._authorizationAccepted(safeProfile, null)) {
      reasons.push('TASK_NOT_AUTHORIZED');
    }
    if (reasons.length === 0 && !this._claimTaskScope(safeProfile)) {
      reasons.push('TASK_SCOPE_CLAIM_REJECTED');
    }
    const task = {
      taskId,
      profile: safeProfile,
      sequence: ++this._sequence,
      state: reasons.length === 0 ? 'ready' : 'blocked',
      reasons,
      startedAt: null,
      drainReason: null,
      outcome: null,
      releaseVerified: false,
    };
    this._tasks.set(taskId, task);
    return this._taskSnapshot(task);
  }

  schedule(observation) {
    return this._withStateOperation('schedule', () => this._schedule(observation));
  }

  _schedule(observation) {
    if (!validateObservation(observation)) {
      return this._result('HOLD', ['RESOURCE_OBSERVATION_INCOMPLETE'], [], [], null);
    }
    this._lastObservation = detached(observation);
    const safetyAction = unsafeAction(observation);
    if (safetyAction !== null) {
      return this._result(safetyAction, ['RESOURCE_SAFETY_LIMIT'], [], [], this._capacity(observation));
    }
    this._refreshDependencyStates();
    const capacity = this._capacity(observation);
    const available = { ...capacity.available, gpuMode: this._activeGpuMode() };
    const activeCount = this._activeTasks().length;
    let slots = Math.max(0, this.policy.maxConcurrent - activeCount);
    const candidates = Array.from(this._tasks.values())
      .filter((task) => task.state === 'ready')
      .sort((left, right) => this._compareCandidates(left, right, observation.nowMs));
    const start = [];
    const reservations = [];
    let firstUnfit = null;

    for (const task of candidates) {
      if (slots <= 0) break;
      const fits = this._fits(task.profile, available, observation);
      if (!fits) {
        if (firstUnfit === null) {
          firstUnfit = task;
          reservations.push(this._reservation(task, observation.nowMs));
        }
        continue;
      }
      if (firstUnfit !== null && !this._backfillAllowed(firstUnfit, task, observation.nowMs)) continue;
      this._consume(task.profile, available);
      task.state = 'running';
      task.reasons = [];
      task.startedAt = observation.nowMs;
      start.push(task.taskId);
      slots -= 1;
    }

    const runningUsefulWork = Array.from(this._tasks.values()).some((task) => (
      task.state === 'running' && task.profile.resources.gpu.count > 0
    ));
    const schedulableCandidateWork = slots > 0 && candidates.some((task) => (
      task.state === 'ready'
      && task.profile.resources.gpu.count > 0
      && this._fits(task.profile, available, observation)
    ));
    const gpuTarget = evaluateGpuTarget({
      policy: this.policy,
      observation,
      runningUsefulWork,
      schedulableCandidateWork,
      workloadParallelizable: runningUsefulWork || schedulableCandidateWork,
    });
    const action = start.length > 0 ? 'START_WORK' : this._activeTasks().length > 0 || candidates.length > 0
      ? 'CONTINUE_SAFE_WORK'
      : 'IDLE';
    return this._result(action, [], start, reservations, this._capacity(observation), gpuTarget);
  }

  beginDrain(taskId, outcome) {
    return this._withStateOperation('beginDrain', () => this._beginDrain(taskId, outcome));
  }

  _beginDrain(taskId, outcome) {
    const task = this._requireTask(taskId);
    if (task.state !== 'running') throw new ResourceQueueError('TASK_NOT_RUNNING');
    if (!TERMINAL_STATES.has(outcome)) throw new ResourceQueueError('TASK_OUTCOME_INVALID');
    task.state = 'draining';
    task.drainReason = outcome;
    task.outcome = outcome;
    task.releaseVerified = false;
    return this._taskSnapshot(task);
  }

  confirmReleased(taskId, trackerCloseResult) {
    return this._withStateOperation(
      'confirmReleased',
      () => this._confirmReleased(taskId, trackerCloseResult),
    );
  }

  _confirmReleased(taskId, trackerCloseResult) {
    const task = this._requireTask(taskId);
    if (task.state !== 'draining') throw new ResourceQueueError('TASK_NOT_DRAINING');
    if (!this._consumeTaskCloseResult(task, trackerCloseResult)) {
      task.reasons = ['TRACKER_RELEASE_NOT_VERIFIED'];
      return this._taskSnapshot(task);
    }
    task.releaseVerified = true;
    task.state = task.outcome;
    task.reasons = [];
    return this._taskSnapshot(task);
  }

  removeTerminal(taskId) {
    return this._withStateOperation('removeTerminal', () => this._removeTerminal(taskId));
  }

  _removeTerminal(taskId) {
    const task = this._requireTask(taskId);
    if (!TERMINAL_STATES.has(task.state) || task.releaseVerified !== true) {
      throw new ResourceQueueError('TASK_NOT_REMOVABLE');
    }
    for (const candidate of this._tasks.values()) {
      if (candidate.taskId !== taskId && candidate.profile.dependencies.includes(taskId)) {
        throw new ResourceQueueError('TASK_STILL_REFERENCED');
      }
    }
    const snapshot = this._taskSnapshot(task);
    this._tasks.delete(taskId);
    return snapshot;
  }

  snapshot() {
    return detached({
      policy: this.policy,
      tasks: this._tasksObject(),
      lastObservation: this._lastObservation,
    });
  }

  _refreshDependencyStates() {
    for (const task of this._tasks.values()) {
      if (TERMINAL_STATES.has(task.state) || task.state === 'running' || task.state === 'draining') continue;
      const staticReasons = validateProfile(task.profile);
      if (staticReasons.length === 0 && !this.tracker.hasOpenScope(task.profile.scopeBinding)) {
        staticReasons.push('ROOT_SCOPE_NOT_READY');
      }
      if (staticReasons.length === 0 && !this._authorizationAccepted(task.profile, task)) {
        staticReasons.push('TASK_NOT_AUTHORIZED');
      }
      if (staticReasons.length === 0 && !this._claimTaskScope(task.profile)) {
        staticReasons.push('TASK_SCOPE_CLAIM_REJECTED');
      }
      if (staticReasons.length > 0) {
        task.state = 'blocked';
        task.reasons = staticReasons;
        continue;
      }
      const dependencyReasons = [];
      for (const dependencyId of task.profile.dependencies) {
        const dependency = this._tasks.get(dependencyId);
        if (!dependency || dependency.state !== 'completed' || dependency.releaseVerified !== true) {
          dependencyReasons.push(`DEPENDENCY_NOT_COMPLETE:${dependencyId}`);
        }
      }
      task.state = dependencyReasons.length === 0 ? 'ready' : 'blocked';
      task.reasons = dependencyReasons;
    }
  }

  _capacity(observation) {
    const used = { cpuCores: 0, ramBytes: 0, ioUnits: 0, gpuDevices: 0, vramBytes: 0 };
    for (const task of this._activeTasks()) {
      used.cpuCores += task.profile.resources.cpuCores;
      used.ramBytes += task.profile.resources.ramBytes;
      used.ioUnits += task.profile.resources.ioUnits;
      if (task.profile.resources.gpu.deviceMode === 'exclusive') {
        used.gpuDevices += task.profile.resources.gpu.count;
      }
      used.vramBytes += task.profile.resources.gpu.vramHardBytes;
    }
    const total = {
      cpuCores: observation.cpuCores,
      ramBytes: observation.ramBytes,
      ioUnits: observation.ioUnits,
      gpuDevices: observation.gpu.count,
      vramBytes: schedulableVram(observation),
    };
    return detached({
      schedulableVramBytes: total.vramBytes,
      total,
      used,
      available: {
        cpuCores: Math.max(0, total.cpuCores - used.cpuCores),
        ramBytes: Math.max(0, total.ramBytes - used.ramBytes),
        ioUnits: Math.max(0, total.ioUnits - used.ioUnits),
        gpuDevices: Math.max(0, total.gpuDevices - used.gpuDevices),
        vramBytes: Math.max(0, total.vramBytes - used.vramBytes),
      },
    });
  }

  _activeTasks() {
    return Array.from(this._tasks.values()).filter((task) => task.state === 'running' || task.state === 'draining');
  }

  _activeGpuMode() {
    const modes = new Set(this._activeTasks()
      .filter((task) => task.profile.resources.gpu.count > 0)
      .map((task) => task.profile.resources.gpu.deviceMode));
    if (modes.size === 0) return 'none';
    if (modes.size === 1) return modes.values().next().value;
    return 'mixed';
  }

  _fits(profile, available, observation) {
    const resources = profile.resources;
    const capabilitiesAvailable = resources.gpu.capabilities
      .every((capability) => observation.gpu.capabilities.includes(capability));
    const modeCompatible = resources.gpu.deviceMode === 'none'
      || available.gpuMode === 'none'
      || resources.gpu.deviceMode === available.gpuMode;
    const devicesAvailable = modeCompatible && (resources.gpu.deviceMode === 'shared'
      ? resources.gpu.count <= observation.gpu.count
      : resources.gpu.count <= available.gpuDevices);
    return resources.cpuCores <= available.cpuCores
      && resources.ramBytes <= available.ramBytes
      && resources.ioUnits <= available.ioUnits
      && devicesAvailable
      && capabilitiesAvailable
      && resources.gpu.vramHardBytes <= available.vramBytes;
  }

  _consume(profile, available) {
    available.cpuCores -= profile.resources.cpuCores;
    available.ramBytes -= profile.resources.ramBytes;
    available.ioUnits -= profile.resources.ioUnits;
    if (profile.resources.gpu.deviceMode === 'exclusive') {
      available.gpuDevices -= profile.resources.gpu.count;
    }
    if (profile.resources.gpu.count > 0 && available.gpuMode === 'none') {
      available.gpuMode = profile.resources.gpu.deviceMode;
    }
    available.vramBytes -= profile.resources.gpu.vramHardBytes;
  }

  _compareCandidates(left, right, nowMs) {
    const leftWait = Math.max(0, nowMs - left.profile.enqueuedAt);
    const rightWait = Math.max(0, nowMs - right.profile.enqueuedAt);
    const leftAged = leftWait >= this.policy.maxWaitMs;
    const rightAged = rightWait >= this.policy.maxWaitMs;
    if (leftAged !== rightAged) return leftAged ? -1 : 1;
    if (left.profile.priority !== right.profile.priority) return right.profile.priority - left.profile.priority;
    if (leftWait !== rightWait) return rightWait - leftWait;
    return this._ordinal(left.taskId, right.taskId);
  }

  _reservation(task, nowMs) {
    return {
      taskId: task.taskId,
      waitedMs: Math.max(0, nowMs - task.profile.enqueuedAt),
      resources: task.profile.resources,
    };
  }

  _backfillAllowed(head, candidate, nowMs) {
    const waitedMs = Math.max(0, nowMs - head.profile.enqueuedAt);
    if (waitedMs >= this.policy.maxWaitMs) return false;
    const remainingMs = this.policy.maxWaitMs - waitedMs;
    return candidate.profile.duration.maxMs <= Math.min(this.policy.backfillWindowMs, remainingMs);
  }

  _tasksObject() {
    const tasks = {};
    for (const task of Array.from(this._tasks.values()).sort((left, right) => this._ordinal(left.taskId, right.taskId))) {
      tasks[task.taskId] = this._taskSnapshot(task);
    }
    return tasks;
  }

  _taskSnapshot(task) {
    return detached({
      taskId: task.taskId,
      state: task.state,
      reasons: task.reasons,
      sequence: task.sequence,
      startedAt: task.startedAt,
      outcome: task.outcome,
      releaseVerified: task.releaseVerified,
      profile: task.profile,
    });
  }

  _result(action, reasons, start, reservations, capacity, gpuTarget = null) {
    return detached({
      action,
      reasons,
      start,
      reservations,
      capacity,
      gpuTarget,
      tasks: this._tasksObject(),
    });
  }

  _requireTask(taskId) {
    const task = this._tasks.get(taskId);
    if (!task) throw new ResourceQueueError('TASK_NOT_FOUND');
    return task;
  }

  _withStateOperation(operationName, action) {
    const operation = QUEUE_OPERATION_STATE.get(this);
    if (!operation || operation.active) {
      throw new ResourceQueueError(
        'QUEUE_REENTRANT_OPERATION',
        `${operationName} cannot run during another queue state operation`,
      );
    }
    operation.active = true;
    try {
      return action();
    } finally {
      operation.version += 1;
      operation.active = false;
    }
  }

  _authorizationAccepted(profile, expectedTask) {
    const operation = QUEUE_OPERATION_STATE.get(this);
    const expectedVersion = operation && operation.version;
    const queuedTask = this._tasks.get(profile.taskId);
    const expectedState = expectedTask && expectedTask.state;
    let accepted = false;
    try {
      accepted = this.authorizationResolver(detached({
        purpose: 'queue_admission',
        profile,
        scopeBinding: profile.scopeBinding,
      })) === true;
    } catch (_) {
      return false;
    }
    if (!accepted || !operation || !operation.active || operation.version !== expectedVersion) return false;
    if (expectedTask === null) return queuedTask === undefined && !this._tasks.has(profile.taskId);
    return queuedTask === expectedTask
      && this._tasks.get(profile.taskId) === expectedTask
      && expectedTask.state === expectedState;
  }

  _claimTaskScope(profile) {
    try {
      return this.tracker.claimTaskScope(
        profile.taskId,
        profile.scopeBinding,
        profile.trackedResourceIds,
      ) === true;
    } catch (_) {
      return false;
    }
  }

  _consumeTaskCloseResult(task, trackerCloseResult) {
    try {
      return this.tracker.consumeTaskCloseResult(
        task.taskId,
        trackerCloseResult,
        task.profile.scopeBinding,
        task.profile.trackedResourceIds,
      ) === true;
    } catch (_) {
      return false;
    }
  }

  _ordinal(left, right) {
    if (left === right) return 0;
    return left < right ? -1 : 1;
  }
}

module.exports = {
  ResourceAwareQueue,
  ResourceQueueError,
  evaluateGpuTarget,
  validateProfile,
};
