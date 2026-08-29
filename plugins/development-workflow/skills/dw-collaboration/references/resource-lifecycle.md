# Resource lifecycle

The 5.2.0 `TaskResourceTracker` applies these existing safety decisions across nested task scopes; see [resource-control.md](resource-control.md). The tracker records and orders decisions, while the host still performs and verifies any real stop or removal.

This reference defines decision contracts. The helpers do not start, stop, kill, rename, or delete anything. A host adapter must separately prove that it supports an action, obtain any required authorization, execute it, and append the real action receipt to `ResourceLedger1`. `TaskResourceTracker.exportLedgerProjection()` returns only history-derived hints and explicitly marks them as not being a ledger. It never creates missing start, stop, reclaim, or retention events. Only a separately built and validated `ResourceLedger1` can feed `ExecutionReceipt1`.

## Fixed recovery order

For a process, runtime thread, terminal, command session, or port, preserve this order:

1. stop new work;
2. request graceful shutdown;
3. wait for the policy-defined bounded observation window;
4. re-observe and compare the complete identity;
5. request exact owned-tree termination only after `MATCH`;
6. verify process, thread, terminal, and port absence;
7. release downstream leases.

`REQUEST_GRACEFUL`, `WAIT_BOUNDED`, and `TERMINATE_EXACT_TREE` are decisions, not execution receipts. `TERMINATE_EXACT_TREE` requires exact generation plus PID/handle, start time, executable hash, argv hash, parent identity hash, launch nonce, native process-manager run ID when available, and the bound cwd, port, or purpose. PID reuse, command drift, parent drift, scope drift, generation drift, an unknown owner, or a duplicate run lock produces `HOLD` or `OBSERVE_ONLY`; it never widens termination authority. An observed exit is not reclaimed until absence is verified.

## Temporary allocation manifest

Before a child may write, seal one manifest containing exactly:

```text
owner_id, run_id, session_id, lease_generation,
canonical_root_identity, created_at,
quota_profile_ref, watermark_policy_ref,
child_sublease_map, retention_set, state, manifest_sha256
```

`canonical_root_identity` binds the canonical path, path identity hash, parent identity hash, and platform. Every child sublease binds its owner, canonical descendant, nonce, generation, soft quota, hard quota, and teardown condition. `manifest_sha256` is the canonical SHA-256 of the other manifest fields.

Quota and watermark values come only from named, own-hash-verified host, workload, or explicit synthetic-test policy receipts. The implementation has no universal byte, percentage, time, retry, or progress threshold. If a live policy cannot be resolved, the result is `OBSERVE_ONLY` with `UNVERIFIED`; expansion, dispatch, reclaim, and destructive cleanup remain forbidden.

The controlled write decisions are:

- `ALLOW_WRITE`: usage is below the injected soft quota and available space is above the injected low watermark.
- `STOP_EXPANSION`: soft quota or low watermark has been reached.
- `STOP_DISPATCH`: hard quota or critical watermark has been reached.
- `OBSERVE_ONLY`: required live values are not observable, or TTL expired while a handle remains active.
- `HOLD`: manifest, owner, generation, root, child descendant, policy, reparse, rebound, or reclaim proof is invalid.

`RECLAIM_EXACT` additionally requires an exact observation shape, `identity_observed=true`, explicit `reparse_boundary=false` and `path_rebound=false`, an absolute platform-consistent canonical root, the teardown condition, quiescence, zero active handles, exact owner/generation/root identity, a sealed retention-set hash, and matching pre/post path identity checks. A host-owned non-JSON `trustedFilesystemResolver` must authenticate the observation; own hashes and lexical descendant checks alone are insufficient. Missing fields, an unauthenticated observation, or an unknown boundary returns HOLD. When the platform supports atomic same-parent rename, quarantine the exact candidate and revalidate file/parent identity before removal. TTL alone never grants reclaim authority.

## Progress and retry

A progress report must include:

- successful, failed, completed, and pending counts;
- return-code distribution;
- child/process/thread liveness and identity confidence;
- newest artifact write, or `not_observable`;
- CPU, GPU, memory, and I/O observations, each permitting `not_observable`;
- temporary usage, quota reference, disk watermark, and watermark reference;
- blockers, external waits, retry state, and circuit state;
- last meaningful progress evidence and the next gate;
- bounded observation windows and a named progress-policy receipt.

A percentage-only report is invalid. Meaningful CPU, I/O, artifact, or heartbeat change is `QUIET_PROGRESS`. An independently identified external job with evidence and a next check is `EXTERNAL_WAIT`. `SUSPECTED_HUNG` requires the policy-defined number of consecutive no-progress windows; missing policy or insufficient windows remains `UNVERIFIED`.

Retry is allowed only for a classified transient failure with no side effect, one non-empty idempotency key, an immutable failure fingerprint, and a named retry policy. Exhaustion or a repeated fingerprint returns `OPEN_CIRCUIT` and stops new dispatch. Unknown side effects, non-transient failures, missing identity, or missing policy return `HOLD`.

## Platform receipts

Run only the applicable platform observation. Windows may use an owned short-lived marker and exact PID/start/command/parent/native-run metadata; POSIX may use an owned process group/session and symlink boundary. A non-applicable case must emit `SKIP_NOT_APPLICABLE:<platform>:<reason>` and is not a PASS for that platform. Preserve the lifecycle helper run ID and cleanup result; never terminate by image name, wildcard, or an identity-incomplete PID.
