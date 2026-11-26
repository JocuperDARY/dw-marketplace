---
name: dw-collaboration
description: Use when designing or running agent collaboration, defining roles, dependencies, communication and scheduling, selecting model/effort by live capabilities, or managing task-owned resources (多智能体协作、角色写域隔离、分层选模与受管资源生命周期).
---

# Multi-agent collaboration

> 隶属 [development-workflow](../development-workflow/SKILL.md) **L3 横切多智能体与受管资源层**：本页的形式化状态机、进程监管与 Schema 契约保持英文规范锚点；普通团队分工与选模参考见中文文档 [ordinary-collaboration.md](references/ordinary-collaboration.md)，轻量工作区目录与临时区租约见 [dw-file-governance](../dw-file-governance/SKILL.md)。

Select intelligence and collaboration topology separately. Classify task type, dependency depth, risk/reversibility, phase, latency/cost, and validation failure cost. Request the least expensive model/effort that can satisfy the acceptance gate; record the actual model or effort only from host-observed execution metadata.

## Ordinary collaboration

Use the live tool declarations to choose an available operation. Its first useful call supplies runtime evidence; an extra empty probe is only useful when a required capability is genuinely uncertain. Configuration remains declared evidence.

Delegate only when permitted and useful. A bounded task needs an objective, inputs, file ownership, expected result, relevant limits, and a return channel. Record its result and remaining uncertainty in the existing task record. Ordinary reviews and text edits can use the host's native task tools.

For role design, dependency planning, messages, recovery and advisory consultation, read
[ordinary collaboration](references/ordinary-collaboration.md). Apply the shared
[authorization and evidence rules](../development-workflow/SKILL.md#授权资源与内部前置条件):
planning is not an automatic approval stop, resource contention is a scheduling
problem, and retries retain actual costs and the remaining budget. A request to
design a team is not permission to launch it.

Keep the roster proportional to independent work and review needs. One person may
cover coordination, implementation or integration; arrange independent review
when the risk or project requires it. Do not require a fixed number of roles,
rounds, model names, dashboards or persistent task records for every task.

When assembling a multi-agent team for complex multi-module work, keep the root session as the single coordinator and final acceptance authority, and choose each delegated worker's model and reasoning effort explicitly rather than inheriting the root model across all roles. Because available model pools vary widely (fewer than three, three, four, or more options), prefer user-specified model lineups first after verifying live interface support. When the user is unsure how to assign models, offer an automatic selection flow: inspect the live available model list, ask the user which models are usable and permitted, research current capability/cost/latency tradeoffs to derive a Pareto-optimal lineup, and assign roles by subtask difficulty across at least three general capability tiers—high-assurance decision/audit/escalation, core design/implementation/independent-verification, and low-cost routine execution/retrieval—expanding to more tiers or collapsing conservatively as the frontier allows and tuning effort within a tier when supported. Parallelize writers only on disjoint write domains inside isolated working copies or branches, keep read-only researchers, auditors, and independent verifiers on a shared read-only view without editing business files, stop retrying after two consecutive identical failure signatures to escalate for replanning, and merge plus verify an isolated writer's work before destroying its worker or workspace; see [ordinary collaboration](references/ordinary-collaboration.md).

For incremental work, use the [work-package guidance](../dw-reference/references/method-integration.md#增量工作包): share exact interface decisions and evidence locations, then verify the returned change against its acceptance criteria. Related failures may share a cause; establish independence before splitting them. A narrower fix review checks the original findings and new risks in the fix, with review depth determined by the remaining uncertainty.

## Optional managed resource protocol

For a Windows stdio MCP server or session-owned command, the opt-in [process supervisor](references/process-supervisor.md) supplies atomic Job Object ownership, transport/parent exit handling and bounded teardown. Its managed command backend also powers the [Windows command adapter](references/windows-command-adapter.md) and the test runner. Choose the direct backend for ordinary bounded commands and the manager adapter for tasks needing persisted resource records. Build explicitly; keep quiet connected stdio sessions alive and use the command's declared deadline. Neither path adopts pre-existing processes.

The detailed plan, ledger, probe and schema requirements below apply when explicitly using the executable resource manager or implementing its protocol. Choose this mode for work that actually requires persisted process identity, resource recovery, or a verifiable lifecycle. Its API requirements remain mandatory for that mode.

Choose one topology:

- `single`: one execution chain.
- `assignment_only`: child receives a complete immutable packet and returns one result.
- `interactive_shared`: only when root and child share freshly verified bidirectional messaging and liveness.
- `serial_fallback`: capability is missing, stale, contradictory, or communication fails.

Root is the acceptance authority and default sole writer. Parallelize only independent work with exclusive paths/resources. Each child receives objective, inputs and hashes, ownership, forbidden actions, authorization scope, output schema, validation, timeout/progress, cleanup, and return channel. Child completion is a submission, never acceptance.

Open the plan and resource ledger before dispatch. Track child, process, terminal, port, temporary storage, artifacts, and constrained compute by owner, parent, generation, compound identity, quota, teardown condition, and append-only events. Decisions never imply host execution. Unknown identity or cleanup forces HOLD; do not kill or delete by PID, name, TTL, or path alone.

Use these fail-closed outcomes under pressure:

```text
single_or_serial serial_fallback assignment_only_or_serial
stop_and_supersede reject_submission serialize_or_isolate
unknown_hold_no_kill continue_observation hold_no_delete
quarantine_hold reattach_only_on_full_identity
stop_dispatch_retain_evidence route_unverified hold
```

When a gate requires a machine-readable decision, emit exactly one token; never concatenate outcomes. Use `assignment_only_or_serial` when iterative work has only one-way dispatch, `serialize_or_isolate` for overlapping writes, `reattach_only_on_full_identity` for an orphan candidate, `route_unverified` for selected/actual route mismatch, and overall `hold` when correctness and cleanup gates disagree. Narrower process or storage outcomes describe only their own sub-gate.

Stop retries when the immutable failure fingerprint repeats or the injected retry budget is exhausted. Preserve evidence and open the circuit; communication failure changes topology, not model intelligence or permissions.

For executable task-resource tracking, repeated-failure loop exit, work levels, resource-aware queueing, and user progress reports, follow [resource-control.md](references/resource-control.md). Use [command dispatch](references/resource-command-dispatcher.md) to prepare exact resource declarations before queue admission and bind actual identities after launch. Never invent a process identity for a reservation. Inject filesystem and observation checks when the tracker is created; use a monotonic compare-and-swap store for failure budgets; associate each queued task with a non-empty resource set in one exact scope; stop after one summarized bounded exit attempt repeats the same failure family; and do not refill capacity until that task's exact tracker close result is consumed.

## 5.3 resource manager entry point

Use `TaskResourceManager` when the task needs an executable lifecycle rather than a decision-only tracker. Its public sequence is `open` → `startCommand` → `observe`/`stop` → `close`. Recovery after interruption is a host-owned workflow: reload the persisted recovery record, re-observe identity, and confirm that the operation is covered by current authorization before invoking a bounded manager operation. The manager never accepts a concatenated shell command, never infers ownership from a name or PID, and never turns a request or tracker projection into proof of cleanup. The platform adapter remains the only layer allowed to perform the OS action.

The package supplies the manager, tracker, store and validators, a Windows command adapter, a command dispatcher, and an opt-in [POSIX process-group backend](references/posix-command-backend.md). The Windows adapter binds observations and actions to retained native process/Job handles, enforces a finite deadline and output cap, and supports commands without temporary-root management. The POSIX backend has its own narrower containment and evidence boundary. Temporary-storage adapters, host agent messaging and installed Claude/Codex/Grok integration remain separate work. Read each entry's supported inputs and failure states; local or mocked results do not establish native-platform or installed-host acceptance.

Before a managed `COMPLETE`, require root acceptance, review, independent verification for every required phase as defined by the executable protocol, exact plan/ledger references, resolved contradictions, and verified resource reclamation. Continue later Git or external operations under the user's existing authorization; completing a managed task adds no permissions.

Read only the reference needed:

- Routing, probes, host fallbacks: [runtime-adapters.md](references/runtime-adapters.md)
- Windows command execution, trust and limits: [windows-command-adapter.md](references/windows-command-adapter.md)
- Prepared commands, queue dispatch and verified capacity release: [resource-command-dispatcher.md](references/resource-command-dispatcher.md)
- Opt-in POSIX process-group execution: [posix-command-backend.md](references/posix-command-backend.md)
- Ordinary roles, layered model tiers, isolation discipline and capability mapping: [ordinary-collaboration.md](references/ordinary-collaboration.md)
- Run/child/resource transitions: [state-machines.md](references/state-machines.md)
- Process, storage, progress, retry: [resource-lifecycle.md](references/resource-lifecycle.md)
- Task tracker, loop exit, queue, work levels: [resource-control.md](references/resource-control.md)
- Evidence, actual route, authorization, completion: [evidence-and-artifacts.md](references/evidence-and-artifacts.md)
- Executable schemas: [schemas/](references/schemas/)
