# Task resource control

This reference explains the executable 5.2.0 helpers. They keep records and return decisions. They do not start agents, stop processes, delete directories, reserve a GPU, or call a remote service. The host still performs an approved action and reports what actually happened.

## Track every resource created for a task

Use `TaskResourceTracker` for child agents, threads, process trees, terminal or command sessions, ports, temporary storage, artifacts, and limited compute resources.

Always register before launch. Open one root `ResourceScope`, then open a child scope for each delegated unit. A resource record includes its purpose, owner, parent, scope, generation, quota, close condition, acquisition order, and evidence references. After the host creates the resource, call `bind` with the observed compound identity. A name, PID, age, or path alone is not enough.

The owner and generation must match the original record. Process identity also checks the executable, arguments, start time, parent, launch nonce, and host run ID when they are observable. Temporary storage keeps its canonical root and path identity checks. A changed owner, parent, scope, generation, process identity, or path identity stops release and returns `HOLD`.

`observe` always uses the existing 5.1.0 process and temporary-storage safety functions; callers cannot replace them with a function that simply says “released.” The tracker compares each process observation with the identity, scope and generation recorded by `bind`. A host-owned observation resolver must authenticate any observation that could authorize exact termination, exact temporary removal, or downstream release. The real-path filesystem resolver is injected once when the tracker is created. A resolver supplied inside an individual observation is ignored, so a child task cannot approve its own temporary-directory removal. The tracker records the decision but never carries it out. A request to stop or reclaim is not proof of success.

The resolvers, limits, resource records, scope records, history, counters, and hashes are private tracker state rather than writable instance properties. Tracker and scope objects expose only their public operations, and returned snapshots are detached and deeply immutable. Callers therefore cannot replace a trusted resolver or edit a record to manufacture a release.

Release also needs type-specific absence verification or retention proof. Examples include `child_closed` for an agent session, `terminal_absent` for a terminal session, `port_absent` for a port, and `compute_released` for constrained compute. A retained output artifact uses `confirmRetention` with a sealed-artifact proof and host-approved retention reference; it remains `RETAINED` rather than being reported as removed. A later unsafe observation cancels an earlier release decision.

When a scope closes, child scopes are checked before the parent. Within one scope, the most recently acquired resource is checked first. If a child is not confirmed absent, its parent remains active. Once a scope closes successfully, every later close returns the same frozen result without adding events, even when unrelated scopes change. If an unfinished close receives new evidence, only its unresolved release checks are reconsidered.

Use `exportHistory()` to retain the ordered records. Every entry contains the owner, run, generation, previous-entry hash and its own hash. Before changing live state, the tracker reserves all history entries needed by that operation; the first close reserves both its request and evaluation entries. If the count, event-size, history-size, input-size, or state-size limit would be exceeded, the operation leaves both live state and history unchanged. `TaskResourceTracker.fromHistory()` applies the same configured limits and accepts only a complete ordered history for the same owner, run and generation. It also requires a host-owned history resolver to authenticate the expected final hash. The hashes detect content changes but do not establish who supplied the history. After a crash or host restart, rebuild the tracker and obtain fresh observations before deciding whether anything may be stopped or removed.

`exportLedgerProjection()` returns conservative hints taken from events that actually occurred in tracker history. It does not invent start, quiesce, exit, reclaim, or retention actions, and it sets `projectionIsResourceLedger: false`. The host must build the real `ResourceLedger1` events from action receipts, add timestamps, actor and identity references, validate that ledger, and only then produce `ExecutionReceipt1`. A tracker result, hint set, or queue snapshot never replaces that completion record.

## Stop a repeated error cycle

`FailureLoopGuard` computes its own versioned failure identity from the phase, checkpoint, error class and code, canonical command or test ID, relevant hashes, observable environment, and side-effect state. It ignores caller-provided fingerprints, wrapper wording, log paths, prompt wording, and unrelated timestamps. A simple canonical operation ID can be used directly. A shell-wrapped or otherwise ambiguous observed command must be mapped by a host-owned `operationIdentityResolver` to an immutable `canonicalOperationId` and `bindingRef`; missing, malformed, or drifting bindings stop the operation. The library does not guess by stripping shell prefixes.

Retry and repair have separate budgets. A temporary failure may use a retry only when side effects are known to be absent and an idempotency key plus named retry policy are present. A code repair needs host-verified evidence for a code defect, a stated hypothesis, a narrow change hash and scope, and a validation method. Permission, network, disk, driver, sandbox, service, or unavailable-hardware problems do not authorize code changes. Classification and evidence come through host-owned resolvers rather than caller labels alone.

When the same failure returns, or a budget is exhausted, stop new retry, repair, and delegation for that work unit. Only a stop condition recorded by the guard makes the current generation eligible for a `LoopSummary`; a caller cannot summarize a first repair early to obtain an extra attempt. The summary contains the common failure identity, trigger, first and latest occurrence, attempts, hypotheses, changes, unchanged observations, new evidence, environment status, side effects, last successful state, resources still running, and any user decision needed. The same failure generation reuses the same summary, and exit selection accepts only the failure's current generation.

After the summary, choose one supported exit method with verified evidence and a current authorization reference: minimize the reproduction, change the observation method, use a justified implementation path, restore a known working state when separately authorized and reversible, wait for an external change, ask the user, or stop and preserve evidence. At most one bounded next attempt is allowed for the stable failure family. Changing an output-artifact hash does not create another allowance. If that attempt produces the same failure without new evidence, stop immediately and reuse the existing summary; do not start another summary-attempt cycle.

The guard requires a host store keyed by run and guard ID plus a host-owned state resolver. Every saved state carries a monotonic revision, the previous state hash, and its own hash. Saving uses compare-and-swap against the expected revision and hash, requires an exact acknowledgement, reads the state back, and asks the host resolver to confirm that it is current. A stale writer, replayed old snapshot, no-op save, or conflicting writer stops the operation. If saving fails, the guard restores its in-memory budgets, summaries, generations, evidence, and consumed exit state to the last saved version. Failure count, records per generation, generations per failure, evidence references, and serialized state bytes all have configured limits.

## Schedule parallel work from observed resources

`ResourceAwareQueue` uses four active states:

- `ready`: the profile, dependencies, authorization, and root scope are valid;
- `running`: the task has started and its resource scope remains active;
- `blocked`: information, authorization, a dependency, or a safe resource fit is missing;
- `draining`: the task has ended or was cancelled, but its resources are still being checked and released.

A completed, failed, or cancelled result does not free capacity. Each profile contains an authorization reference, a non-empty `trackedResourceIds` list, and the exact tracker `{ ownerId, runId, scopeId, generation }`. Before admission and again before every start decision, every listed resource must remain bound, active, unreleased, and unchanged in that exact open scope. The tracker then claims the scope for one task; an empty scope, missing resource, stale claim, or second task using the same scope is rejected. `confirmReleased` asks the tracker to consume that task's exact close result once. A literal `{ status: "CLOSED" }`, another task's result, a modified copy, or a result for untracked resources is rejected. Until verification succeeds, the task stays `draining`, its resource use remains reserved, and conflicting work cannot start.

Each task profile states GPU count and capabilities, whether devices are exclusive or explicitly shareable, soft and hard VRAM needs, CPU, RAM, I/O, duration estimate and confidence, dependencies, priority, wait time, and resources reserved for foreground or external work. Host observations include GPU capabilities. Without stable device IDs, shared and exclusive work are conservatively kept apart: an active shared claim blocks an exclusive claim, and an active exclusive claim blocks shared work. Missing required values place the task in `blocked`; the queue does not guess.

Admission checks all resource dimensions together and honors the host concurrency limit. If the first long task cannot fit yet, another task may use the gap only when its declared maximum duration ends before both the backfill limit and the waiting task's remaining reservation time. Version 5.2.0 does not implement checkpoint or pause commands, so `preemptible: true` does not relax this rule. The queue records a reservation for the waiting task. Once its maximum wait is reached, it is promoted ahead of fresh high-priority work; later work cannot keep taking that reservation. This prevents long-term starvation. A policy-defined maximum task count and explicit removal of unreferenced terminal entries keep queue memory bounded.

Any start, completion, timeout, failure, or cancellation moves the task toward `draining`. New work fills released space only after the tracker verifies release. An out-of-memory risk, unsafe temperature or power condition, foreground slowdown, or unprotected external lease reduces concurrency or stops scheduling before utilization is considered.

Queue state-changing operations are synchronous and non-reentrant. If an authorization callback tries to schedule or mutate the same queue, the nested operation is rejected and cannot produce a second start decision. After every host callback, the queue also rechecks the operation version and task state before publishing a result.

### GPU measurements

The schedulable VRAM pool is physical VRAM minus driver use, desktop use, external tasks, foreground reserve, and the host safety reserve. Report task use as a fraction of that pool, not as a fraction of physical VRAM.

Measure useful GPU compute separately. Allocated memory does not prove useful computation, and a brief utilization spike does not prove sustained throughput. Version 1 of the executable window contains 3 to 120 strictly time-ordered samples over 1 to 60 seconds; its final timestamp equals the observation time. Every sample reports schedulable VRAM bytes, task VRAM bytes, and useful compute utilization. A missing, single-point, stale, oversized, or malformed window cannot report the target as met. A valid window reports success only when every sample and the aggregate averages meet both configured targets.

When useful queued or already-running GPU work exists, the workload can run in parallel, host policy allows it, and foreground and external work remain protected, schedulable VRAM occupancy and useful GPU compute utilization of at least 85% are a good operating target over that window. This target is not an admission rule or a completion test.

The target is not applicable to short samples, low-parallelism work, I/O or memory bottlenecks, data-loading limits, or compute-bound work that naturally uses little VRAM. Never create filler allocations, duplicate work, or idle GPU jobs to raise a number. Hard limits, out-of-memory risk, throttling, useful throughput, failures, and foreground response always take priority.

## Choose work level without weakening cleanup

The work level changes reporting and review effort, not ownership or cleanup rules:

- `light`: one short, low-risk task; check the root scope at start and end and run the direct automated test.
- `standard`: normal multi-step work; use phase scopes, bounded progress checks, focused tests, and failure budgets.
- `high`: long, parallel, expensive, or high-consequence work; use time-window observations, independent release review, and explicit residual-risk evidence.

All three levels require exact process identity and safe temporary-path checks. No level grants additional permission.

## Tell the user what is happening

Use four short reports:

1. 开始：说明任务范围、资源画像、并发上限、为前台或外部工作保留的资源，以及停止条件。
2. 进度：说明完成、失败和待处理数量，实际吞吐，资源时间窗，最新产物，队列状态和下一检查点。不要只报百分比。
3. 失败：说明错误分类，已用和剩余预算，真正新增的证据，所选退出方法，以及是否需要用户授权。
4. 结束：说明结果和验证，哪些资源已确认释放，哪些仍无法确认，剩余进程、目录、端口或句柄，以及恢复或人工处理办法。

## Scope of 5.2.0

5.2.0 不包含付费模型询问、供应商 API 适配、密钥登记表或远程模型列表刷新。这些仍是未来可选方案；任何真实付费调用或凭据网络操作都需要另行设计和用户逐次明确批准。
