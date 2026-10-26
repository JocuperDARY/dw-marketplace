# Implementation delegation and parent acceptance

For source generation, use the selected tools and the user's existing execution scope. Numerical code, gradients, broadcasting and cross-file implications normally justify `workload: reasoning` (default high); use `verification` with a review/lifecycle contract when reviewing evidence. High is not a correctness guarantee. Preserve explicitly fixed effort and all task totals. Do not raise effort, add Shell, execute a generated test or retry just because content was wrong.

Standard, reasoning and verification tasks receive conditional implementation/test guidance through the SDK system prompt, including native skills/files workers with no Shell and inference-only workers. Mechanical/drafting workloads omit that detailed guidance; the parent must choose the workload for the substantive work rather than the output's appearance. Ordinary execution-reuse guidance remains Shell-specific. These instructions do not add schema fields, deliverables, capabilities or semantic validation. Their request bytes share existing limits; a constrained request may still be too small.

## Source-generation assignment template

Fill only applicable sections with authoritative requirements. These are prompt sections, not additional MCP fields or permission grants. Do not turn this template into new scientific requirements.

```text
Objective, ownership and task level:
<Requested files/API; authoritative rules versus claims under review; immutable
references; source preparation, permitted local execution, or integration.>

Execution boundary:
<Actual selected tools and permitted commands/devices/network/data. Source-only:
write runnable tests but report tests_executed=false and status=NOT_RUN.>
<Generated tests must also respect these limits when later executed. For an
explicit CPU-only/no-device-probe contract, do not call accelerator discovery,
transfer modules to it, or seed device RNGs indirectly. Use an allowed mock or
a mismatch rejected before arithmetic. Preserve required outer RNG states.>

Numerical and interface invariants:
<Rank, ordered axes, dtype/device, masks, valid-value domain, empty-case meaning,
units, normalization, parameter names/order, serialization and ownership.>
<Derive expected results independently; include distinct dimensions AND equal
dimensions with unequal per-sample values to detect silent axis mixing.>
<If differentiable: inspect invalid-slot arithmetic before masking, test
poisoned padding and extreme valid inputs, check forward AND backward results,
valid-input/parameter gradients and the specified padding-gradient behavior.>
<Check fixture shape/dtype/device before invoking the target. Verify the test
reaches the operation it names, instead of failing earlier validation.>

Delivery and evidence:
<Requested output schema/files. For each applicable acceptance condition,
record NOT_RUN, static analysis, observed execution or reused evidence; give
its exact basis. Keep limitations explicit. Do not invent tests or logs.>
<When execution is authorized: command, exit, raw log, tested identities,
unique method IDs and counts, executions, subtest error records, rerun scope.
Do not count reruns as new unique tests or turn a targeted pass into a final
full-suite pass. Preserve the original failure and corrected copy separately.>
<Changed forward behavior requires corresponding checkpoint, inference/export
paths; external units remaining equal is not internal architectural parity.
Unperformed integration and scientific acceptance remain NOT_RUN/not assessed.>
```

## Parent checks before adoption, in priority order

1. **Execution scope**: review generated tests before running them. CPU-only fixtures can still contain a device probe, transfer, global seed or import side effect. Check the actual installed library behavior; record unsupported claims as unknown. A lazy device-seed operation alone does not prove device initialization. Source review is not an OS sandbox.
2. **Silent numerical errors**: check rank and semantic axis alignment, not only broadcastability. A `[B,H] / [B]` expression can divide feature columns by another sample's count when `B=H`; distinct dimensions expose shape errors while equal sizes with unequal values expose the silent case. A finite masked forward output can still conceal nonfinite backward intermediates. Inspect masking before unsafe arithmetic and require relevant gradient evidence before accepting a gradient claim. Use the task's declared valid-input domain and tolerances; do not weaken them to pass.
3. **Test validity**: independently derive zero/one/count values and both sides' normalization. Check fixture rank, dtype/device and expected parameter order; a test rejected before its named operation has not tested that operation. Separate module/core evidence from full-model integration, checkpoint reload and inference/export parity.
4. **Evidence and counts**: match commands, exit codes, artifacts and relevant source/input/configuration identities. A receipt hash pins receipt bytes; without a pre-execution source manifest it does not independently pin the code that ran. Describe any handoff/diff-based source binding honestly. Count unique methods, total executions, failed methods and subtest error records separately. A targeted correction may close a bounded defect without a redundant full rerun, but cannot be labeled a single full-suite pass on the final snapshot.

Keep one compact parent record per acceptance condition:

| ID / invariant | Worker claim | Independent basis | Result and scope |
| --- | --- | --- | --- |
| Axis alignment | Shapes broadcast | Named axes plus rectangular/equal-size controls | Accept/correct/unknown; static versus executed |
| Padding gradients | Forward is finite | Appropriate backward and parameter-gradient evidence | UNKNOWN until the relevant evidence exists |
| CPU-only test | Test source written | Review of explicit and implicit device/RNG calls | Source accepted; execution still NOT_RUN |
| Final suite | Targeted repairs passed | Original full run plus identified affected-method run | Preserve both statuses and final-snapshot limitation |
| Integration | External output units unchanged | Checkpoint and inference/export behavior | NOT_RUN until independently verified |

These examples are conditional checks, not extra prerequisites for unrelated tasks. The parent selects the smallest tests that resolve actual uncertainty. Do not repeat training or model calls merely to replace a historical failure with a cleaner summary.

## Existing deterministic checks and their limits

Use [dsh_check_result](parent-evidence.md) with parent-owned literal/arithmetic/execution checks for a complete pinned result. Synthetic example: a full run covers 115 unique methods, two methods fail with five subtest error records, and a subsequent affected run passes those same two methods. That is 115 unique methods and 117 executions, not 117 unique tests. The original run still failed, and a single final full-suite pass remains false. Literal checks can compare those counts/flags with the parent's verified facts; execution checks can compare each run claim with its own pinned receipt. The tool does not infer the facts from logs or establish source authority.

Add manual semantic/scientific checks for array meaning, gradient correctness, library assertions and integration scope. They remain UNKNOWN / PARENT_REVIEW_REQUIRED even when all literal checks pass. The source-only worker's `tests_executed=false` must remain distinct from later parent-run evidence. Missing receipts are unknown, not success. Runtime completion, JSON validity, structural coverage, implementation correctness, parent acceptance and scientific acceptance are separate.

Offline regressions verify guidance reaches selected worker profiles and actual network-blocked SDK requests, retains explicit effort/caps/single-request rules, and preserves wrong-but-complete results without automatic retries. Synthetic parent-check controls reject inflated counts and unsupported execution claims while leaving missing gradient/semantic evidence unknown. They do not execute the reported scientific code, measure live Flash accuracy, or prove that prompting eliminates content errors.
