---
name: dw-collaboration
description: Use when a task may need multiple agents, model/effort routing, interactive or assignment-only collaboration, or strict ownership and resource lifecycle controls.
---

# Multi-agent collaboration

Select intelligence and collaboration topology separately. Classify task type, dependency depth, risk/reversibility, phase, latency/cost, and validation failure cost. Request the least expensive model/effort that can satisfy the acceptance gate; record the actual model or effort only from host-observed execution metadata.

## Ordinary collaboration

Use the live tool declarations to choose an available operation. Its first useful call supplies runtime evidence; an extra empty probe is only useful when a required capability is genuinely uncertain. Configuration remains declared evidence.

Delegate only when permitted and useful. A bounded task needs an objective, inputs, file ownership, expected result, relevant limits, and a return channel. Record its result and remaining uncertainty in the existing task record. Ordinary reviews and text edits can use the host's native task tools.

## Optional managed resource protocol

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

For executable task-resource tracking, repeated-failure loop exit, work levels, resource-aware queueing, and user progress reports, follow [resource-control.md](references/resource-control.md). Register and bind resources before launch; inject filesystem and observation checks when the tracker is created; use a monotonic compare-and-swap store for failure budgets; bind each queued task to a non-empty list of resources in one exact scope; stop after one summarized bounded exit attempt repeats the same failure family; and do not refill queue capacity until that task's exact tracker close result is consumed.

## 5.3 resource manager entry point

Use `TaskResourceManager` when the task needs an executable lifecycle rather than a decision-only tracker. Its public sequence is `open` → `startCommand` → `observe`/`stop` → `close`. Recovery after interruption is a host-owned workflow: reload the persisted recovery record, re-observe identity, and confirm that the operation is covered by current authorization before invoking a bounded manager operation. The manager never accepts a concatenated shell command, never infers ownership from a name or PID, and never turns a request or tracker projection into proof of cleanup. The platform adapter remains the only layer allowed to perform the OS action.

Before a managed `COMPLETE`, require root acceptance, review, independent verification for every required phase as defined by the executable protocol, exact plan/ledger references, resolved contradictions, and verified resource reclamation. Continue later Git or external operations under the user's existing authorization; completing a managed task adds no permissions.

Read only the reference needed:

- Routing, probes, host fallbacks: [runtime-adapters.md](references/runtime-adapters.md)
- Run/child/resource transitions: [state-machines.md](references/state-machines.md)
- Process, storage, progress, retry: [resource-lifecycle.md](references/resource-lifecycle.md)
- Task tracker, loop exit, queue, work levels: [resource-control.md](references/resource-control.md)
- Evidence, actual route, authorization, completion: [evidence-and-artifacts.md](references/evidence-and-artifacts.md)
- Executable schemas: [schemas/](references/schemas/)
