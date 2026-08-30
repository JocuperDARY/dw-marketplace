# Evidence, authorization, and completion

`ExecutionReceipt1` records actual execution after collect, root acceptance, review, verification, and cleanup. It does not turn a plan, route candidate, child message, local edit, commit, or cleanup request into proof that an action occurred.

## Artifact identity

The receipt binds exact `{artifact_id, content_sha256}` references for the current `CollaborationPlan1` and `ResourceLedger1`. Resolve both through independent, own-hash-verified validation records bound to the same run and session. The plan record supplies the required phases, plan generation, and phases for which an exact execution lane is an acceptance condition. The ledger record supplies the terminal run state, resource states, approved retained artifacts, and its exact plan reference.

Changing an ID, hash, run, session, plan generation, validation status, authority, or source hash invalidates the receipt. A dangling, cross-session, or stale reference cannot be repaired by copying a new hash into the receipt.

## Phase evidence chain

Every required phase resolves these sealed records in order:

```text
dispatch -> running -> result_submission -> root_acceptance
         -> root review -> independent verification
```

All records bind run, session, phase, result hash, observation time, actor, link to the previous record, source evidence, and their own hash. An own hash proves content integrity only; it does not authenticate the actor. Root acceptance/review and verifier records additionally require a non-JSON `trustedAuthorityResolver` supplied by the host trust boundary. Verification requires verifier authority and a different actor from the root acceptor/reviewer. A child self-report is only a result submission; it cannot accept, review, or verify itself.

## Actual route

`requested_*` and `selected_*` describe planning. `actual_model` and `actual_effort` describe execution only when an own-hash-verified `host_runtime_metadata` record binds the same run, session, phase, model, and effort and the host's non-JSON `trustedRuntimeResolver` authenticates that record. Caller-supplied JSON cannot provide this trust.

- `VERIFIED`: exact host runtime metadata is present.
- `UNVERIFIED`: `actual_model` and `actual_effort` are `unknown`, and no execution claim is made.
- `NOT_REQUIRED`: route identity is not an acceptance condition; `actual_model` and `actual_effort` remain `unknown`, and `actual_route_evidence` is null. It cannot carry an execution claim.

`UNVERIFIED` may coexist with a valid result when the plan does not require an exact lane. If the plan marks a phase exact-lane-required, only `VERIFIED` passes.

## Authorization1

Each external or repository action requires its own exact record:

```text
authorization_id, actor_id, actor_kind, scope, action, resource_ids,
issued_at, expires_at, plan_ref, source_evidence_ref, source_sha256
```

Validation binds the expected human/system actor, scope, one action, exact resource set, validity window, current plan, allowed source-evidence class, and own hash. It returns authorized only when a host-owned `trustedAuthorizationResolver` separately authenticates the record and source handle. The resolver is application code or an adapter-owned approval-store bridge, never a field in the artifact or another caller-supplied JSON index. Without it the result is `AUTHORIZATION_TRUST_NOT_PROVEN`. Child or agent messages cannot authorize. The actions are distinct:

```text
execute_plan, select_assurance_route, local_edit, stage, commit, push, merge, publish, deploy,
paid_job, credential_change, config_change, constrained_compute
```

There are no implied edges. In particular, local edit does not authorize stage or commit; commit does not authorize push, merge, tag, publish, deploy, credential changes, paid work, or constrained compute.

The host owns trust-root identity, custody, delivery, rotation, revocation, recovery, and separation of duties. This dependency-free validator deliberately does not mint approval handles, store keys, or treat a valid hash as a signature.

## COMPLETE gate

Receipt outcome and the independently reduced ledger terminal state are exact pairs: `COMPLETE -> COMPLETE`, `CANCELLED -> CANCELLED`, `FAILED -> FAILED_RECLAIMED`, and `PARTIAL|HOLD|UNVERIFIED -> HOLD`. A mismatch is invalid even if the receipt is internally self-consistent.

`run_outcome=COMPLETE` requires:

- every plan-required phase has the full accepted/reviewed/verified evidence chain;
- exact-lane phases have VERIFIED actual-route evidence;
- the plan and ledger validation records match the receipt and each other;
- the ledger terminal state is `COMPLETE`;
- every resource is `RECLAIMED`, except a sealed artifact explicitly named by the approved retention record;
- cleanup status is `all_reclaimed` and binds the ledger hash. A root-owned sealed artifact may instead be `RETAINED` only when the ledger and receipt both name it and an own-hash retention record binds the run, plan, resource, policy, root authorization, independent verification, and evidence;
- every contradiction is `RESOLVED`;
- no verifier disagreement or dangling reference remains.

`UNKNOWN`, `QUARANTINED`, active process/temp/worktree leases, unresolved contradictions, or incomplete evidence force rejection/HOLD. Completion never implies Git integration, release, publication, deployment, or teardown authority.
