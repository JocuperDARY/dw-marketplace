# State machines

The executable source of truth is `scripts/lib/state-machines.js`; the JSON surface is `schemas/ResourceLedger1.schema.json`. Do not add convenience edges in prose.

## Run

```text
PLANNING -> PLAN_VALIDATED -> AUTHORIZED -> LEDGER_OPEN
LEDGER_OPEN -> DISPATCHING | RUNNING
DISPATCHING -> RUNNING | CANCELLING | FAILED | HOLD
RUNNING -> COLLECTING | ROOT_REVIEW | CANCELLING | FAILED | HOLD
COLLECTING -> ROOT_REVIEW | CANCELLING | FAILED | HOLD
ROOT_REVIEW -> VERIFYING | CANCELLING | FAILED | HOLD
VERIFYING -> RECLAIMING | CANCELLING | FAILED | HOLD
CANCELLING | FAILED -> RECLAIMING | HOLD
RECLAIMING -> COMPLETE | CANCELLED | FAILED_RECLAIMED | HOLD
```

Terminal run states have no outgoing edge. Final transitions require a sealed terminal intent and resource-reclaimed evidence.

## Child

The canonical success chain is `DECLARED -> DISPATCH_REQUESTED -> DISPATCH_ACKED -> START_OBSERVED -> WORKING -> RESULT_SUBMITTED -> RESULT_ACCEPTED -> REVIEWED -> VERIFIED -> CLOSED`. Quiet progress, external wait, suspected hung, cancellation, interruption, failure, and unknown are explicit states. `RESULT_REJECTED -> WORKING` requires a strictly newer, different task-packet version/hash; a repeated guard cannot be replayed.

Result submission may be child-authored. Acceptance and review require root authority. Verification requires an independent verifier and a linked, unchanged result hash. Every authority record is integrity-checked and then authenticated by a host-owned, non-JSON `trustedAuthorityResolver`; a caller-supplied authority index or own hash cannot establish trust. Missing, rejecting, throwing, or non-boolean resolver results fail closed with `AUTHORITY_TRUST_NOT_PROVEN`.

## Resource

```text
DECLARED -> LEASED -> START_REQUESTED -> ACTIVE
ACTIVE -> QUIESCING | TERMINATE_REQUESTED | EXIT_OBSERVED
QUIESCING -> ACTIVE | TERMINATE_REQUESTED | EXIT_OBSERVED
TERMINATE_REQUESTED -> EXIT_OBSERVED
EXIT_OBSERVED -> RECLAIMING -> RECLAIMED
artifact: RECLAIMING -> RETAINED
```

Allowed guarded shortcuts and fail-closed `UNKNOWN|QUARANTINED` edges are defined only in the executable table. `RETAINED` is terminal and applies only to a root-owned artifact with `artifact_sealed`, owner/generation proof, root authorization, and an independent own-hash verifier record; it is not an alias for `RECLAIMED`. Executable resources must observe exit before reclaim. Never-started resources need no-side-effect proof. Child resources require a root-owned active parent, a verified sublease, matching generation, and parent LEASE before child LEASE.

## Event rules

Events are append-only and processed in supplied order. A ledger must contain one non-empty canonical run stream whose subject is the ledger run ID. IDs share one run-wide namespace. Per subject, sequence increments exactly by one, time increases, generation and owner do not drift, `from_state` equals the current snapshot, and run/child arrays match their machine. A superseding event never deletes or rewinds history and cannot supersede sealed evidence.

The trusted resolver receives frozen detached authority data plus a frozen context binding the reference, purpose, run, subject, generation, required role, actor, observation time, and exact usage path. The same resolver boundary applies to lifecycle guards, validated-plan authority, resource seals, sublease authorization/verification, and retained-artifact authorization/verification.

`HOLD`, `UNKNOWN`, and `QUARANTINED` are evidence-preserving terminal outcomes. Do not invent recovery edges; create a new authorized generation after root-cause evidence.
