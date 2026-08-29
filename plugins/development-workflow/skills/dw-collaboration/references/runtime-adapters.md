# Runtime adapters

Treat Claude Code, Codex, Grok Build, or any other host name as a discovery hint only. Select behavior from observed semantic capabilities.

## Evidence ladder

```text
DECLARED < PROBED < OBSERVED < VERIFIED
```

Inventory/configuration can declare a capability. A nonce/ack probe can show that one operation succeeded in the current session. Runtime events show actual execution. Independent verification binds the result. A send request, configured agent name, selected route, or child self-report is not execution evidence.

A host receipt may say `VERIFIED` only when it references a separate own-hash probe record with a fresh nonce-bound request, adapter acknowledgement, collection, independent message, liveness observation, cleanup observation, monotonic timestamps, a future expiry, and a verifier independent of every probe-event producer. The policy, receipt, probe, every probe event, and optional runtime-route metadata each carry their own hash and producer binding. In addition, the host adapter must inject a non-JSON `trustedHostAttestor`/`trustedRuntimeResolver` that authenticates the captured runtime session. The command-line validator intentionally has no such resolver and therefore cannot promote self-authored files to VERIFIED. Without the complete record set and trusted resolver the host remains `UNVERIFIED`; self-authored matching JSON is not independent runtime proof.

Probe only what the current topology needs, with zero business side effects and a bounded timeout:

- spawn and collect;
- root-to-child and child-to-root messaging;
- interrupt/shutdown and verified exit;
- shared task status;
- isolated workspace and exclusive ownership;
- runtime/process identity, terminal and port observation;
- temporary or constrained-compute leases;
- requested and actual model/effort metadata.

Bind evidence to adapter fingerprint, authorization fingerprint, generation, session, observation time, expiry, and contradiction records. Drift, expiry, a failed ack, or a capability available on only one side invalidates the intersection.

Trusted resolvers are host integration seams, not trust data. Do not expose them to child-controlled plugin code or construct them from the same artifact collection they authenticate. Their backing approval/runtime store must define issuer ownership, key or handle custody, rotation, revocation, recovery, and audit separation.

## Validator input budgets

The dependency-free CLI accepts at most 256 artifact paths. Before reading any file content it requires a regular, non-symbolic-link file, limits each file to 8 MiB, and limits the complete artifact transaction to 32 MiB. It then opens and retains every file descriptor, binds descriptor and post-open path identity back to the preflight device/inode/size, and reads only from those retained descriptors. Path rebound, symlink/reparse replacement, missing stable identity, size drift, or short reads fail closed; actual per-file and transaction bytes are checked again while reading. Every success and failure path closes all opened descriptors. Direct `validateTaskPacket` calls enter the same detached canonical JSON budget used by artifact validation, including depth, node, key, array-item, and cumulative string/key-byte limits. Budget failure is `CONTRACT_LIMIT_EXCEEDED`; callers must not retry with a widened limit or partial collection.

## Topology downgrade

- No proven spawn/collect: use `single`.
- Spawn/collect without bidirectional messaging: use `assignment_only` with a self-contained immutable packet.
- Fresh bidirectional messaging and liveness on both sides: `interactive_shared` may be used.
- Any mid-run communication failure: stop new shared steps and use `serial_fallback` if safe; otherwise HOLD.

Changing topology does not raise or lower the selected intelligence lane. Model and effort are selected from task/risk/phase needs. Do not upgrade merely because communication failed, and do not claim the requested pair actually ran without host metadata.

## Ownership and messages

Root owns plan, acceptance, repository writes, outer resources, and terminal decisions. A child owns only its explicit task-local paths/resources and cannot create descendants unless separately authorized. Shared mutable writes are serial unless isolated by exclusive ownership.

Interactive messages carry blockers, decision evidence, or milestone results; they do not mutate the immutable task packet, authorization, generation, or ownership. Material change creates a new packet or superseding plan generation.

## Unavailable hosts

Do not install tools, log in, spend credits, launch GPU work, or contact third parties merely to increase coverage. Record the unavailable host/capability as `UNVERIFIED`, keep the applicable local evidence, and choose a conservative topology.
