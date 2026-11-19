# Runtime adapters

Scope: this reference defines the optional managed protocol and its machine-readable evidence. For ordinary native-tool delegation, use the lightweight procedure in [dw-collaboration](../SKILL.md). Protocol probes and hash-linked attestations apply when that managed protocol is selected.

Treat Claude Code, Codex, Grok Build, or any other host name as a discovery hint only. Select behavior from observed semantic capabilities.

For finite Windows commands, the shipped [command adapter](windows-command-adapter.md) connects TaskResourceManager to the native Job supervisor. Its process observations and bounded command lifecycle are a narrower capability than the host-agent receipts described below. It does not establish agent messaging, model dispatch, temporary-storage support or installed-host acceptance. Ordinary commands and tests can use the shared backend without adopting this full host protocol.

The [command dispatcher](resource-command-dispatcher.md) connects prepared manager commands to queue admission and verified scope closure. The separately selected [POSIX backend](posix-command-backend.md) manages an owned process group for ordinary commands and tests; it is not a POSIX TaskResourceManager adapter or a Windows Job equivalent. Its offline tests do not establish native Linux/macOS acceptance.

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

## Managed child route selection

The selector computes a child route for the optional managed protocol. Root model continuity and native-tool delegation follow [ordinary collaboration](ordinary-collaboration.md#模型与思考深度). The host supplies a non-JSON `trustedLanePolicyResolver` that receives frozen `{purpose, lane, phaseAxes, now}` data and returns exactly `{canonicalModel, supportedEfforts}` for the effective child target. Its mapping must account for aliases, inherited values and role or runtime defaults. Before returning a resolution, the host must verify from independent evidence that the catalog row's availability reference belongs to that effective target. Missing, throwing, malformed or rejecting resolution leaves the lane unavailable.

The eligible canonical models are `gpt-6.1-terra`, `gpt-6.2-sol` and `gpt-6.2-astra`. The selector trims whitespace and normalizes case for both the literal lane ID and the resolved model. It excludes `gpt-5.5`, `gpt-5.6`, `gpt-6-luna`, `gpt-6-sol`, `gpt-6.1-sol` and `gpt-6-astra`, their hyphenated variants, and aliases resolving to them. The selector checks that the catalog row's reference names a fresh, supported capability and that both the lane and the host support the selected effort. An authorized plan must cite the same reference as the winning catalog row after recomputation.

For `light` and `standard` floors, the managed default fallback is `gpt-6.2-sol` at `medium`, subject to the same eligibility and evidence checks. For higher floors, alternatives must still meet the class floor and support `high`. Assurance keeps its scope-bound authorization and lease requirements. The selector emits `low`, `medium` or `high`. A host may report additional supported efforts such as `ultra` without changing the selector's presets or the plan schema.

`fallbacks` contains model IDs for planning. The `requested_*` fields record intent, and `validateRouteDecision` checks agreement with the current recomputation. Before dispatching a fallback, retrying, or continuing a child, the adapter must recompute for the intended lane against current evidence and the effective host mapping. Proceed only on `SELECTED` with both `selected_model` and `selected_effort` matching the pair already authorized for that attempt. For the ordinary fallback, that pair is `gpt-6.2-sol/medium`. Hold or replan when either value changes. Upon a match, request both values explicitly. Execution identity and live support require evidence from the actual host.

## Ownership and messages

Root owns plan, acceptance, repository writes, outer resources, and terminal decisions. A child owns only its explicit task-local paths/resources and cannot create descendants unless separately authorized. Shared mutable writes are serial unless isolated by exclusive ownership.

The plan validator conservatively normalizes slash, case and dot-segment path aliases and detects ancestor/descendant overlaps between unordered phases. Literal ownership entries cannot contain wildcard selectors, control characters or Windows trailing-dot/space aliases. Logical resource IDs must map to real exclusive host resources before dispatch. Lexical checks do not prove real-path, symlink or reparse isolation; that remains a host responsibility.

Interactive messages carry blockers, decision evidence, or milestone results; they do not mutate the immutable task packet, authorization, generation, or ownership. Material change creates a new packet or superseding plan generation.

## Unavailable hosts

Do not install tools, log in, spend credits, launch GPU work, or contact third parties merely to increase coverage. Record the unavailable host/capability as `UNVERIFIED`, keep the applicable local evidence, and choose a conservative topology.
