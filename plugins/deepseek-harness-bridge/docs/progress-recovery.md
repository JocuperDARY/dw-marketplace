# Progress-aware recovery episodes

New budgeted tasks use `progress-v2`. One initial tool-free, off-effort recovery is available for confirmed output truncation or an explicitly checked invalid final JSON summary. A later episode is eligible only after a successful ordinary checkpoint stage newly satisfies a parent-declared `recoveryMilestones` entry. Without that optional contract, one shared recovery remains the effective behavior. Existing saved `bounded-v1` or unversioned records retain their original rules; upgrading does not retry them. Single-request never recovers or continues.

Each milestone names a relative workspace JSON artifact and exact scalar assertions. The parent chooses these conditions before dispatch, from the actual acceptance requirements. For example:

```json
{
  "executionMode": "budgeted",
  "budget": {},
  "recoveryMilestones": [
    {"id":"phase-1-tests","path":"phase1-receipt.json","assertions":[
      {"pointer":"/runId","expected":"phase-1"},
      {"pointer":"/exitCode","expected":0},
      {"pointer":"/failed","expected":0}
    ]}
  ]
}
```

This snippet is an example contract, not spending authorization. Preserve any caller-specified totals. An empty budget adds no Bridge total ceiling; it does not remove provider or storage constraints. The milestone array has at most 64 unique IDs, at most 32 assertions per ID and at most 32768 normalized UTF-8 bytes. It is an optional bounded evidence contract, not a new model-call, token or time budget. Omitted milestones never silently grant additional episodes.

Before every stage, including recovery, the Bridge reads matching artifacts as baseline. Existing matches are consumed without granting progress. After a successful ordinary stage saves valid checkpoint JSON, it checks previously unmatched milestones again. A new exact match is recorded with its ID, stage and SHA-256. A stage whose baseline could not be observed cannot receive credit. IDs are consumed once across restart and continuation, so toggling a file, repeating an ID, changing checkpoint prose or incrementing a worker-declared counter does not replenish eligibility. Recovery stages cannot grant progress themselves. A repeated checkpoint with no new verified milestone pauses as before.

Artifact observation uses guarded relative paths, the existing 256 KiB file boundary and strict UTF-8/JSON. Protected paths, links, unknown I/O failures and malformed data never grant a match. Known absent files can later become new evidence; unknown baseline access cannot. Observation has a separate 5-second response deadline and honors cancellation; pending OS reads may settle later. No observation failure starts a model or raises a resource limit.

This validates only the parent's declared artifact conditions. It does not prove that the worker caused the change, that a self-written receipt is authoritative, that all required work is complete or that content/scientific acceptance passed. Choose task-owned evidence paths and independently establish receipt authority. A semantic rejection never triggers this recovery mechanism.

Recovery still requires confirmed cleanup/accounting and remaining original authorization. Each recovery is one request, zero tools and off effort. Original partials are saved before another request; side effects are not replayed. A recovery failure ends its episode without chaining another recovery. Cancellation, storage clipping, denied calls, unknown accounting/cleanup and persistence failures retain the original stopping rules. Restart and continuation preserve the ledger, consumed IDs, original totals and deadline.

`orchestration.recoveryPolicy`, `recoveryEligible` and `verifiedProgress` expose the saved eligibility evidence. Eligible is a policy condition, not a promise that remaining budget or runtime state permits a request. All caller totals stay unchanged. Native automatic sessions continue to use SDK compaction; this policy concerns budgeted stages only.
