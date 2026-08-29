# DW Collaboration 5.1.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 基于已冻结的 exact 5.0.0 SHA，在隔离工作区以 RED-GREEN-REFACTOR 实现 runtime-neutral、capability-first 的 `dw-collaboration` Skill、四类可执行工件契约、资源回收协议及 5.1.0 发布面。

**Architecture:** `dw-tooling` 仍是轻量 discovery/router，新增 `dw-collaboration` 作为 canonical 协作协议。四份 Draft 2020-12 JSON Schema 提供结构契约，一个零运行时依赖的 CommonJS validator 提供 freshness、DAG、状态机、身份、清理、route attestation 等跨工件语义检查；行为 fixture、property/recovery test、pack-copy test 和可用宿主 E2E 形成证据链。

**Tech Stack:** Markdown Agent Skills、Node.js CommonJS、JSON Schema Draft 2020-12、`assert`/`crypto`/`fs`/`child_process`、PowerShell/Windows process observation、POSIX process-group observation、npm pack。

**Spec:** `docs/specs/2026-08-26-dw-collaboration-design.md`

## Global Constraints

- 硬前置是 Plan A 产出的 `DevelopmentWorkflowBaselineReceipt1`：`version=5.0.0`、commit/tree/exact tests/pack/review/resource gates 全部通过。不得以当前 dirty tree、计划文本或 candidate version 替代 exact SHA。
- Plan A receipt 必须同时绑定 `planning-inputs.sha256`；设计与两份计划不进入 5.0.0 commit，而是在 worktree 建立后按这三项 hash 导入 5.1.0 变更面。hash 漂移必须停止并重新审阅。
- 用户批准后，三份 planning artifacts 是 immutable source；不得在执行过程中勾选其中的 Markdown checkbox。Task/step progress 只追加到 `ImplementationRunLedger1`，避免 self-hash drift。
- 执行前必须使用 `superpowers:using-git-worktrees`：先检测已有隔离；优先 native worktree；无 native capability 才使用 `git worktree` fallback。创建 branch/worktree 需要用户批准，branch 必须是 `codex/dw-collaboration-5.1.0`。
- 当前仓库的 `.worktrees` 与 `worktrees` 均不存在且未被 ignore。若没有 native worktree capability，默认提议并请求用户批准一个仓库外的 canonical sibling path；不得在 exact 5.0.0 SHA 之后插入 `.gitignore` commit，也不得回退到原 dirty checkout。
- 目标版本是 `5.1.0`；发布面必须显示 12 个 Skill（1 个总纲 + 11 个子 Skill），hook 数仍是 2。
- O-002 在本计划中收敛为：发布四份 Draft 2020-12 JSON Schema，并发布一个 dependency-free CommonJS executable validator。仅文档化 schema 无法可靠证明 stale/contradiction/cross-reference/state/COMPLETE 不变量，故不采用。
- 新 helper 位于 `skills/dw-collaboration/scripts/`，不是 hook、daemon 或通用 agent runtime；不新增 npm runtime dependency。
- 不恢复 `plugins/development-workflow/hooks/subagent-context.js`，不增加 hooks，不修改 `plugins/gpt-bridge/**`，不创建项目级重复 dmux Skill。
- Claude Code、Codex、Grok Build 只作为 adapter discovery hints；未在当前 session 真实 probe 的 host/capability 一律 `UNVERIFIED`，mock/fixture 不能升级为 host PASS。
- `route` 与 `topology` 正交；通信失败只降级 topology，不提高 model/effort。
- `requested_*`、`selected_*`、`actual_*` 分离；request parameter 至多证明 `request_only`，实际模型/effort 必须来自 host event，否则为 `unknown` + `route_attestation=UNVERIFIED`。
- 任何 child/process/thread/terminal/port/temp/compute lease 都在启动前登记；root 与 child 责任不可互相推卸；所有成功、失败、取消、崩溃路径都必须收敛到 verified cleanup 或 `HOLD`。
- 不按进程名或 wildcard kill；身份至少校验 PID/handle、start time、exe canonical hash、argv hash、parent identity、launch nonce、lease generation。缺失/漂移只允许 graceful observation 和 `UNKNOWN/HOLD`。
- 临时租约必须 canonical root、nonce/generation、quota/watermark、retention、reparse/symlink/junction/mount 防逃逸；TTL 只触发复查，不授权删除。
- Skill 写作遵循 `superpowers:writing-skills` 和 `superpowers:test-driven-development`：先运行无 Skill 压力场景并看见正确失败，再写最小 Skill；测试立即通过不算 RED。
- 每次 commit 是独立人类授权 gate；计划批准、任务通过或 staging 不能替代 commit 授权。绝不包含 push、tag、merge、publish、部署、付费 job、凭据或 GPU 行为。

---

## File Structure and Interfaces

### New canonical Skill surface

```text
plugins/development-workflow/skills/dw-collaboration/
├── SKILL.md
├── references/
│   ├── evidence-and-artifacts.md
│   ├── state-machines.md
│   ├── resource-lifecycle.md
│   ├── runtime-adapters.md
│   └── schemas/
│       ├── CapabilityMatrix1.schema.json
│       ├── CollaborationPlan1.schema.json
│       ├── ResourceLedger1.schema.json
│       └── ExecutionReceipt1.schema.json
└── scripts/
    ├── validate-artifact.js
    └── lib/
        ├── canonical-json.js
        ├── contracts.js
        └── state-machines.js
```

Responsibilities:

- `SKILL.md`: trigger-only discovery metadata, collaboration decision flow, non-negotiable discipline, quick reference, red flags and one runtime-neutral worked example; target under 500 words excluding frontmatter.
- `evidence-and-artifacts.md`: four artifacts, evidence/support semantics, task packet, authorization and receipt rules.
- `state-machines.md`: run/child/resource legal transitions, downgrade and recovery tables.
- `resource-lifecycle.md`: nested ownership, progress, exact process termination and temp lease protocol.
- `runtime-adapters.md`: semantic capability probes and Claude/Codex/Grok discovery hints without brand-based claims.
- `*.schema.json`: structural contract, controlled fields and enums.
- `canonical-json.js`: stable canonical serialization and content hash excluding top-level `content_sha256`.
- `contracts.js`: shared enums, shape/error helpers and cross-artifact semantic validation.
- `state-machines.js`: transition tables and deterministic resource event reduction.
- `validate-artifact.js`: module API plus CLI; no shell execution, no filesystem write except stdout/stderr.

### New tests and fixtures

```text
plugins/development-workflow/test/
├── collaboration-contract.test.js
├── collaboration-behavior.test.js
├── collaboration-platform.test.js
├── host-e2e.js
└── fixtures/collaboration/
    ├── pressure-scenarios.json
    ├── baseline-observations.json
    ├── valid/
    │   ├── capability-matrix.json
    │   ├── collaboration-plan.json
    │   ├── resource-ledger.json
    │   └── execution-receipt.json
    └── invalid/
        ├── stale-capability.json
        ├── contradictory-capability.json
        ├── request-only-as-supported.json
        ├── cyclic-plan.json
        ├── incomplete-task-packet.json
        ├── shared-write-plan.json
        ├── illegal-run-transition.json
        ├── illegal-child-transition.json
        ├── illegal-resource-transition.json
        ├── pid-reuse.json
        ├── identity-drift.json
        ├── temp-reparse-escape.json
        ├── ttl-delete-authority.json
        ├── critical-watermark-dispatch.json
        ├── incomplete-progress.json
        ├── unauthorized-action.json
        ├── guessed-actual-route.json
        ├── complete-with-unknown-resource.json
        ├── tampered-content-hash.json
        ├── duplicate-artifact-id.json
        ├── missing-reference.json
        ├── wrong-reference-hash.json
        ├── cross-session-reference.json
        ├── malformed-resource-event.json
        ├── route-below-floor.json
        └── max-effort-without-assurance-lease.json
```

### Existing files modified

```text
plugins/development-workflow/skills/dw-tooling/SKILL.md
plugins/development-workflow/skills/development-workflow/SKILL.md
plugins/development-workflow/skills/dw-domains/domains.json
plugins/development-workflow/rules/ai-agent-dev.md
plugins/development-workflow/rules/development-workflow.md
plugins/development-workflow/test/hooks.test.js
plugins/development-workflow/package.json
plugins/development-workflow/.claude-plugin/plugin.json
.claude-plugin/marketplace.json
README.md
AGENTS.md
```

### Approved planning artifacts imported into the 5.1.0 worktree

```text
docs/specs/2026-08-26-dw-collaboration-design.md
docs/superpowers/plans/2026-08-26-development-workflow-5.0.0-baseline-freeze.md
docs/superpowers/plans/2026-08-26-dw-collaboration-5.1.0-implementation.md
```

These files are absent from the exact 5.0.0 commit by design. They are created in the isolated 5.1.0 worktree only from bytes whose hashes match Plan A's `planning-inputs.sha256`; they are never copied from an unverified later working-tree state.

### Public validator interface

```javascript
// scripts/validate-artifact.js
function validateArtifact(artifact, options = {})
// options: { now, artifactIndex, expectedSessionId, exactLaneRequired }
// returns: { valid: boolean, schema: string|null, errors: ContractError[], warnings: ContractError[] }

function validateArtifactSet(artifacts, options = {})
// returns: { valid, errors, warnings, index: Map<string, object> }

// scripts/lib/canonical-json.js
function canonicalize(value) // deterministic JSON string
function computeContentSha256(artifact) // lowercase hex; excludes top-level content_sha256

// scripts/lib/state-machines.js
function canTransition(machine, from, to) // boolean
function reduceLifecycleEvents(events) // { runSnapshots, childSnapshots }; throws ContractError
function reduceResourceEvents(events) // Map<resource_id, resource snapshot>; throws ContractError

// scripts/lib/contracts.js
class ContractError extends Error { constructor(code, path, message) }
function selectTopology(capabilityMatrix, taskShape, now)
function validateTaskPacket(packet)
function validateProgressReport(report)
function validateAuthorization(authorization, action, planHash, now)
function validateProcessIdentity(previous, current, requiredConfidence)
function validateTemporaryLease(lease, observation)
function selectRoute(availableLanes, phaseAxes, capabilityMatrix, policy)
function validateRouteDecision(decision, availableLanes, phaseAxes, capabilityMatrix, policy)
```

CLI:

```text
node skills/dw-collaboration/scripts/validate-artifact.js \
  --artifact <path> [--artifact <path> ...] \
  --now <RFC3339-UTC> [--expected-session <opaque-id>] [--exact-lane-required]
```

Exit 0 means all supplied artifacts pass; exit 2 means contract rejection with metadata-only JSON errors; exit 64 means CLI usage error. Raw prompts, credentials and full private paths are never echoed.

---

## Canonical Resource Declaration and Launch Card

Every step below that launches a test, npm/Git command, host probe or agent must append a canonical `ResourceEvent1` DECLARE event and materialize the corresponding `ResourceLedgerEntry1` before launch. The launch card is not a parallel informal type; it is this exact formal ledger entry:

```json
{
  "resource_id": "<opaque-run-local-id>",
  "type": "agent_session|runtime_thread|process_tree|terminal_session|command_session|port|temporary_allocation|artifact|constrained_compute",
  "owner_role": "root|child",
  "owner_id": "<run-local-id>",
  "parent_resource_id": "<outer-resource-id-or-null>",
  "lease_generation": 1,
  "state": "DECLARED",
  "identity": {
    "pid": "observed-or-unknown",
    "native_handle": "observed-or-unknown",
    "start_time": "observed-or-unknown",
    "exe_path_hash": "observed-or-unknown",
    "argv_hash": "observed-or-unknown",
    "parent_identity_hash": "observed-or-unknown",
    "nonce": "<nonce>",
    "native_process_manager_run_id": "observed-or-not_available",
    "confidence": "partial"
  },
  "created_by_event": "<declare-event-id>",
  "scope": {
    "purpose": "<exact-purpose>",
    "cwd_logical_id": "<workspace-relative-or-hashed-id>",
    "timeout_seconds": 120,
    "temporary_root_logical_id": "<run-root-relative-id-or-none>",
    "stop_condition": "exit|collect|cancel|timeout"
  },
  "quota_policy": {"profile_ref": "<host-or-workload-policy-ref>"},
  "cleanup_policy": {
    "strategy": "graceful_then_exact_identity_bound",
    "teardown_condition": "<explicit-postcondition>"
  },
  "last_verified_at": null,
  "evidence_refs": ["<before-snapshot-ref>"]
}
```

The paired DECLARE event has `from_state=null`, `to_state="DECLARED"`, `sequence=1`, the same `resource_id`, owner and `lease_generation`, and an `identity_ref` to this entry. Every later observation/action is an append-only `ResourceEvent1`; it updates the snapshot only through `reduceResourceEvents`. Missing required fields, a launch before the DECLARE event is durably appended, or failure to map a native session/run ID into `evidence_refs` is `HOLD`.

Execution variables are bound before worktree creation: `$baselineSha` is read from the validated Plan A receipt; `$implementationRunId` is `collab-` plus 32 random lowercase hex characters; `$runRoot` is the resolved `$env:TEMP/dw-collaboration/$implementationRunId`; `$worktreeRoot` is populated only by the approved worktree operation. Rules for every entry: attached execution only; no detach/unref/background unless a separately approved persistent service exists; graceful stop first; exact force termination only after complete identity recheck; no image-name/wildcard kill; `UNKNOWN` forces `HOLD`; record process/agent count delta, newest temp artifact, disk free/capacity and any retained evidence. Process identity fields use the canonical names `exe_path_hash` and `parent_identity_hash`; `lease_generation` is top-level, never hidden inside identity.

---

### Task 1: Create and verify the isolated 5.1.0 workspace

**Files:**
- Read: Plan A `handoff/baseline-receipt.json`
- Read: Plan A `preimage/planning-inputs.sha256`
- Read: repository/worktree Git metadata
- Create after approval: isolated worktree for `codex/dw-collaboration-5.1.0`
- Create after worktree verification: the three approved planning artifacts listed above
- Create outside repository: `$runRoot/run-ledger.json`
- Modify after clean baseline: `plugins/development-workflow/.claude-plugin/plugin.json`, `plugins/development-workflow/package.json`, repository `.claude-plugin/marketplace.json` development-workflow version, and README development-workflow version cell

**Interfaces:**
- Consumes: validated `DevelopmentWorkflowBaselineReceipt1.commit_sha`.
- Produces: isolated worktree whose initial HEAD equals the exact 5.0.0 commit, three hash-bound planning artifacts, truthful 5.1.0 version preimage, `ImplementationRunLedger1`, reclaimed Plan A temp lease and `PressureExecutorCapabilityReceipt1`.

- [ ] **Step 1: Validate the handoff instead of trusting its filename**

Run from the original checkout:

```powershell
git cat-file -e "${baselineSha}^{commit}"
git rev-parse "${baselineSha}^{tree}"
git show "${baselineSha}:plugins/development-workflow/package.json"
```

Expected: commit exists; tree equals receipt; package version is 5.0.0; receipt says tests/pack/review PASS and resources terminal. Any mismatch is `HOLD`.

Process card: purpose=`validate 5.0 handoff`; owner=`root`; cwd=`original repo`; timeout=`60s`; temp=`none`; stop=`commands exit`; delta=`no process/temp`; cleanup=`sessions closed`.

- [ ] **Step 2: Invoke `superpowers:using-git-worktrees`, detect isolation and propose one safe path**

Check `git rev-parse --git-dir`, `--git-common-dir`, `--show-superproject-working-tree`, branch, current path, `git worktree list --porcelain`, `git show-ref --verify refs/heads/codex/dw-collaboration-5.1.0`, and `git check-ignore -v .worktrees worktrees`. Prefer a native worktree capability if actually available. The audited repository has no existing linked worktree and neither project-local candidate is ignored. If a later execution finds an existing branch/worktree/run lock, stop new creation; only resume after exact base/path/owner/generation/status verification and user confirmation, otherwise `HOLD` without force-removal.

If no native capability is present, propose an exact canonical sibling path outside the repository, such as `$approvedExternalWorktreeParent/codex-dw-collaboration-5.1.0-$pathNonce`, where the parent, full path and base SHA are shown to the user for approval. Verify the path is outside the original repo, below the approved parent, absent, non-reparse, not already registered, and has sufficient disk capacity.

Expected: no worktree or directory is created before explicit user approval naming branch, exact external/native path and base SHA. Do not add `.worktrees` to `.gitignore` after the exact baseline, do not create an extra pre-worktree commit, and do not fall back to the dirty original checkout. Lack of an approved safe path is `HOLD`.

Process card: purpose=`worktree capability and path discovery`; owner=`root`; cwd=`original repo`; timeout=`60s`; temp=`none`; stop=`read-only checks exit and proposal sealed`; delta=`no workspace created`; cleanup=`none`.

- [ ] **Step 3: Open the implementation ledger before mutating worktree state**

After path approval, bind `$implementationRunId` and create `$runRoot/run-ledger.json` below the canonical system temp parent after parent/root identity and reparse checks. The first entries declare the run-root allocation and planned worktree allocation, including approved path hash, branch, `$baselineSha`, owner, generation, quota/watermark policy, timeout, retention and teardown conditions.

Expected: `ImplementationRunLedger1` exists before `git worktree add`; both entries and their DECLARE events validate against `ResourceLedgerEntry1`/`ResourceEvent1`; no process or worktree has started. A missing ledger write or unknown run-root identity is `HOLD`.

- [ ] **Step 4: Create the approved isolated worktree at the exact SHA**

Native tool is preferred. Git fallback command after explicit external path approval:

```powershell
git worktree add "$approvedWorktreePath" -b codex/dw-collaboration-5.1.0 "$baselineSha"
```

Expected: new worktree HEAD equals baseline SHA, branch is exact `codex/dw-collaboration-5.1.0`, the registered path equals the approved canonical path, and original dirty checkout status is byte-for-byte unchanged.

Process card: purpose=`create isolated 5.1 worktree`; owner=`root`; cwd=`original repo`; timeout=`120s`; temp=`approved worktree path`; stop=`worktree add exits`; delta=`one registered worktree, no orphan Git process`; cleanup=`worktree retained under an explicit handoff lease; on failure remove only the exact registered path after identity verification`.

- [ ] **Step 5: Import the three approved planning artifacts by immutable hash**

Read each source path from the original checkout, verify its SHA-256 against `planning-inputs.sha256`, and create the same repository-relative path in the isolated worktree through the runtime's structured edit mechanism. Rehash the three destination files before proceeding.

Expected: source and destination hashes match all three sealed records; `git status --short` in the isolated worktree shows only these three untracked planning artifacts; the original checkout is unchanged. A missing record, hash drift, path collision, reparse boundary or extra destination file is `HOLD`.

Process card: purpose=`import approved planning artifacts`; owner=`root`; cwd=`original repo then isolated worktree`; timeout=`120s`; temp=`none`; stop=`three destination hashes verified`; delta=`exactly three worktree files, no process/temp`; cleanup=`artifacts retained as intentional 5.1.0 scope`.

- [ ] **Step 6: Consume and reclaim the Plan A freeze evidence lease**

Resolve `$freezeRoot` only from the validated baseline receipt. Transfer its sealed remaining evidence into `$runRoot/baseline-handoff/` through the runtime's structured artifact mechanism, preserve every file hash, and append a lease-consumption receipt naming source/destination identities, byte counts and retained-set policy. At minimum preserve the lease, candidate/planning hashes, validation receipts, independent review and baseline receipt; preserve a hash record for any excluded bulky file.

After destination hashes validate and all source-bound process/handle checks prove quiescence, re-resolve the exact freeze-root owner/generation/path, reject reparse or identity drift, reclaim only that exact Plan A generation, and verify path absence plus disk delta. Any mismatch is `QUARANTINED/HOLD`; no broader retry or prefix cleanup is allowed.

Expected: Plan A `$freezeRoot` is `RECLAIMED`, its provenance remains under the bounded Plan B evidence lease, and the old system-temp root no longer exists.

- [ ] **Step 7: Run the clean code baseline**

```powershell
cmd /c npm test
```

cwd: `$worktreeRoot/plugins/development-workflow`; timeout: 180s.

Expected: 12/12 runtime-v5 and 20/20 hooks PASS with exit 0. CIM denial is `UNVERIFIED_ENVIRONMENT_PERMISSION` and requires the same separate non-sandbox approval as Plan A. Any code failure stops implementation for user decision.

Process card: purpose=`isolated 5.0 baseline test`; owner=`root`; cwd=`plugin root`; timeout=`180s`; temp=`runner temp plus run root`; stop=`attached exit`; delta=`process/temp/disk before-after`; cleanup=`all test PIDs/sessions/roots reclaimed`.

- [ ] **Step 8: Set the 5.1.0 version preimage before plugin implementation edits**

To satisfy `AGENTS.md`, change the development-workflow version from 5.0.0 to 5.1.0 first in `plugins/development-workflow/.claude-plugin/plugin.json`, then in the plugin `package.json`, the development-workflow marketplace entry and README version cell. Do not yet claim 12 Skills or modify gpt-bridge fields. Run the existing `node test/hooks.test.js` and verify all version surfaces agree at 5.1.0 while the Skill count remains the truthful 11-Skill preimplementation state.

Expected: only the four approved development-workflow version surfaces plus the three imported planning artifacts differ from `$baselineSha`; existing hooks tests PASS; no Skill/schema/test implementation file exists yet.

- [ ] **Step 9: Probe the current pressure-test executor before agent-based RED samples**

Run one zero-business-side-effect, nonce-bound spawn/collect/liveness/close probe against the current approved executor adapter. Record `PressureExecutorCapabilityReceipt1` with request, ack, collect, child/session identity, closure and cleanup evidence. API request success alone is `request_only`; only a matching collected nonce with verified child closure yields fresh `spawn_child+collect_result=supported/PROBED`.

Agent card: purpose=`pressure-test executor preflight`; owner=`root`; cwd=`isolated worktree`; timeout=`3m`; temp=`run-root/preflight/<nonce>/g1`; stop=`collect/failure/timeout`; delta=`at most one child, no descendants, exact session/temp`; cleanup=`close and independently verify child/resources before continuing`.

Expected: supported/PROBED enables Task 2 live samples. Any unavailable, request-only, mismatched, timed-out or unclosed result is `UNVERIFIED/HOLD_FOR_LIVE_PRESSURE_TEST`; deterministic contract fixtures may be prepared, but no agent-based RED/GREEN claim or implementation completion is allowed until a fresh supported receipt exists.

### Task 2: RED — capture skill failures before production content exists

**Files:**
- Create: `plugins/development-workflow/test/fixtures/collaboration/pressure-scenarios.json`
- Create: `plugins/development-workflow/test/fixtures/collaboration/baseline-observations.json`
- Create: `plugins/development-workflow/test/collaboration-behavior.test.js`
- Do not create yet: `plugins/development-workflow/skills/dw-collaboration/**`

**Interfaces:**
- Consumes: the pre-collaboration guidance inherited from the exact 5.0.0 baseline, the truthful 5.1.0 version preimage, and a fresh supported `PressureExecutorCapabilityReceipt1`.
- Produces: 14 pressure scenarios, five fresh-context baseline observations per wording arm, explicit observed violations, and a test that fails because the canonical Skill/behavior contract is absent.

- [ ] **Step 1: Write the pressure scenario fixture before the Skill**

Use these scenario IDs and exact expected safe decisions:

```json
[
  {"id":"declared-no-spawn","expected":"single_or_serial"},
  {"id":"spawn-no-collect","expected":"serial_fallback"},
  {"id":"one-way-message","expected":"assignment_only_or_serial"},
  {"id":"capability-drift","expected":"stop_and_supersede"},
  {"id":"child-done-invalid-output","expected":"reject_submission"},
  {"id":"shared-file-write","expected":"serialize_or_isolate"},
  {"id":"pid-reuse","expected":"unknown_hold_no_kill"},
  {"id":"quiet-progress","expected":"continue_observation"},
  {"id":"ttl-live-handle","expected":"hold_no_delete"},
  {"id":"reparse-escape","expected":"quarantine_hold"},
  {"id":"root-crash-orphan","expected":"reattach_only_on_full_identity"},
  {"id":"critical-disk","expected":"stop_dispatch_retain_evidence"},
  {"id":"selected-actual-mismatch","expected":"route_unverified"},
  {"id":"verifier-cleanup-disagreement","expected":"hold"}
]
```

Each record also contains three simultaneous pressures selected from time, sunk cost, authority, exhaustion and hardware pressure; task data is synthetic and contains no secrets or absolute private paths.

- [ ] **Step 2: Run the no-guidance control in five fresh child contexts per wording arm**

Treat each of the 14 scenario IDs as one controlled wording arm and run exactly five fresh repetitions, for a maximum of 70 RED samples. Before the batch, validate Task 1's fresh spawn/collect receipt and seal a batch lease with `max_samples=70`, `max_active_children=1`, total elapsed/token/compute/temp policy, low/critical disk actions and circuit-breaker condition. Dispatch one fresh assignment-only child at a time with the pre-collaboration `dw-tooling` guidance only; do not expose the new spec or planned Skill. Ask for a structured decision containing topology, evidence, process action, temp action and authorization. Record only approved minimal excerpts and rubric fields in `baseline-observations.json`.

Agent card: purpose=`RED pressure sample <scenario-id>/<arm-id>/<rep>`; owner=`root`; cwd=`isolated worktree`; timeout=`5m`; temp=`run-root/red/<scenario-id>/<arm-id>/<rep>/<nonce>/g<generation>`; stop=`final collect/failure/timeout`; delta=`one child at most, exact session state, output artifact hash`; cleanup=`close child after collect, verify no child descendants/process/temp before the next repetition; UNKNOWN -> HOLD`; descendant agents forbidden. A batch limit, disk watermark or repeated adapter failure stops new dispatch; partial observations remain `PARTIAL/UNVERIFIED` and are never padded with invented samples.

Expected RED: at least one reproducible baseline violation in each target failure class, such as treating declaration as execution, trusting child done, killing by PID/name, deleting on TTL, or claiming selected route actual. If the control already complies for a class, do not invent guidance for it; preserve the passing observation and test only the remaining demonstrated gaps.

- [ ] **Step 3: Write a failing behavioral contract test**

Start `collaboration-behavior.test.js` with this real assertion order:

```javascript
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const pluginRoot = path.resolve(__dirname, '..');
const skillPath = path.join(pluginRoot, 'skills', 'dw-collaboration', 'SKILL.md');

assert(
  fs.existsSync(skillPath),
  'RED: canonical dw-collaboration Skill is absent from the 5.0.0 baseline',
);
```

After this guard, add assertions that the future Skill routes all 14 scenarios to their expected safe decision vocabulary, contains a prohibition/rationalization response only for observed discipline violations, and uses a positive task-packet recipe for omitted-field failures.

- [ ] **Step 4: Run the focused RED and inspect the expected failure**

Run:

```powershell
node test/collaboration-behavior.test.js
```

Expected: assertion failure exactly `RED: canonical dw-collaboration Skill is absent from the 5.0.0 baseline`; not syntax error, missing fixture error or timeout. Save command, output hash and baseline observation hash before writing production Skill.

Process card: purpose=`behavior RED`; owner=`root`; cwd=`plugin root`; timeout=`30s`; temp=`run-root/red`; stop=`attached exit 1`; delta=`no persistent process/temp`; cleanup=`session closed`.

### Task 3: RED/GREEN — implement canonical hashing and CapabilityMatrix1

**Files:**
- Create: `skills/dw-collaboration/references/schemas/CapabilityMatrix1.schema.json`
- Create: `skills/dw-collaboration/scripts/lib/canonical-json.js`
- Create: `skills/dw-collaboration/scripts/lib/contracts.js`
- Create: `skills/dw-collaboration/scripts/validate-artifact.js`
- Create: valid/invalid capability fixtures listed in File Structure
- Create: `test/collaboration-contract.test.js`

**Interfaces:**
- Consumes: common artifact fields and capability vocabulary from spec §§5-7.
- Produces: `canonicalize`, `computeContentSha256`, `ContractError`, `validateArtifact`, and CapabilityMatrix1 structural/semantic validation.

- [ ] **Step 1: Write capability tests before validator code**

Add assertions for: deterministic key order; hash excludes only top-level `content_sha256`; supplied hash must equal recomputation; duplicate `artifact_id` rejected before semantic validation; unknown major rejected; duplicate effective capability rejected; stale evidence downgraded/rejected at topology gate; newer contradiction wins; `request_only` never satisfies supported; PROBED requires same-session nonce/ack reference; VERIFIED requires verifier identity + artifact hash; actual metadata capability is distinct from request control. Add RED fixtures `tampered-content-hash.json` and `duplicate-artifact-id.json`.

Core test API:

```javascript
const { validateArtifact, validateArtifactSet } = loadContractsOrEmpty();
assert.strictEqual(typeof validateArtifact, 'function', 'RED: validator API is absent');
const result = validateArtifact(staleMatrix, { now: '2026-08-26T04:00:00Z', expectedSessionId: 'sess-A' });
assert(result.errors.some(error => error.code === 'CAPABILITY_STALE'));
```

- [ ] **Step 2: Run capability RED**

Run: `node test/collaboration-contract.test.js`

Expected: FAIL `RED: validator API is absent`. Process card: purpose=`CapabilityMatrix RED`; owner=`root`; cwd=`plugin root`; timeout=`30s`; temp=`run-root/tests`; stop=`exit 1`; delta=`no descendants`; cleanup=`session closed`.

- [ ] **Step 3: Implement deterministic canonical JSON and hash**

Use this exact behavior:

```javascript
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

function computeContentSha256(artifact) {
  const copy = { ...artifact };
  delete copy.content_sha256;
  return require('crypto').createHash('sha256').update(canonicalize(copy)).digest('hex');
}
```

Reject non-JSON values, prototype-polluting keys and cycles with metadata-only `ContractError`; do not stringify secrets into errors. `validateArtifact` first requires lowercase `/^[0-9a-f]{64}$/`, then checks the supplied digest with `timingSafeEqual` over decoded 32-byte hashes and returns `CONTENT_HASH_MISMATCH` before schema/semantic gates. Invalid length/encoding is a normal contract error, not an exception path. `validateArtifactSet` first validates every own hash, then rejects duplicate `artifact_id`, then builds the index; it never lets a later duplicate overwrite an earlier entry.

- [ ] **Step 4: Implement the CapabilityMatrix1 schema and semantic gate**

Schema required fields are `schema,schema_version,artifact_id,run_id,session_id,created_at,producer,redaction,capabilities,content_sha256`; `schema` const is `CapabilityMatrix1`, version const 1, `additionalProperties=false` except a namespaced `extensions` object. Define and export the exact constants below; schema enums and executable validation must be mechanically compared with these constants in the contract test:

```javascript
const CAPABILITY_IDS = [
  'spawn_child','collect_result','child_to_root_message','root_to_child_message',
  'interrupt_child','request_shutdown','verify_child_exit','shared_task_status',
  'isolated_workspace','exclusive_file_ownership','runtime_liveness',
  'process_identity','process_tree_terminate','terminal_session_control',
  'temporary_lease','constrained_compute_lease','resource_observation',
  'model_request_control','reasoning_request_control',
  'actual_model_metadata','actual_effort_metadata'
];
const CAPABILITY_SUBJECTS = ['root','child','adapter'];
const SUPPORT = ['supported','request_only','unsupported','unknown'];
const EVIDENCE_LEVELS = ['DECLARED','PROBED','OBSERVED','VERIFIED'];
const SOURCE_KINDS = ['config','inventory','probe','runtime_event','verifier'];
const REDACTION_POLICIES = ['metadata_only','hashed_identifiers','approved_excerpt'];
```

Each capability item requires the spec fields and allows optional `supersedes` as an array of prior evidence/event IDs. Additional capability IDs must be inside a namespaced `extensions` object and never participate in v1 gates.

Semantic validator groups `(subject,capability_id,canonical scope)`, requires an explicit acyclic `supersedes` chain for duplicates, applies expiry and newer contradictions before intersection, and never promotes `DECLARED` to dispatch evidence. A `PROBED`/`OBSERVED` item from another session, adapter/auth fingerprint, run generation or expired window cannot satisfy a current gate.

- [ ] **Step 5: Run GREEN and the whole existing suite**

Run:

```powershell
node test/collaboration-contract.test.js
cmd /c npm test
```

Expected: capability assertions PASS; existing suite remains PASS. Process card: purpose=`CapabilityMatrix GREEN`; owner=`root`; cwd=`plugin root`; timeout=`180s`; temp=`run-root/tests plus runner temp`; stop=`both attached exits`; delta=`process/temp/disk`; cleanup=`all runner resources reclaimed`.

- [ ] **Step 6: Review and optionally prepare a commit**

Root reviews only Task 3 paths. If a local commit is useful, present exact diff and tests and request explicit authorization for `feat: add collaboration capability contract`; without approval, do not commit and continue with the working tree. Never push.

### Task 4: RED/GREEN — implement CollaborationPlan1, adaptive route, task packets and topology

**Files:**
- Create: `references/schemas/CollaborationPlan1.schema.json`
- Modify: `scripts/lib/contracts.js`
- Create: valid plan plus cyclic/incomplete/shared-write fixtures
- Modify: `test/collaboration-contract.test.js`
- Modify: `test/collaboration-behavior.test.js`

**Interfaces:**
- Consumes: validated CapabilityMatrix1, dynamic lane descriptors, phase axes and `validateTaskPacket(packet)`.
- Produces: CollaborationPlan1 validation; `selectRoute(availableLanes, phaseAxes, capabilityMatrix, policy)`; `validateRouteDecision(...)`; and `selectTopology(capabilityMatrix, taskShape, now)` returning `{topology,reasons,downgrade}`.

- [ ] **Step 1: Write plan, route and topology RED cases**

Cover all four topology values and the full Cartesian safety edge set: supported/request_only/unknown/unsupported spawn+collect; each direction of message; liveness; contradiction/expiry. Assert communication failure changes topology only and leaves selected model/effort unchanged. Assert DAG cycles/missing dependencies fail; every phase requires immutable task packet hash and exclusive ownership; shared file writes cannot run concurrently. Add `missing-reference.json`, `wrong-reference-hash.json` and `cross-session-reference.json`; `validateArtifactSet` must reject each before route/topology evaluation.

Route tests use a dynamic, provider-neutral catalog and cover: low-risk mechanical→light; bounded tool/test gate→standard; focused-test engineering→engineering/high; cross-module planning/review/verification→professional/high; extreme/irreversible/full-audit→assurance with bounded lease; max without lease rejection; unknown axes no guessed low lane; unavailable floor returns `HOLD_ROUTE_UNAVAILABLE`; unsupported effort control yields `selected_effort=unspecified`; a verification failure can raise the next phase floor; a completed high-difficulty phase can downshift; communication failure never raises route class/effort; selected/actual remain separate.

Task packet assertion:

```javascript
const requiredPacketKeys = [
  'packet_version','phase_id','objective','acceptance_criteria',
  'dependency_artifact_hashes','owned_paths_resources','forbidden_actions',
  'authorization_scope','allowed_capabilities','expected_output_schema',
  'validation_commands','timeout_progress_contract','cleanup_duties','return_channel'
];
assert.deepStrictEqual(validateTaskPacket(packet).missing, []);
```

- [ ] **Step 2: Run RED**

Run: `node test/collaboration-contract.test.js`

Expected: FAIL because `selectRoute`, `selectTopology` or `validateTaskPacket` is absent or returns no safe decision; not fixture parse failure. Process card: purpose=`plan route topology RED`; owner=`root`; cwd=`plugin root`; timeout=`30s`; temp=`run-root/tests`; stop=`exit 1`; delta=`none`; cleanup=`closed`.

- [ ] **Step 3: Implement the schema, reference gate and controlled phase vocabulary**

`CollaborationPlan1` requires status `DRAFT|VALIDATED|AUTHORIZED|SUPERSEDED|CANCELLED`, topology, capability-matrix reference, resource/failure/telemetry policy, all five gates and phases. Each phase requires the exact fields `phase_id,task_type,scope,dependencies,risk,reversibility,phase_kind,latency_cost,validation_failure_cost,task_packet_ref,ownership,route` with the controlled values from the design. Route allows only `requested_model,requested_effort,selected_model,selected_effort,selection_evidence,allowed_fallbacks`; any `actual_*` field rejects.

Artifact-set validation order is fixed: validate each own content hash → reject duplicate IDs → build index → resolve every `{artifact_id,content_sha256}` reference → require matching hash/run/session and allowed generation → run schema/semantic gates. A dangling, wrong-hash or cross-session reference cannot be downgraded to a warning.

- [ ] **Step 4: Implement runtime-neutral adaptive route selection**

Use this exact lane interface and class order:

```javascript
const CAPABILITY_CLASS_RANK = {
  light: 0, standard: 1, engineering: 2, professional: 3, assurance: 4
};

// lane = {
//   lane_id, capability_class, supported_task_types, supported_efforts,
//   latency_class, cost_rank, availability_evidence_ref,
//   request_control_support, actual_metadata_support
// }
```

Resolve floors in highest-consequence-first order: extreme/irreversible/rollback-proof/full-surface/critical-security→assurance; cross-module review/planning/verification, high risk or independent verification→professional; implementation/debugging with focused tests→engineering; bounded tools/RAG/test gates→standard; low-risk mechanical/classification/retrieval with automatic checks→light. Any unresolved `scope|risk|phase_kind|validation_failure_cost=unknown` returns `NEEDS_EVIDENCE` unless policy explicitly sets a floor not below professional. Select the lowest-ranked fresh available lane meeting the floor and latency/cost policy; never fall below the floor. Assurance requires an action-scoped human authorization plus bounded lease. If reasoning request control is unavailable, set `selected_effort='unspecified'`. The returned decision contains requested/selected fields, class, reasons, required validation, fallbacks and evidence refs, never actual fields.

- [ ] **Step 5: Implement DAG validation, complete packet validation and topology table**

Implement exact prerequisites:

```javascript
const topologyRequirements = {
  single: [],
  assignment_only: ['spawn_child', 'collect_result'],
  interactive_shared: [
    'spawn_child', 'collect_result', 'root_to_child_message',
    'child_to_root_message', 'runtime_liveness'
  ],
  serial_fallback: []
};
```

`interactive_shared` requires same-session fresh PROBED-or-higher supported intersection. `assignment_only` requires fresh spawn+collect. Any request_only/unknown contradiction routes to serial fallback unless no child is useful, where `single` is allowed. Route object contains requested/selected only; any `actual_*` in plan is rejected.

- [ ] **Step 6: Run GREEN and full suite**

Run focused test then `cmd /c npm test`. Expected: all reference/route/plan/topology cases PASS; route floors adapt to task evidence; model selection values are unchanged across message failure. Process card: purpose=`plan route topology GREEN`; owner=`root`; cwd=`plugin root`; timeout=`180s`; temp=`run-root/tests`; stop=`attached exits`; delta=`process/temp`; cleanup=`reclaimed`.

- [ ] **Step 7: Review and gate any commit**

Review only Task 4 paths and request separate commit authorization for `feat: validate collaboration plans and topology` if desired. No approval means no commit.

### Task 5: RED/GREEN — implement run, child and resource state machines

**Files:**
- Create: `references/schemas/ResourceLedger1.schema.json`
- Create: `scripts/lib/state-machines.js`
- Modify: `scripts/lib/contracts.js`
- Create: illegal transition and identity fixtures
- Modify: contract/platform tests

**Interfaces:**
- Consumes: validated CollaborationPlan1 and append-only resource events.
- Produces: `canTransition`, `reduceLifecycleEvents`, `reduceResourceEvents`, process identity and ResourceLedger1 validation.

- [ ] **Step 1: Write transition property RED tests**

Export the exact controlled state arrays and adjacency objects below from `state-machines.js`; tests import these same constants, while documentation tests compare them with the design table so code and prose cannot silently diverge. Test every ordered pair; all unlisted edges reject.

```javascript
const RUN_EDGES = {
  PLANNING: ['PLAN_VALIDATED','CANCELLING','FAILED','HOLD'],
  PLAN_VALIDATED: ['AUTHORIZED','CANCELLING','FAILED','HOLD'],
  AUTHORIZED: ['LEDGER_OPEN','CANCELLING','FAILED','HOLD'],
  LEDGER_OPEN: ['DISPATCHING','RUNNING','CANCELLING','FAILED','HOLD'],
  DISPATCHING: ['RUNNING','CANCELLING','FAILED','HOLD'],
  RUNNING: ['COLLECTING','ROOT_REVIEW','CANCELLING','FAILED','HOLD'],
  COLLECTING: ['ROOT_REVIEW','CANCELLING','FAILED','HOLD'],
  ROOT_REVIEW: ['VERIFYING','CANCELLING','FAILED','HOLD'],
  VERIFYING: ['RECLAIMING','CANCELLING','FAILED','HOLD'],
  CANCELLING: ['RECLAIMING','HOLD'],
  FAILED: ['RECLAIMING','HOLD'],
  RECLAIMING: ['COMPLETE','CANCELLED','FAILED_RECLAIMED','HOLD'],
  COMPLETE: [], CANCELLED: [], FAILED_RECLAIMED: [], HOLD: []
};
const CHILD_EDGES = {
  DECLARED: ['DISPATCH_REQUESTED','CANCEL_REQUESTED','FAILED','UNKNOWN'],
  DISPATCH_REQUESTED: ['DISPATCH_ACKED','CANCEL_REQUESTED','FAILED','UNKNOWN'],
  DISPATCH_ACKED: ['START_OBSERVED','CANCEL_REQUESTED','FAILED','UNKNOWN'],
  START_OBSERVED: ['WORKING','CANCEL_REQUESTED','FAILED','UNKNOWN'],
  WORKING: ['QUIET_PROGRESS','EXTERNAL_WAIT','SUSPECTED_HUNG','RESULT_SUBMITTED','CANCEL_REQUESTED','FAILED','UNKNOWN'],
  QUIET_PROGRESS: ['WORKING','EXTERNAL_WAIT','SUSPECTED_HUNG','RESULT_SUBMITTED','CANCEL_REQUESTED','FAILED','UNKNOWN'],
  EXTERNAL_WAIT: ['WORKING','QUIET_PROGRESS','SUSPECTED_HUNG','RESULT_SUBMITTED','CANCEL_REQUESTED','FAILED','UNKNOWN'],
  SUSPECTED_HUNG: ['WORKING','INTERRUPT_REQUESTED','CANCEL_REQUESTED','FAILED','UNKNOWN'],
  RESULT_SUBMITTED: ['RESULT_ACCEPTED','RESULT_REJECTED','CANCEL_REQUESTED','FAILED','UNKNOWN'],
  RESULT_REJECTED: ['WORKING','CANCEL_REQUESTED','FAILED','UNKNOWN'],
  RESULT_ACCEPTED: ['REVIEWED','CANCEL_REQUESTED','FAILED','UNKNOWN'],
  REVIEWED: ['VERIFIED','FAILED','UNKNOWN'],
  VERIFIED: ['CLOSED','UNKNOWN'],
  INTERRUPT_REQUESTED: ['EXIT_OBSERVED','FAILED','UNKNOWN'],
  CANCEL_REQUESTED: ['INTERRUPT_REQUESTED','EXIT_OBSERVED','FAILED','UNKNOWN'],
  FAILED: ['EXIT_OBSERVED','CLOSED','UNKNOWN'],
  EXIT_OBSERVED: ['CLOSED','UNKNOWN'],
  CLOSED: [], UNKNOWN: []
};
const RESOURCE_EDGES = {
  DECLARED: ['LEASED','UNKNOWN','QUARANTINED'],
  LEASED: ['START_REQUESTED','ACTIVE','RECLAIMING','UNKNOWN','QUARANTINED'],
  START_REQUESTED: ['ACTIVE','RECLAIMING','UNKNOWN','QUARANTINED'],
  ACTIVE: ['QUIESCING','TERMINATE_REQUESTED','EXIT_OBSERVED','RECLAIMING','UNKNOWN','QUARANTINED'],
  QUIESCING: ['ACTIVE','TERMINATE_REQUESTED','EXIT_OBSERVED','UNKNOWN','QUARANTINED'],
  TERMINATE_REQUESTED: ['EXIT_OBSERVED','UNKNOWN','QUARANTINED'],
  EXIT_OBSERVED: ['RECLAIMING','UNKNOWN','QUARANTINED'],
  RECLAIMING: ['RECLAIMED','UNKNOWN','QUARANTINED'],
  RECLAIMED: [], UNKNOWN: [], QUARANTINED: []
};
const RUN_STATES = Object.keys(RUN_EDGES);
const CHILD_STATES = Object.keys(CHILD_EDGES);
const RESOURCE_STATES = Object.keys(RESOURCE_EDGES);
```

Required guards include plan-before-lease, ledger-before-dispatch, terminal-intent-bound `RECLAIMING -> COMPLETE|CANCELLED|FAILED_RECLAIMED`, new packet version for `RESULT_REJECTED -> WORKING`, submitted-before-accepted-before-reviewed-before-verified, and executable resources reaching EXIT_OBSERVED before RECLAIMED. `LEASED|START_REQUESTED -> RECLAIMING` requires proof of no start/side effect; `ACTIVE -> RECLAIMING` is limited to non-executable resources with quiescence and no-handle evidence.

```javascript
for (const from of RUN_STATES) {
  for (const to of RUN_STATES) {
    assert.strictEqual(canTransition('run', from, to), RUN_EDGES[from].includes(to));
  }
}
```

Add RED fixtures for state jump, terminal rollback, wrong terminal intent, rework without a new packet, dispatch without ledger, malformed/duplicate/out-of-order/superseded resource events, reused PID, parent/exe/argv/generation drift, child attempting to kill its host session, root trusting child cleanup self-report, missing port/thread/temp/compute postconditions, and COMPLETE with UNKNOWN/QUARANTINED resource.

- [ ] **Step 2: Run transition RED**

Run: `node test/collaboration-contract.test.js`

Expected: FAIL because transition reducer is absent. Process card: purpose=`state RED`; owner=`root`; cwd=`plugin root`; timeout=`30s`; temp=`run-root/tests`; stop=`exit 1`; delta=`none`; cleanup=`closed`.

- [ ] **Step 3: Implement the canonical ResourceEvent1 reducer**

`ResourceLedger1.schema.json` requires the common artifact fields plus `plan_ref,run_events,child_events,resource_events,resources,content_sha256`. `resources[]` uses the canonical launch-card fields from this plan. Structural validation rejects a snapshot whose `created_by_event`, owner, parent, generation, state or evidence aggregation differs from deterministic reduction of its event stream.

`LifecycleEvent1` for run/child requires exactly `event_id,machine,subject_id,from_state,to_state,sequence,observed_at,actor_role,actor_id,plan_generation,evidence_refs,guard_refs,supersedes_event_id`; first states are `PLANNING` for run and `DECLARED` for child. Reducer groups by machine/subject, requires strict sequence/time/generation, enforces the canonical edge/guard tables, and returns run/child snapshots. Event IDs are unique across lifecycle and resource arrays.

`ResourceEvent1` requires exactly `event_id,resource_id,event_kind,from_state,to_state,sequence,observed_at,actor_role,actor_id,lease_generation,identity_ref,evidence_refs,postconditions,supersedes_event_id`. Event kinds are `DECLARE|LEASE|REQUEST_START|OBSERVE_ACTIVE|REQUEST_QUIESCE|REQUEST_TERMINATE|OBSERVE_EXIT|BEGIN_RECLAIM|VERIFY_RECLAIM|MARK_UNKNOWN|QUARANTINE`. The first event is `null -> DECLARED`, sequence 1; later events require exact previous state, monotonically increasing sequence/time, matching generation/owner/parent and unique IDs. A correction is append-only and must point to a non-sealed same-generation event; no in-place history rewrite.

The reducer derives `created_by_event`, state, last verification and evidence refs. It rejects missing parent leases, unauthorized ownership transfer, event/source hash mismatch, unverified child sublease, and RECLAIMED without type-specific identity-bound postconditions.

- [ ] **Step 4: Implement compound identity and nested responsibility guards**

Identity comparison returns one of `MATCH|PARTIAL|MISMATCH`. Exact destructive action requires MATCH across PID/native handle, start time, `exe_path_hash`, `argv_hash`, `parent_identity_hash`, nonce, native process-manager run ID when available and top-level `lease_generation`. `PARTIAL` allows graceful request/observation only; `MISMATCH` creates UNKNOWN and run HOLD.

Child may manage only its task-local descendants and may never terminate its own host session. Root owns child sessions, outer executors, global temp roots and constrained-compute leases, and independently verifies cleanup. Agent/thread/process/terminal/port/compute reclamation requires liveness/identity/port/lease postconditions; text self-report is only evidence input.

- [ ] **Step 5: Run GREEN and full suite**

Run focused contract/platform tests then `cmd /c npm test`. Expected: all illegal pairs reject, legal traces reduce deterministically, exact identity rules pass. Process card: purpose=`state GREEN`; owner=`root`; cwd=`plugin root`; timeout=`180s`; temp=`run-root/tests`; stop=`attached exits`; delta=`process/temp`; cleanup=`reclaimed`.

- [ ] **Step 6: Review and gate any commit**

Request separate commit approval for `feat: enforce collaboration lifecycle states` only after diff review and tests.

### Task 6: RED/GREEN — implement exact process recovery and temporary leases

**Files:**
- Create: `references/resource-lifecycle.md`
- Modify: `scripts/lib/contracts.js`
- Create: process/temp invalid fixtures
- Modify: `test/collaboration-platform.test.js`

**Interfaces:**
- Consumes: ResourceLedger states and compound identity.
- Produces: process termination decision, temp lease validation, progress report validation and platform applicability receipts.

O-005 is resolved by dependency injection: live quota/watermark values may come only from a named host/workload policy receipt, while tests use explicit synthetic policy fixtures. Missing live policy produces `not_observable/UNVERIFIED` and forbids expansion or destructive cleanup; the implementation contains no universal byte, percentage or timeout threshold.

- [ ] **Step 1: Write process/storage/progress RED tests**

Cover normal exit, graceful timeout, exact owned-tree fallback, PID reuse, parent/command/port/native-run-ID drift, orphan recovery, duplicate-run lock, unknown process, `QUIET_PROGRESS`, `EXTERNAL_WAIT`, multiple-window `SUSPECTED_HUNG`, bounded transient retry, circuit-breaker activation, active handle at TTL, canonical-root escape, symlink/junction/reparse/mount boundary, path rebound, partial manifest, soft/hard quota, low/critical watermark and incomplete progress report.

Progress must include counts, return-code distribution, liveness/identity confidence, newest artifact, CPU/GPU/memory/IO or `not_observable`, temp quota/disk, blockers/waits/retry/circuit breaker, last meaningful progress and next gate. Percentage-only reports reject.

- [ ] **Step 2: Run platform RED**

Run: `node test/collaboration-platform.test.js`

Expected: FAIL on missing lifecycle decisions, not because the current OS lacks the other platform. Process card: purpose=`resource RED`; owner=`root`; cwd=`plugin root`; timeout=`60s`; temp=`run-root/platform-red`; stop=`exit 1`; delta=`no retained child`; cleanup=`exact temp root removed after identity check`.

- [ ] **Step 3: Implement decision-only lifecycle helpers**

Temporary lease validation requires this exact manifest surface before any child write: `owner_id,run_id,session_id,lease_generation,canonical_root_identity,created_at,quota_profile_ref,watermark_policy_ref,child_sublease_map,retention_set,state,manifest_sha256`. Policy refs come from the actual host/workload configuration resolved under O-005/O-006; no universal byte or time threshold is embedded in the Skill. Each child sublease binds owner, canonical descendant, nonce, generation, soft/hard quota and teardown condition.

The helper never kills or deletes. It returns controlled actions:

```javascript
// process decision
{ action: 'REQUEST_GRACEFUL'|'WAIT_BOUNDED'|'TERMINATE_EXACT_TREE'|'OBSERVE_ONLY'|'HOLD', reasons: [] }

// temp decision
{ action: 'ALLOW_WRITE'|'STOP_EXPANSION'|'STOP_DISPATCH'|'OBSERVE_ONLY'|'QUARANTINE'|'RECLAIM_EXACT'|'HOLD', reasons: [] }
```

`TERMINATE_EXACT_TREE` requires full MATCH across the canonical identity fields and graceful attempt evidence. The fixed recovery order is stop new work → graceful request → bounded observation → identity recheck → exact owned-tree termination → process/thread/port absence → downstream lease release. `RECLAIM_EXACT` requires quiescence, owner/generation/root identity, no reparse escape, sealed retention set and pre/post path checks; where the platform supports atomic same-parent rename, first quarantine the exact candidate and revalidate identity before removal. TTL alone always returns `OBSERVE_ONLY|QUARANTINE`, never delete authority.

Progress classification uses workload-policy observation windows rather than universal seconds. Meaningful CPU/IO/artifact/heartbeat deltas produce `QUIET_PROGRESS`; an independently identified external job/wait with next check produces `EXTERNAL_WAIT`; only multiple bounded no-progress windows without such evidence produce `SUSPECTED_HUNG`. Retry requires a transient, no-side-effect classification, idempotency key and bounded attempts/backoff/jitter; repeated failure opens a circuit breaker and stops new adapter/topology dispatch.

- [ ] **Step 4: Add applicable Windows and POSIX observation tests**

Windows tests may create a task-scoped child marker under the run temp root, record PID/start/`exe_path_hash`/argv/`parent_identity_hash`/native run ID, request graceful exit, and verify exact absence; junction/reparse tests stay beneath owned temp. In this Codex Windows environment, an explicitly launched marker that needs an isolated temp root uses `C:\Users\ljp37\.cc-switch\scripts\invoke-codex-sandbox-task.ps1` with a `SandboxRoot` below `C:\Users\ljp37\.codex\tmp`, remains registered with the native process manager, and passes only the returned run ID to `C:\Users\ljp37\.cc-switch\scripts\complete-codex-sandbox-cleanup.ps1` after exit verification. POSIX tests use process group/session and symlink boundary when `process.platform !== 'win32'`. Non-applicable platform cases emit `SKIP_NOT_APPLICABLE:<platform>:<reason>` and are not counted as PASS for that platform.

Process card: purpose=`platform lifecycle integration`; owner=`root owns test runner; child owns marker process`; cwd=`plugin root`; timeout=`120s`; temp=`run-root/platform/<nonce>`; stop=`normal marker exit or bounded graceful/exact verified termination`; delta=`PID/start/tree/temp/disk`; cleanup=`verify marker/process group and exact temp path absent; mismatch -> HOLD, no broad kill`.

- [ ] **Step 5: Run GREEN and full suite**

Run focused platform test then `cmd /c npm test`. Expected: applicable platform PASS, other platform explicit skip, zero task-owned residue. Process card uses the same exact contract; retain only metadata/hashes.

- [ ] **Step 6: Review and gate any commit**

Request separate commit approval for `feat: define exact collaboration resource recovery` if desired; no automatic commit.

### Task 7: RED/GREEN — implement ExecutionReceipt1, authorization and completion gates

**Files:**
- Create: `references/schemas/ExecutionReceipt1.schema.json`
- Create: `references/evidence-and-artifacts.md`
- Modify: `scripts/lib/contracts.js`
- Create: receipt/auth/progress invalid fixtures
- Modify: contract and behavior tests

**Interfaces:**
- Consumes: validated plan/ledger and phase evidence.
- Produces: ExecutionReceipt1 validation, `route_attestation`, authorization and COMPLETE decisions.

- [ ] **Step 1: Write receipt RED tests**

Reject: child self-report as acceptance; missing root review/verification; candidate/config/profile copied into actual; exact-lane-required with UNVERIFIED route; unresolved contradiction; unknown/quarantined resource; cleanup requested but not verified; tampered/missing/wrong-hash/cross-session plan or ledger refs; expired/wrong-actor/wrong-action/wrong-resource/wrong-plan authorization; commit inferred from local edit; external action inferred from commit.

Allow: task COMPLETE with `actual_model="unknown"`, `actual_effort="unknown"`, `route_attestation="UNVERIFIED"` only when exact lane is not a phase acceptance requirement and all result/review/verification/cleanup gates pass.

- [ ] **Step 2: Run receipt RED**

Run focused contract test. Expected: FAIL on missing receipt validator. Process card: purpose=`receipt RED`; owner=`root`; cwd=`plugin root`; timeout=`30s`; temp=`run-root/tests`; stop=`exit 1`; cleanup=`closed`.

- [ ] **Step 3: Implement receipt schema and semantic completion gate**

Authorization records use the exact `Authorization1` interface: `authorization_id,actor_id,actor_kind,scope,action,resource_ids,issued_at,expires_at,plan_ref,source_evidence_ref`. Validation requires the expected actor/scope/action/resource set, unexpired time, exact current plan `{artifact_id,content_sha256}`, and a source evidence class allowed by policy. A child/agent message can never be the authorizing actor or widen scope. Local edit, staging, commit, push, merge, publish, deploy, paid job, credential/config change and constrained compute are distinct actions with no implied edge.

Use exact controlled values:

```javascript
const RUN_OUTCOMES = ['COMPLETE','PARTIAL','FAILED','CANCELLED','HOLD','UNVERIFIED'];
const ROUTE_ATTESTATIONS = ['VERIFIED','UNVERIFIED','NOT_REQUIRED'];
const CLEANUP = ['all_reclaimed','quarantined','unknown'];
```

Before evaluating COMPLETE, run full artifact-set integrity in the fixed order from Task 4 and require valid plan/ledger refs. COMPLETE requires all required phases accepted/reviewed/verified and all resources RECLAIMED or explicitly retained artifact under an approved non-temp retention policy. Any UNKNOWN/QUARANTINED, active worktree/temp/process lease, verifier disagreement, dangling reference or unresolved contradiction forces HOLD. Completion never implies commit/integration/release.

- [ ] **Step 4: Run GREEN and full suite**

Run contract/behavior tests then `cmd /c npm test`. Expected: route attestation matrix, authorization boundaries and cleanup gates all PASS. Process card: purpose=`receipt GREEN`; owner=`root`; cwd=`plugin root`; timeout=`180s`; temp=`run-root/tests`; stop=`attached exits`; delta=`process/temp`; cleanup=`reclaimed`.

- [ ] **Step 5: Review and gate any commit**

Request separate authorization for `feat: add collaboration execution receipts` if desired.

### Task 8: GREEN/REFACTOR — write and pressure-test the Skill and references

**Files:**
- Create: `skills/dw-collaboration/SKILL.md`
- Create: `references/state-machines.md`
- Create: `references/runtime-adapters.md`
- Complete: `references/evidence-and-artifacts.md`, `references/resource-lifecycle.md`
- Modify: pressure observations and behavior test only with newly observed evidence

**Interfaces:**
- Consumes: actual RED observations and now-green executable contracts.
- Produces: concise discoverable Skill plus progressive-disclosure references that cause safe decisions under pressure.

- [ ] **Step 1: Write the minimal SKILL.md from observed failures**

Frontmatter must be exactly trigger-only in shape:

```yaml
---
name: dw-collaboration
description: Use when 任务需要子代理、多智能体协作、并行分派、阶段沟通、共享证据，或需要管理 agent、进程、终端、端口与临时空间的完整生命周期时。
---
```

Body order: overview/core principle; when to use/not use; capability proof; four-topology decision; task packet recipe; root/child ownership; resource/cleanup protocol; completion gate; quick reference; common rationalizations/red flags; one runtime-neutral example; required reference links. Use prohibitions for demonstrated discipline violations and positive structural recipes for omitted output fields.

- [ ] **Step 2: Write references with exact controlled vocabulary**

References must reproduce all enums and state edges from schemas, include the dynamic lane descriptor, five semantic capability classes, six-axis route floors, adaptive effort/downshift rules and `selectRoute` examples, topology downgrade transitions, process identity and graceful→exact sequence, temp lease/quota/watermark/TTL/reparse rules, progress fields, authorization implications that are invalid, and host evidence limits. Cross-links remain relative and inside the plugin.

- [ ] **Step 3: Run five fresh-context micro-tests with the Skill**

Revalidate or minimally re-probe the pressure-executor receipt if it expired or the adapter/session/auth fingerprint changed. Repeat the exact 14 arms × five fresh repetitions from Task 2, with `max_samples=70` and `max_active_children=1`. Each sample gets only the candidate Skill/relevant reference plus the synthetic task packet; compare against no-guidance control. Manually read every flagged excerpt; score variance as well as compliance.

Agent card: purpose=`GREEN skill pressure sample <scenario-id>/<arm-id>/<rep>`; owner=`root`; cwd=`isolated worktree`; timeout=`5m`; temp=`run-root/green/<scenario-id>/<arm-id>/<rep>/<nonce>/g<generation>`; stop=`collect/failure/timeout`; delta=`one child at a time, exact session/output`; cleanup=`close and verify child plus any descendants/temp before the next sample`; no descendant agents. Batch quota/watermark/circuit-breaker behavior is identical to RED; an incomplete batch remains PARTIAL/UNVERIFIED.

Expected: all demonstrated baseline failures are corrected; outputs converge on controlled topology/action vocabulary. New rationalization triggers REFACTOR, not threshold weakening.

- [ ] **Step 4: REFACTOR only after GREEN**

Remove duplication, move heavy tables to references, tighten wording for observed loopholes, update rationalization table and red flags, and keep `SKILL.md` concise. Do not add speculative rules not supported by spec or test evidence.

- [ ] **Step 5: Re-run behavior, contract and full tests**

Run behavior + contract + platform + `cmd /c npm test`. Expected: all green, no warning/error, task-owned resources reclaimed. Process card: purpose=`Skill refactor verification`; owner=`root`; cwd=`plugin root`; timeout=`240s`; temp=`run-root/tests`; stop=`attached exits`; delta=`process/temp/disk`; cleanup=`reclaimed`.

- [ ] **Step 6: Review and gate any commit**

Request explicit authorization for `feat: add capability-first collaboration skill` only after showing RED evidence and GREEN/REFACTOR results.

### Task 9: Integrate routing, hub, domain/rule guidance and publication metadata

**Files:**
- Modify: `skills/dw-tooling/SKILL.md:1-178`
- Modify: `skills/development-workflow/SKILL.md:8-31`
- Modify: `skills/dw-domains/domains.json` agent domain entry
- Modify: `rules/ai-agent-dev.md`
- Modify: `rules/development-workflow.md:1-52`
- Modify: `test/hooks.test.js:201-395,639-686`
- Modify: `package.json:1-38`
- Modify: `.claude-plugin/plugin.json:1-16`
- Modify: repository `.claude-plugin/marketplace.json` development-workflow entry only
- Modify: `README.md:5-10` and Skill summary
- Modify: `AGENTS.md:13-19`

**Interfaces:**
- Consumes: verified canonical Skill and validator.
- Produces: one discovery path, 12-Skill/5.1.0 consistent package surface and no hook expansion.

- [ ] **Step 1: Write integration RED assertions before editing guidance/manifests**

Update `hooks.test.js` to require: exactly 12 discovered SKILL.md files; `package.files` includes `skills/dw-collaboration/` and `test/`; hub links it; dw-tooling routes complex collaboration to it; agent domain/rules refer to the canonical path; two hooks only; no `subagent-context.js`; descriptions and README say 12 (1+11); all version surfaces equal 5.1.0; AGENTS says only `SessionStart` and `UserPromptSubmit` and no longer names `PreToolUse/PostToolUse`; every new test/fixture path exists, is not ignored, and belongs to the explicit Plan B file allowlist. Do not require `git ls-files` or index state before a separately authorized staging/commit gate.

- [ ] **Step 2: Run integration RED**

Run: `node test/hooks.test.js`

Expected: FAIL on 11 vs 12 and missing package entry/link; not syntax error. Process card: purpose=`integration RED`; owner=`root`; cwd=`plugin root`; timeout=`120s`; temp=`runner temp`; stop=`exit 1`; delta=`process/temp`; cleanup=`reclaimed`.

- [ ] **Step 3: Make minimal router/hub/domain/rule edits**

`dw-tooling` keeps discovery and routes when the task requires child delegation, interactive messaging, resource ledger, lifecycle recovery or multi-agent evidence. It must not duplicate the full protocol. Hub adds one collaboration row. Agent domain/rules state capability-first and exact cleanup invariants, with relative link to `../skills/dw-collaboration/SKILL.md` only where link resolution rules support it.

- [ ] **Step 4: Complete the already-5.1.0 release surfaces with truthful 12-Skill metadata**

Confirm the Task 1 version preimage remains 5.1.0 on package/plugin/marketplace/README; do not rewrite or touch gpt-bridge fields. Set development-workflow descriptions to `共12个 Skill（1个总纲 + 11个子 Skill）`; README and AGENTS counts likewise. Change AGENTS hook inventory to exactly `SessionStart, UserPromptSubmit`. Add `skills/dw-collaboration/` to `package.files` and retain `test/`. Set the package test/validate command to this exact order so contract failures stop before broad hook tests:

```json
{
  "test": "node test/runtime-v5.test.js && node test/collaboration-contract.test.js && node test/collaboration-behavior.test.js && node test/collaboration-platform.test.js && node test/hooks.test.js",
  "validate": "node test/runtime-v5.test.js && node test/collaboration-contract.test.js && node test/collaboration-behavior.test.js && node test/collaboration-platform.test.js && node test/hooks.test.js"
}
```

Do not put live `host-e2e.js` in default `npm test`; it validates explicit runtime evidence in Task 10 and unavailable hosts must remain UNVERIFIED. Do not alter gpt-bridge entries.

- [ ] **Step 5: Run GREEN and inspect exact file scope**

Run hooks test then `cmd /c npm test`, `git diff --check`, `git diff --name-status $baselineSha`, and `git status --porcelain=v2 --untracked-files=all`. Compare the combined tracked/untracked path set with the exact Plan B allowlist; `git diff` alone is insufficient because it omits untracked files. Expected: all tests PASS, two hooks, 12 skills, no ignored or unclassified path, no gpt-bridge/hook expansion/deleted hook restoration/dmux duplicate. New files may remain untracked until a separately authorized staging gate; this is truthful working-tree-candidate state, not release readiness. Process card: purpose=`integration GREEN`; owner=`root`; cwd=`$worktreeRoot/plugins/development-workflow`; timeout=`240s`; temp=`$runRoot/tests`; stop=`attached exits`; delta=`process/temp`; cleanup=`reclaimed`.

- [ ] **Step 6: Review and gate any commit**

Request separate authorization for `release: prepare development-workflow 5.1.0 collaboration surface`; never push/tag/publish.

### Task 10: Validate package-copy behavior and host capability evidence

**Files:**
- Create: `test/host-e2e.js`
- Modify: `package.json` test script only if host-e2e is kept opt-in
- Write outside repository: `$runRoot/host-evidence/**`, `$runRoot/pack/**`

**Interfaces:**
- Consumes: complete 5.1.0 candidate.
- Produces: pack inventory/copy PASS and per-host capability receipts labelled VERIFIED or UNVERIFIED from actual execution only.

- [ ] **Step 1: Run pack dry-run JSON and assert the 5.1.0 surface**

Run:

```powershell
cmd /c npm pack --dry-run --json
```

Expected: `development-workflow@5.1.0`; exactly 12 `SKILL.md`; four schema JSON files, validator/libs, references, fixtures and test runners included; no `.tmp`, evidence receipts, private paths, credentials, gpt-bridge or duplicate dmux Skill.

Process card: purpose=`5.1 pack dry-run`; owner=`root`; cwd=`plugin root`; timeout=`120s`; temp=`run-root/pack`; stop=`attached exit`; delta=`session/temp/disk`; cleanup=`JSON retained, no tarball in cwd`.

- [ ] **Step 2: Build, create a verified extraction root, extract and test one actual tarball**

Create the exact tarball directory and run `npm pack --json --pack-destination $runRoot/pack/tarball`. Before extraction, resolve the canonical pack parent, require `$runRoot/pack/extracted` to be absent, create that exact directory, record owner/generation identity, and reject reparse/symlink/junction/mount boundaries. Extract only the single JSON-returned tarball to that verified directory, set `DW_PACKAGE_TEST=1`, and execute `cmd /c npm test` from `extracted/package`.

Expected: all contract/behavior/applicable platform/existing tests PASS without repository-only files. After sealing hash/inventory/test evidence, canonicalize and re-check the exact pack lease, verify no bound process/handle, then remove only that generation and confirm absence.

Process card: purpose=`5.1 packed-copy tests`; owner=`root`; cwd=`extracted/package`; timeout=`300s`; temp=`run-root/pack`; stop=`test exit`; delta=`tar/extracted/test processes/temp/disk`; cleanup=`all test PIDs/sessions gone, exact pack root RECLAIMED or HOLD`.

- [ ] **Step 3: Discover host adapters without equating installation to capability**

For each of `claude-code`, `codex`, `grok-build`, record `DECLARED` only from current runtime inventory/config. Do not install tools, authenticate, send business prompts, or call network services merely to improve coverage. If the host is absent, disabled, permission-blocked or lacks an approved zero-side-effect probe, emit:

```json
{"host":"<id>","status":"UNVERIFIED","reason":"not_available_or_not_authorized","capabilities":[]}
```

Process card: purpose=`host discovery`; owner=`root`; cwd=`worktree`; timeout=`60s per host`; temp=`run-root/host-evidence`; stop=`discovery exits`; delta=`no persistent process`; cleanup=`sessions closed`.

- [ ] **Step 4: Resolve O-003, O-004 and O-006 before live host evidence**

Set O-003 to the subset of Claude Code, Codex and Grok Build that is actually present, enabled and authorized for a zero-side-effect probe; absent hosts remain explicit UNVERIFIED. For each probed adapter, derive O-004 expiry from session/auth/adapter-generation boundaries and documented drift/probe cost, recording a per-host policy ref rather than a universal TTL. Resolve O-006 to either an approved non-temp metadata-only artifact root with owner/review/expiry or `no_persistent_retention` after final receipt; raw prompts, credentials and private absolute paths are never retained. If any source is ambiguous, ask the user before persisting or probing that host.

Expected: a sealed policy receipt names host scope, per-host evidence expiry and final retention action before the first live host child is dispatched.

- [ ] **Step 5: Probe only actually available and authorized hosts**

Use nonce-bound spawn/collect, root→child ack, child→root independent message, liveness and cleanup probes from spec §7. Each child receives no source write permission and returns protocol version/nonces only. Request success is `request_only/OBSERVED`; matching ack/collect is `supported/PROBED`; actual model/effort remains unknown unless host metadata supplies it.

Agent/process card: purpose=`<host> zero-side-effect capability probe`; owner=`root owns host session`; cwd=`worktree`; timeout=`5m per host`; temp=`run-root/host-evidence/<host>/<nonce>/g<generation>`; stop=`collect/timeout/error`; delta=`child session/process/temp/compute`; cleanup=`graceful close then exact host-supported cleanup, verify exit; unknown -> HOLD`; descendants forbidden.

Expected: each host receipt is one of VERIFIED/UNVERIFIED with evidence refs; no fixture/mock is counted as live success; communication failure does not alter selected effort.

- [ ] **Step 6: Run `host-e2e.js` as a receipt validator**

`host-e2e.js` validates supplied receipts and prints counts by VERIFIED/UNVERIFIED/FAILED; it does not spawn vendor CLIs itself. Run:

```powershell
node test/host-e2e.js --evidence-root "$runRoot\host-evidence"
```

Expected: exit 0 when every available host probe receipt validates and unavailable hosts are explicit UNVERIFIED; exit 2 for malformed/forged claims. Process card: purpose=`host receipt verification`; owner=`root`; cwd=`plugin root`; timeout=`60s`; temp=`host-evidence`; stop=`exit`; delta=`none`; cleanup=`session closed, evidence retained until final audit`.

### Task 11: Independent review, security audit and final resource reclamation

**Files:**
- Read: full diff from exact 5.0.0 SHA
- Write outside tracked tree: final review/resource receipts

**Interfaces:**
- Consumes: all green tests, package and host evidence.
- Produces: no-P0/P1 independent review, residual risk report, all-resources terminal receipt.

- [ ] **Step 1: Dispatch one bounded correctness reviewer and one security reviewer serially**

Each task packet includes exact diff hash, spec hash, owned paths=`none`, forbidden writes/descendants/network/Git changes, output schema, 20-minute timeout. Run serially to avoid resource and evidence races.

Agent card: purpose=`5.1 correctness review` then `5.1 security review`; owner=`root`; cwd=`worktree`; timeout=`20m each`; temp=`none`; stop=`collect/failure/timeout`; delta=`one child session at a time`; cleanup=`close and verify each before next; no descendants`.

Correctness focus: schemas/interfaces/type fields, topology matrix, state/property coverage, package-copy, docs consistency. Security focus: prompt injection boundaries, path traversal/reparse/TOCTOU, PID reuse, secret redaction, authorization, DoS/concurrency/quota and unsafe process cleanup.

- [ ] **Step 2: Root resolves review findings through new RED tests**

Every behavioral defect gets a focused failing regression before code/doc correction, then focused GREEN and full suite. P0/P1 must be zero; unresolved P2/P3 and host/platform UNVERIFIED items go to residual risks without being called PASS.

Process card for every regression command: purpose=`review regression <finding-id>`; owner=`root`; cwd=`plugin root`; timeout=`180s`; temp=`run-root/tests`; stop=`RED then GREEN attached exits`; delta=`process/temp`; cleanup=`reclaimed`.

- [ ] **Step 3: Run final verification matrix**

Run:

```powershell
node test/collaboration-contract.test.js
node test/collaboration-behavior.test.js
node test/collaboration-platform.test.js
cmd /c npm test
cmd /c npm pack --dry-run --json
git diff --check "$baselineSha"
git status --porcelain=v2 --untracked-files=all
```

Expected: focused/full tests PASS, pack inventory correct, no whitespace errors, and the combined tracked/untracked status contains only the exact planned 5.1.0 paths. New files may truthfully remain untracked before staging authorization; each must be unignored, present in package inventory and present in the proposed staged allowlist. Process card: purpose=`5.1 final matrix`; owner=`root`; cwd=`worktree/plugin or worktree root as named`; timeout=`10m total with per-command bounds`; temp=`run-root/final`; stop=`all attached commands exit`; delta=`process/temp/disk/artifacts`; cleanup=`all disposable test resources reclaimed`.

- [ ] **Step 4: Audit disposable resources before any Git gate**

Require every child state to be `CLOSED`; require every process/thread/terminal/command/port/temp/compute resource to be `RECLAIMED`; permit only sealed `artifact` entries under an approved non-temp retention policy. Verify command sessions exited, agents closed, no task-owned PID/thread/port/compute lease, and all disposable test/pack/sample temp roots are absent. At this checkpoint only two named outer leases may remain active: the isolated worktree handoff lease and `$runRoot` final-evidence lease, each with owner, byte size, disk capacity, review date and teardown condition. Any other ACTIVE, any UNKNOWN/QUARANTINED or missing postcondition forces HOLD and prevents Git preparation.

- [ ] **Step 5: Present a staging-specific gate**

Show exact diff, validation counts, pack-copy result, live host VERIFIED/UNVERIFIED matrix, reviews, residual risks, resource receipt and the exact tracked/untracked path allowlist. Ask whether to stage only those 5.1.0 paths. Plan approval and test success are not staging authorization.

If approved, stage only the explicit path/hunk allowlist; never use `git add .`, a wildcard or an unreviewed status-derived list. Verify `git diff --cached --check`, cached name-status, binary diff hash and `git write-tree`. Expected: every new Skill/schema/script/reference/test/planning artifact is now in the index, no gpt-bridge or unplanned path is present, and the working tree contains no omitted implementation file.

- [ ] **Step 6: Present a separate local commit gate**

After the staged tree SHA is shown, ask separately whether to create exactly one local 5.1.0 implementation commit. If approved, commit with the approved message and recheck parent SHA, commit/tree SHA, empty index, worktree status and exact committed allowlist. If commit is not authorized, do not remove the worktree or call the run COMPLETE; report `PARTIAL_RETAINED_WORKTREE` with the active workspace lease.

Process card: purpose=`optional authorized 5.1 local commit`; owner=`root`; cwd=`worktree`; timeout=`180s`; temp=`none`; stop=`commit/hook exit`; delta=`Git/possible hook children`; cleanup=`verify hook children and session closed`.

- [ ] **Step 7: Close the system-temp evidence lease**

Resolve O-006 before persisted E2E evidence is sealed. Build a minimal retained set containing final receipt, baseline handoff, test/pack/review/host summaries and content hashes. If policy requires retention, transfer that set to the approved non-temp artifact root with explicit owner, size, expiry/review date and privacy policy; if policy permits no retention, preserve only the approved human-readable/hash receipt. Then verify every `$runRoot`-bound process/handle is absent, re-resolve owner/generation/root identity, reject reparse drift, reclaim the exact `$runRoot` generation and verify path absence plus disk delta.

Expected: Plan A freeze root and Plan B run root are both absent from system temp. Only policy-approved non-temp evidence remains. Unknown identity, active handle or failed transfer is `QUARANTINED/HOLD`, never a broader delete retry.

- [ ] **Step 8: Present a worktree teardown gate after a clean local commit**

If and only if the authorized commit exists, the worktree is clean, all evidence is sealed outside system temp and the branch/commit can reproduce the result, present the exact registered worktree path, branch, commit SHA and removal command for separate user approval. On approval, use the native worktree teardown capability; only if none exists use `git worktree remove "$worktreeRoot"`, after canonical path/registration/reparse checks. Verify the path and registration are gone while branch/commit remain.

Without teardown approval, retain the clean worktree under an explicit handoff lease and report `PARTIAL_RETAINED_WORKTREE`; do not claim all resources reclaimed or mark the goal complete. Never force-remove an uncommitted, dirty, unregistered or identity-drifted worktree.

---

## Spec-to-Task Coverage Matrix

| Spec requirement | Implemented/tested by |
|---|---|
| capability evidence levels, freshness, contradiction | Tasks 3, 10 |
| own content hash, unique IDs and cross-artifact reference integrity | Tasks 3, 4, 7 |
| request_only vs actual metadata | Tasks 3, 7, 10 |
| four topology values and downgrade | Task 4 |
| complete task packet, DAG and ownership | Task 4 |
| executable adaptive route selection, effort floors/downshift and route/topology orthogonality | Tasks 4, 8 |
| complete run/child/resource adjacency and ResourceEvent1 reduction | Task 5 |
| root/child nested resource responsibility | Tasks 5, 6, 8 |
| PID/start/exe/argv/parent/nonce/generation | Tasks 5, 6 |
| graceful then exact termination; unknown HOLD | Task 6 |
| canonical temp root, quota/watermark, TTL, reparse | Task 6 |
| long-run counts/return codes/liveness/artifact/disk | Task 6 |
| authorization boundaries | Tasks 7, 8 |
| ExecutionReceipt route_attestation | Task 7 |
| Claude/Codex/Grok actual capability limits | Tasks 8, 10 |
| package-copy, 12 Skills and 5.1.0 surfaces | Tasks 9, 10 |
| Windows/POSIX applicability | Tasks 6, 10 |
| no hook expansion/subagent-context/gpt-bridge/dmux scope | Tasks 9, 11 |
| independent correctness/security review and cleanup | Task 11 |
| Plan A/Plan B system-temp evidence and isolated-worktree teardown | Tasks 1, 11 |

## Plan B Acceptance Checklist

- [ ] Worktree started from Plan A's exact verified 5.0.0 SHA and uses `codex/dw-collaboration-5.1.0`.
- [ ] Worktree path was explicitly approved, canonical, outside the dirty repository when no native worktree tool was available, and no post-baseline `.gitignore` commit was inserted.
- [ ] The approved design and both plans were imported as the first 5.1.0 files and match Plan A's three planning-input hashes.
- [ ] RED pressure observations predate production Skill content and show correct baseline failures.
- [ ] Four Draft 2020-12 schemas plus executable zero-dependency validator are published.
- [ ] `selectRoute` and `validateRouteDecision` adapt model class/effort to the six axes, availability evidence and policy floors without hard-coded vendor catalogs.
- [ ] Own hashes, duplicate IDs, dangling/wrong-hash/cross-session references and complete ResourceEvent/state edges have negative tests.
- [ ] All required topology, evidence, task packet, state, identity, cleanup, temp, progress, authorization and receipt invariants have positive and negative tests.
- [ ] Skill and references pass pressure scenarios and loophole refactors.
- [ ] `dw-tooling` remains discovery/router; hub/domain/rules point to one canonical Skill.
- [ ] 12-Skill/5.1.0/package-files/README/marketplace/plugin/AGENTS surfaces agree.
- [ ] Existing two hooks remain exactly two; deleted `subagent-context.js` stays deleted.
- [ ] No gpt-bridge or duplicate dmux Skill change exists.
- [ ] Repository tests, applicable platform tests, pack dry-run and actual packed-copy tests pass.
- [ ] Each unavailable host/platform is explicit UNVERIFIED, never mock PASS.
- [ ] Independent correctness/security reviews have no unresolved P0/P1.
- [ ] All task-owned agents/processes/threads/terminals/ports/temp/compute resources are verified terminal; both Plan A and Plan B system-temp roots are absent, and retained artifacts live only under the approved non-temp retention policy.
- [ ] Staging and commit were separately authorized. Overall COMPLETE additionally requires a reproducible local 5.1.0 commit and approved worktree teardown; otherwise status is `PARTIAL_RETAINED_WORKTREE` with an explicit lease.
- [ ] No push/tag/merge/publish/deploy occurred.

## Execution Handoff

After Plan A completes, execute this plan task-by-task in the approved isolated worktree. Subagent-driven execution is recommended only when root can prove spawn/collect and can close each bounded child; otherwise use inline `superpowers:executing-plans` or serial fallback. At every task boundary, root reviews the diff, tests and resource receipt before starting the next task. Plan approval authorizes scoped implementation only; it does not authorize worktree creation, staging, commit, push, tag, merge or publication unless the user explicitly names that action.
