# Resource lifecycle

The 5.3.0 `TaskResourceTracker` applies these safety decisions across nested task scopes, preserving the helper behavior carried forward from 5.2.0; see [resource-control.md](resource-control.md). The tracker records and orders decisions, while the host still performs and verifies any real stop or removal.

This reference defines decision contracts. The helpers do not start, stop, kill, rename, or delete anything. A host adapter must separately prove that it supports an action, obtain any required authorization, execute it, and append the real action receipt to `ResourceLedger1`. `TaskResourceTracker.exportLedgerProjection()` returns only history-derived hints and explicitly marks them as not being a ledger. It never creates missing start, stop, reclaim, or retention events. Only a separately built and validated `ResourceLedger1` can feed `ExecutionReceipt1`.

## Read-only host baseline before intervention

A scheduled check or incident response begins with a bounded, read-only host baseline before classification or action. The observation job is itself task-owned: give it an owner, run and generation, a single-instance guard, a timeout, a maximum output size, a sampling policy, and a teardown condition. Prefer observing existing activity over repeatedly launching the same expensive probe, and use backoff when a probe could amplify the source-control, filesystem, event-log, or state-store load being diagnosed.

Only a candidate already declared by the current task and proven `TASK_OWNED` may be bound to the task ledger and the complete process identity required below. Do not register an `EXTERNAL` or `UNKNOWN` candidate as task-owned; retain only bounded, redacted observation evidence and keep its action `OBSERVE_ONLY` or `HOLD`. Then keep four questions separate rather than collapsing them into one state:

- **ownership**: `TASK_OWNED`, `EXTERNAL`, or `UNKNOWN`;
- **progress**: `ACTIVE_PROGRESS`, `QUIET_PROGRESS`, `SUSPECTED_HUNG`, or `UNKNOWN`;
- **relevance**: `CURRENT`, `OBSOLETE_CANDIDATE`, or `COMPLETED`; and
- **action**: `OBSERVE_ONLY`, `REQUEST_GRACEFUL`, a later identity-bound recovery decision, or `HOLD`.

These four host-audit axes are prose reasoning dimensions for an operator or host adapter. They are not serialized runtime fields, `PROGRESS_CLASSIFICATIONS`, or new state-machine enums. The existing runtime progress mapping remains `WORKING`, `QUIET_PROGRESS`, `EXTERNAL_WAIT`, `SUSPECTED_HUNG`, and `UNVERIFIED`.

`OBSOLETE_CANDIDATE` means that the owning task is terminal or superseded and no output, child, port, lease, retention, or cleanup obligation still depends on the process. `SUSPECTED_HUNG` means that the policy-defined consecutive observation windows did not reach the registered next-progress gate, no trusted external wait explains the pause, and the gate cannot currently complete without intervention. Neither classification grants graceful-stop or force authority. Low CPU and no output do not establish `SUSPECTED_HUNG`; a timeout, teardown condition, task failure, interruption, old age, stable memory, a repeated command, or a process name is also insufficient by itself. Missing, non-monotonic, overlapping, method-drifted, identity-drifted, or unauthenticated windows remain `UNVERIFIED`.

Collect only applicable, observable signals. A normal host baseline can include the harness and its descendants, source-control workers, endpoint-security scanning, UI/renderer helpers, optional accelerator clients, language runtimes, CPU, memory, I/O, newest task artifact, ports, and task-owned temporary storage. On Windows, Codex, Git, Defender, renderer, GPU, and Node observations are examples; those names are evidence filters, not kill selectors. Third-party, system, foreground, user-started, external, and unknown processes default to `OBSERVE_ONLY` or `HOLD`.

When version-control churn is suspected, resolve the Git root read-only. If the Git root is a user home or profile directory, inspect a bounded summary of the tracked set, redacted remotes, and applicable ignore rules before changing anything. Measure already-running `git status`, untracked-file enumeration such as `git ls-files --others`, and related filesystem activity without printing an unbounded home-directory file list or manufacturing another polling loop.

Correlate platform crash events and application state-store or journal growth only within the same observation interval. SQLite main-file, WAL, and SHM sizes or change rates may be useful evidence when observable. Historical crashes, PIDs, WAL growth, load samples, or earlier cleanup results are context, not current action authority; after a host or application restart, reacquire the whole baseline and identity.

## Persistent repair, recovery, and comparison

Keep persistent repair separate from process recovery. Before a persistent configuration, repository, or state-store repair, make an exact, minimal backup using a supported consistent snapshot method. Record the source identity and hash, backup identity and hash, access controls, retention owner, restoration steps, and restoration acceptance check. Redact remote credentials, argv secrets, environment values, event details, and crash material. A backup neither makes process termination reversible nor grants stop, delete, or force authority.

Never delete, move, reset, or reinitialize `.git` as diagnosis or cleanup. Repair only the proven configuration or metadata after its exact backup; a Git bundle protects refs but is not a backup of the index, configuration, ignored files, or untracked data. Never delete, truncate, replace, or force-checkpoint an active SQLite WAL merely because it grew. Use the application's supported backup interface, or first obtain an owned, verified quiescent state and take a consistent database/WAL/SHM snapshot.

For an executable resource, retain the fixed recovery order below. Even a graceful request changes live state and therefore needs current exact ownership, a valid teardown reason, and current action authority. Force still requires the opening authorization, a fresh host-owned identity resolution bound to the request and expected-identity hashes, and an exact managed job, process group/session, or individually subleased tree. An authenticated managed job, process group, or session boundary may cover its descendants without an individual sublease for each child. A descendant outside that authenticated managed boundary and lacking a valid individual sublease plus identity binding makes the whole tree `HOLD`. A drifted, escaped, external, independently user-owned, or unknown descendant also makes the tree `HOLD`; never widen the target to whatever currently appears below one PID.

After a stop or persistent repair, compare against the retained baseline with at least three strictly time-ordered samples spanning at least 15 seconds and using the same-method scope. A named policy may require longer. Compare applicable process identity/liveness, source-control command rate, CPU, memory, I/O, accelerator use, newest artifact, state-store or WAL change rate, crash recurrence, ports, and trusted UI responsiveness. UI responsiveness comes from a trusted probe or user confirmation, never from lower CPU alone. Record unavailable fields as `not_observable` and report `UNVERIFIED` or `HOLD` when a required field is missing.

The 15-second floor applies only to post-action host comparison; it is not a hung threshold, wait timeout, termination permission, or automatic PASS. Exact process, thread, terminal, port, and temporary-resource absence remains a separate required check. If the targeted symptom and cleanup postconditions are not both supported by fresh evidence, do not widen deletion or termination. Retain evidence, return `HOLD`, and use the recorded restoration path only when that rollback is still safe and authorized.

`validateProgressReport()` version 1 is a descriptive classifier. It does not authenticate elapsed time, sampling method, target identity, or host authority and is not action or termination authority. A host that may change live state must independently authenticate the windows and pass the ownership, authorization, fixed-recovery, and absence gates in this reference.

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
