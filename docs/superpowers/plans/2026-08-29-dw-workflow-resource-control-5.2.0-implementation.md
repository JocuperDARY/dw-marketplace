# development-workflow 5.2.0 Resource Control Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use `test-driven-development` for Tasks 1-3, `dw-implementation` while changing runtime code, and `verification-before-completion` before any completion claim. Keep all work inside the approved 5.2.0 worktree. Do not stage or commit unless the user separately authorizes it.

**Goal:** Add dependency-free CommonJS resource tracking, repeated-failure loop exit, and resource-aware scheduling to `dw-collaboration`, then publish the behavior as development-workflow 5.2.0 documentation and package metadata.

**Architecture:** Three small pure-core modules sit beside the existing 5.1.0 collaboration contract helpers. `TaskResourceTracker` records nested scopes and delegates all process/storage safety decisions to the existing `decideProcessRecovery` and `decideTemporaryLease` functions. `FailureLoopGuard` derives stable failure identities from immutable normalized observations and permits at most one evidence-based exit attempt after a loop summary. `ResourceAwareQueue` is a deterministic queue state machine whose admission decisions use injected resource observations and confirmed tracker release evidence. Host-specific execution remains outside these modules.

**Tech Stack:** Node.js CommonJS, built-in `assert`/`crypto`, existing canonical JSON and collaboration contract helpers, Markdown references, dependency-free script tests.

**Spec:** `docs/specs/2026-08-29-dw-workflow-resource-control-5.2.0-design.md`

## Global constraints

- Keep the stronger-model/paid-API inquiry feature out of implementation, tests, package exports, and 5.2.0 release claims.
- Do not change hooks, `gpt-bridge`, existing JSON schemas, or the meanings of 5.1.0 artifacts.
- Core modules return decisions and immutable snapshots; they never spawn, kill, detach, delete, reserve a real GPU, or call the network.
- Process and temporary-storage cleanup must reuse 5.1.0 fail-closed decisions. Unknown ownership, identity, generation, path safety, or absence always blocks release.
- The 85% GPU targets apply only when useful parallel work exists and safety/foreground policies permit it. They are optimization observations, never admission or completion gates.
- Tests use synthetic observations only. They must not start real GPU work or leave processes, handles, ports, or temporary roots behind.
- Shared integration files are edited only after the three core modules pass focused tests.

Independent review added four implementation requirements before the final gate: safety decisions are fixed and cannot be replaced by callers; host-owned resolvers must authenticate observations, history, evidence, and authorization; queue admission and release must bind to the exact tracker scope; and cumulative in-memory state must have host-configured limits. These corrections do not change the approved feature scope.

The final adversarial review found that these requirements needed stronger interfaces rather than more caller checks. The implementation therefore also requires: atomic history reservation before any tracker mutation; private tracker state and constructor-injected trusted resolvers; type-specific release and artifact-retention proofs; a fresh validation of every task claim before start; stable close results across unrelated revisions; monotonic hash-linked compare-and-swap state for `FailureLoopGuard`; persisted summary eligibility for the current generation; host-bound canonical operation identity; non-reentrant queue callbacks; conservative shared/exclusive GPU separation when device identities are unavailable; a sustained bounded GPU sample window; and duration-bounded backfill without claiming that checkpoint preemption exists. `exportLedgerProjection()` returns only history-derived hints and never fabricates `ResourceLedger1` transitions.

### Task 1: Implement nested task resource tracking

**Files:**

- Create: `plugins/development-workflow/skills/dw-collaboration/scripts/lib/task-resource-tracker.js`
- Create: `plugins/development-workflow/test/resource-control.test.js`
- Reuse: `plugins/development-workflow/skills/dw-collaboration/scripts/lib/canonical-json.js`
- Reuse: `plugins/development-workflow/skills/dw-collaboration/scripts/lib/contracts.js`

**Public interface:**

```js
const { TaskResourceTracker, ResourceTrackerError } = require('../skills/dw-collaboration/scripts/lib/task-resource-tracker');

const tracker = new TaskResourceTracker({
  ownerId: 'root',
  runId: 'run-1',
  generation: 1,
  trustedObservationResolver: hostObservationResolver,
  limits: { maxScopes: 64, maxResources: 512, maxHistoryEvents: 4096 },
});
const root = tracker.openRootScope({ scopeId: 'scope-root', purpose: 'build' });
const child = root.openChild({ scopeId: 'scope-child', ownerId: 'worker-1', purpose: 'test' });
child.register({ resourceId: 'process-1', type: 'process_tree', purpose: 'test runner', teardownCondition: 'scope_close' });
child.bind('process-1', { identity: processIdentity, generation: 1, evidenceRefs: ['spawn-1'] });
child.observe('process-1', processRecoveryInput);
const decision = child.close('task_complete');
```

**Step 1: Write the RED tests.**

Add behavior tests that assert:

```js
test('registers before bind and rejects duplicate or drifting identity', () => {
  const tracker = makeTracker();
  const scope = tracker.openRootScope({ scopeId: 'root', purpose: 'test' });
  scope.register(resource('proc', 'process_tree'));
  assert.strictEqual(scope.bind('proc', bindObservation()).state, 'ACTIVE');
  assert.throws(() => scope.bind('proc', { ...bindObservation(), generation: 2 }), /RESOURCE_IDENTITY_DRIFT/);
});

test('closes deeper scopes first and resources in reverse acquisition order', () => {
  const { tracker, root, child } = nestedTracker();
  child.register(resource('child-a', 'process_tree'));
  child.register(resource('child-b', 'temporary_allocation'));
  root.register(resource('root-a', 'port'));
  const result = root.close('task_complete');
  assert.deepStrictEqual(result.order, ['child-b', 'child-a', 'root-a']);
});

test('close is idempotent and does not release a parent before child absence', () => {
  const { root } = trackerWithUnverifiedChild();
  const first = root.close('task_complete');
  const second = root.close('task_complete');
  assert.deepStrictEqual(second, first);
  assert.strictEqual(first.status, 'HOLD');
  assert(first.reasons.includes('CHILD_RELEASE_NOT_VERIFIED'));
});
```

Also cover: parent/scope/generation mismatch; registration disabled after close begins; process recovery action mapping; temporary lease action mapping; retry of only pending close steps; recovery from detached append-only history; and immutable returned snapshots.

**Step 2: Run the focused test and confirm RED.**

Run:

```powershell
node plugins/development-workflow/test/resource-control.test.js
```

Expected: non-zero exit because `task-resource-tracker.js` does not exist.

**Step 3: Implement the smallest stateful core.**

Use private maps internally and expose detached frozen snapshots. Required invariants:

- `openRootScope` is unique for `scopeId + generation`.
- child scopes require a live parent and inherit `runId`/generation.
- `register` validates non-empty identity fields and records monotonically increasing acquisition order.
- `bind` is one-way: an identical replay is idempotent; owner, parent, scope, generation, type, or compound-identity drift throws `ResourceTrackerError('RESOURCE_IDENTITY_DRIFT')` and marks the record `HOLD`.
- `observe` stores a detached observation and derives the relevant 5.1.0 safety decision; it does not execute it.
- `close` freezes new registration, recursively visits deepest scopes, then reverse acquisition order. A resource is release-confirmed only when the process decision has `downstream_release_allowed === true`, or a temporary resource has an authenticated `RECLAIM_EXACT` result followed by an explicit absence observation.
- incomplete identity or release evidence returns `HOLD`; it never fabricates completion.
- repeated close for the same scope generation returns the same published result. A partially completed close can resume only unresolved records after new observation evidence.
- `exportHistory()` emits append-only detached records that `TaskResourceTracker.fromHistory()` validates before rebuilding state.

Prefer small helpers such as `snapshot`, `requireString`, `sameCanonicalValue`, `scopeDepth`, and `decisionForRecord`. Do not add an adapter that performs OS actions.

**Step 4: Run focused tests until GREEN.**

Run:

```powershell
node plugins/development-workflow/test/resource-control.test.js
```

Expected: `resource control contract passed` and exit code 0.

**Step 5: Record the checkpoint.**

Inspect the diff and test output. Do not stage or commit until separately authorized.

### Task 2: Add deterministic repeated-failure loop exit

**Files:**

- Create: `plugins/development-workflow/skills/dw-collaboration/scripts/lib/failure-loop-guard.js`
- Modify: `plugins/development-workflow/test/resource-control.test.js`

**Public interface:**

```js
const { FailureLoopGuard, FAILURE_FINGERPRINT_VERSION } = require('../skills/dw-collaboration/scripts/lib/failure-loop-guard');
const guard = new FailureLoopGuard({
  runId: 'run-1',
  guardId: 'implementation-loop',
  retryBudget: 2,
  repairBudget: 1,
  store: hostFailureStore,
  evidenceResolver: hostEvidenceResolver,
  classificationResolver: hostClassificationResolver,
  authorizationResolver: hostAuthorizationResolver,
});
const result = guard.recordFailure(failureObservation);
const summary = guard.summarize(result.generation);
const exit = guard.chooseExit({
  generation: result.generation,
  method: 'MINIMIZE_REPRODUCTION',
  evidenceRefs: ['trace-2'],
  authorizationRef: 'approval-loop-exit-1',
  maxAttempts: 1,
  successCriterion: 'minimal test distinguishes hypothesis A from B',
  failureCriterion: 'same fingerprint without new evidence',
  cleanupCondition: 'resource scope closed',
});
```

**Step 1: Extend the test with RED cases.**

```js
test('derives the same fingerprint despite wrapper and log-path changes', () => {
  const guard = makeGuardWithTrustedTestResolvers();
  const a = guard.recordFailure(failure({ wrapper: 'cmd /c', logPath: 'a.log' }));
  const b = guard.recordFailure(failure({ wrapper: 'powershell', logPath: 'b.log' }));
  assert.strictEqual(a.fingerprint, b.fingerprint);
  assert.strictEqual(b.action, 'SUMMARIZE_AND_STOP_DISPATCH');
});

test('reuses one summary and permits only one bounded exit attempt', () => {
  const guard = exhaustedGuard();
  const first = guard.summarize(1);
  assert.strictEqual(guard.summarize(1), first);
  assert.strictEqual(guard.chooseExit(validExit()).action, 'ALLOW_ONE_BOUNDED_ATTEMPT');
  assert.strictEqual(guard.chooseExit(validExit()).action, 'STOP_AND_PRESERVE');
});

test('same failure after the exit attempt stops without a new summary cycle', () => {
  const guard = guardAfterExitAttempt();
  const result = guard.recordFailure(failure());
  assert.strictEqual(result.action, 'STOP_AND_PRESERVE');
  assert.strictEqual(result.summaryReused, true);
});
```

Also cover: stable versioned test vector; new evidence creates a new generation only when it changes classification/hypothesis/scope/validation; retry and repair budgets remain separate; environment failures never emit code-repair permission; caller-supplied fingerprints are ignored; missing evidence/authorization rejects an exit; summary does not reset budgets.

**Step 2: Run and confirm RED.**

Run the same focused test. Expected: non-zero exit because `failure-loop-guard.js` is absent.

**Step 3: Implement the minimal guard.**

- Normalize only phase, checkpoint, error class/code, canonical command or test ID, input/artifact hashes, observable environment identity, side-effect state, and semantic evidence changes.
- Exclude wrapper text, prompt text, log paths, and unrelated timestamps.
- Hash a detached canonical snapshot with a constant fingerprint version.
- Keep immutable history; never accept a final fingerprint from the caller.
- Return controlled actions: `RETRY`, `REPAIR`, `SUMMARIZE_AND_STOP_DISPATCH`, `ALLOW_ONE_BOUNDED_ATTEMPT`, `WAIT_EXTERNAL`, `REQUEST_USER_DECISION`, `STOP_AND_PRESERVE`, or `HOLD`.
- Supported exit methods are exactly: `MINIMIZE_REPRODUCTION`, `CHANGE_OBSERVATION`, `CHANGE_IMPLEMENTATION_PATH`, `RESTORE_KNOWN_GOOD`, `WAIT_EXTERNAL`, `REQUEST_USER_DECISION`, and `STOP_AND_PRESERVE`.
- `RESTORE_KNOWN_GOOD` additionally requires explicit reversible authorization. No method may broaden permissions or reset budgets.

**Step 4: Run focused tests until GREEN.**

Expected: `resource control contract passed` and exit code 0.

**Step 5: Record the checkpoint.**

Inspect the diff and test output. Do not stage or commit until separately authorized.

### Task 3: Implement the resource-aware queue

**Files:**

- Create: `plugins/development-workflow/skills/dw-collaboration/scripts/lib/resource-aware-queue.js`
- Create: `plugins/development-workflow/test/resource-aware-queue.test.js`

**Public interface:**

```js
const { ResourceAwareQueue } = require('../skills/dw-collaboration/scripts/lib/resource-aware-queue');
const queue = new ResourceAwareQueue({
  policy: hostPolicy,
  tracker,
  authorizationResolver: hostAuthorizationResolver,
});
queue.enqueue(taskProfile);
const decision = queue.schedule(resourceObservation);
queue.beginDrain('task-a', 'completed');
queue.confirmReleased('task-a', trackerCloseResult);
```

Every profile binds `authorizationRef` and `{ ownerId, runId, scopeId, generation }`. GPU profiles declare `deviceMode` (`none`, `exclusive`, or explicit `shared`) and required capabilities. The policy includes a maximum retained task count; terminal entries can be removed only after verified release and after no remaining task depends on them.

**Step 1: Write RED queue tests.**

```js
test('blocks admission when profile, observation, authorization, or root scope is incomplete', () => {
  const queue = makeQueue();
  queue.enqueue(profile({ id: 'unknown', gpu: { count: 1 } }));
  assert.strictEqual(queue.schedule(observation()).tasks.unknown.state, 'blocked');
});

test('backfills a fitting short task while reserving resources for an aging head task', () => {
  const queue = populatedQueue([longTask(), shortTask()]);
  const result = queue.schedule(constrainedObservation());
  assert.deepStrictEqual(result.start, ['short-task']);
  assert.strictEqual(result.tasks['long-task'].state, 'ready');
  assert(result.reservations.some((item) => item.taskId === 'long-task'));
});

test('does not refill until tracker proves every allocation released', () => {
  const queue = runningQueue();
  queue.beginDrain('task-a', 'completed');
  assert.deepStrictEqual(queue.schedule(observation()).start, []);
  assert.strictEqual(queue.confirmReleased('task-a', { status: 'HOLD' }).state, 'draining');
  assert.strictEqual(queue.confirmReleased('task-a', verifiedClose()).state, 'completed');
});

test('reports conditional GPU targets without manufacturing load or failing safe work', () => {
  const report = queueReport({ schedulableVramUse: 0.72, usefulGpuCompute: 0.91 });
  assert.strictEqual(report.gpuTarget.applicable, true);
  assert.strictEqual(report.gpuTarget.met, false);
  assert.strictEqual(report.action, 'CONTINUE_SAFE_WORK');
});
```

Also cover: `ready/running/blocked/draining`; dependencies; CPU/RAM/I/O/GPU multi-dimensional fit; concurrency cap; priority and maximum-wait anti-starvation; non-preemptible tasks; hard VRAM and safety reserves; OOM/thermal/foreground degradation reducing concurrency; separate VRAM and useful-compute windows; low-parallelism and I/O/memory/compute bottleneck exemptions; synthetic padding and duplicate work forbidden; immutable deterministic snapshots.

**Step 2: Run and confirm RED.**

Run:

```powershell
node plugins/development-workflow/test/resource-aware-queue.test.js
```

Expected: non-zero exit because `resource-aware-queue.js` does not exist.

**Step 3: Implement the deterministic queue.**

- Validate a versioned profile before it becomes `ready`; otherwise store it as `blocked` with reasons.
- Compute schedulable resources from injected physical capacity minus driver/desktop/external/foreground/safety reservations.
- Select work by dependency readiness, hard fit, priority, wait age, reservation windows, safe backfill, then stable task ID.
- Never treat task count as capacity. Never infer resource release from a completed/failed/cancelled outcome.
- `beginDrain` removes the task from admission capacity only after a verified tracker close; incomplete release evidence keeps it `draining` and blocks conflicting refill.
- A GPU-target report is applicable only when there is useful runnable parallel work, host policy permits it, and foreground/external reservations are protected. Report rolling-window schedulable-VRAM occupancy and useful-compute utilization separately.
- The target is 0.85 for both measures by default only as a configurable optimization target. OOM risk, throttling, hard limits, or foreground degradation returns `REDUCE_CONCURRENCY` or `HOLD` before target chasing.

**Step 4: Run focused tests until GREEN.**

Run both focused files. Expected: both exit 0 and print their pass markers.

**Step 5: Record the checkpoint.**

Inspect the diff and test output. Do not stage or commit until separately authorized.

### Task 4: Integrate plain-language guidance

**Files:**

- Create: `plugins/development-workflow/skills/dw-collaboration/references/resource-control.md`
- Modify: `plugins/development-workflow/skills/dw-collaboration/SKILL.md`
- Modify: `plugins/development-workflow/skills/dw-collaboration/references/resource-lifecycle.md`
- Modify: `README.md`

**Step 1: Add behavior assertions before editing documentation.**

In `resource-control.test.js`, read the three collaboration Markdown files and assert that they describe:

- registration before launch, exact owner/generation identity, nested close order, and absence verification;
- one loop summary, one bounded exit attempt, and a direct stop on the same failure without new evidence;
- `light`, `standard`, and `high` work levels without weakening identity/path cleanup;
- safe queue admission, backfill, anti-starvation, draining, and verified release;
- schedulable VRAM and useful compute as separate conditional 85% optimization targets;
- start/progress/failure/finish user reports with actual counts and residual resources.

The test must also assert that the implementation reference does not present the optional stronger-model inquiry as a 5.2.0 runtime feature.

**Step 2: Run the focused test and confirm RED.**

Expected: documentation assertions fail because `resource-control.md` is missing.

**Step 3: Write concise, plain-language documentation.**

- Add one short `SKILL.md` paragraph directing runtime resource work to `resource-control.md`; keep trigger metadata concise.
- Keep `resource-lifecycle.md` as the 5.1.0 safety contract and add only a cross-reference explaining that the tracker orchestrates those existing decisions.
- In `resource-control.md`, explain what the modules do, inputs/outputs, state transitions, failure handling, queue policy, work levels, and user report fields. Use direct terms such as “record”, “check”, “stop”, “release”, and “remaining work”; avoid metaphorical jargon.
- Add a 5.2.0 README paragraph in Chinese. State that the optional paid-model inquiry remains a future idea and is not included in this release.

**Step 4: Run focused tests until GREEN.**

Expected: both resource test files pass.

**Step 5: Record the checkpoint.**

Inspect the diff and test output. Do not stage or commit until separately authorized.

### Task 5: Wire tests and publish 5.2.0 metadata

**Files:**

- Modify: `plugins/development-workflow/package.json`
- Modify: `plugins/development-workflow/.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`
- Modify: `plugins/development-workflow/test/hooks.test.js`

**Step 1: Add metadata RED assertions.**

Extend the existing manifest consistency test to require:

```js
assert.strictEqual(packageJson.version, '5.2.0');
assert.strictEqual(pluginJson.version, '5.2.0');
assert.strictEqual(marketplacePlugin.version, '5.2.0');
assert(packageJson.scripts.test.includes('resource-control.test.js'));
assert(packageJson.scripts.test.includes('resource-aware-queue.test.js'));
```

Also verify the packaged plugin contains the three new CommonJS files and `resource-control.md`.

**Step 2: Run the relevant test and confirm RED.**

Run:

```powershell
node plugins/development-workflow/test/hooks.test.js "development-workflow manifests and README agree on version and skill count"
```

Expected: non-zero exit because metadata still says 5.1.0 and the new tests are not wired.

**Step 3: Apply the minimal integration edits.**

- Set only development-workflow package/plugin/marketplace versions to `5.2.0`; leave `gpt-bridge` unchanged.
- Add `resource-control.test.js` and `resource-aware-queue.test.js` before `hooks.test.js` in both `test` and `validate` scripts.
- Update README version text and feature summary.
- Preserve the existing files allowlist; the current `skills/dw-collaboration/` and `test/` entries already package the new files.

**Step 4: Run the focused metadata test and both resource tests.**

Expected: all exit 0.

**Step 5: Record the checkpoint.**

Inspect the diff and test output. Do not stage or commit until separately authorized.

### Task 6: Verify the complete change and clean task-owned resources

**Files:**

- Verify all files changed in Tasks 1-5.
- Do not create release tags, external API calls, GPU workloads, or repository writes outside the approved worktree.

**Step 1: Run focused verification.**

```powershell
node plugins/development-workflow/test/resource-control.test.js
node plugins/development-workflow/test/resource-aware-queue.test.js
node plugins/development-workflow/test/collaboration-platform.test.js
```

Expected: all applicable tests pass; non-applicable platform checks report `SKIP_NOT_APPLICABLE` and do not masquerade as a pass for that platform.

**Step 2: Run the complete local regression.**

```powershell
cmd /d /s /c "npm test"
cmd /d /s /c "npm run validate"
```

Run from `plugins/development-workflow`. Expected: exit code 0. Confirm the nested packaged-plugin self-test also runs the two new tests.

**Step 3: Inspect the package without publishing.**

```powershell
cmd /d /s /c "npm pack --dry-run"
```

Expected: exit code 0; output includes the three new library modules, the new reference, both test files, and version 5.2.0. This does not authorize `npm publish`.

**Step 4: Perform independent reviews.**

- General review: correctness, backwards compatibility, complexity, and missing tests.
- JavaScript review: CommonJS correctness, immutable snapshots, deterministic ordering, error handling, and accidental shared mutation.
- Security/resource review: exact process identity, path/temporary release rules, owner/generation checks, no broad termination/deletion, and no synthetic GPU load.

Fix only evidence-backed findings, rerun the narrow failing test first, then rerun the full suite after the final fix. If the same failure recurs without new evidence, write one loop summary, choose at most one bounded diagnostic change, and stop rather than repeating the cycle.

**Step 5: Verify repository and runtime cleanliness.**

- Confirm worktree status contains only the intended 5.2.0 files plus the approved design and this plan.
- Confirm no task-owned process, child agent, terminal session, port, handle, temporary directory, or GPU allocation remains. Use exact recorded identities; do not terminate by broad process name.
- Confirm the original checkout's pre-existing dirty files are byte-for-byte and status-for-status unchanged.
- Report any resource that cannot be verified as released; do not call the work complete while it is unknown.

**Step 6: Stop at the authorization boundary.**

Present the final diff, test results, package contents, review findings, and resource-cleanup evidence. Do not stage, commit, push, tag, merge, publish, deploy, or remove the worktree until separately authorized.
