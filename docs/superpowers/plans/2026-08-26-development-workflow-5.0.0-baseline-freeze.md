# Development Workflow 5.0.0 Baseline Freeze Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将当前未提交的 `development-workflow` 5.0.0 candidate 收敛为经过验证、可由 exact commit SHA 重现且不混入其他用户改动的基线，供 5.1.0 隔离实现使用。

**Architecture:** 先以只读方式冻结 preimage、候选 allowlist、工作树 diff/hash 和资源状态，再在附着且有界的命令会话中完成 repository tests、pack dry-run、真实 pack-copy 自测和独立 diff review。只有用户分别批准 staging 和 commit 后才改变 Git index/branch；最终以 commit SHA、tree SHA、空 staged diff 和保留的证据租约组成 handoff。

**Tech Stack:** Git、PowerShell 7/Windows PowerShell、Node.js CommonJS、`node:test` 风格的仓库自定义 runner、npm package lifecycle、SHA-256。

**Spec:** `docs/specs/2026-08-26-dw-collaboration-design.md`

## Global Constraints

- 本计划只冻结 5.0.0；不得实现 `dw-collaboration`、修改为 5.1.0、创建 5.1.0 branch/worktree、恢复 `subagent-context.js`、扩展 hooks 或修改 `gpt-bridge`。
- 当前权威 parent 是 `c51195449c418294be7812641e28e46411231544`；执行时若 `git rev-parse HEAD` 不等于该值，停止并重新审阅计划。
- 目标版本保持 `5.0.0`，目标 Skill 数保持 11（1 个总纲 + 10 个子 Skill），目标 hook 数保持 2。
- `.skillopt-sleep/**`、`docs/specs/2026-08-26-dw-collaboration-design.md`、`docs/superpowers/plans/**` 和 `plugins/gpt-bridge/**` 不属于 5.0.0 staged candidate。
- 用户批准后，设计与两份 source plan 全程只读；不得把 `- [ ]` 改为 `- [x]`。执行状态写入 `$freezeRoot/lease.json` 的外部 step ledger，避免 Plan A 对自身做 hash 后立即因勾选而漂移。
- `.claude-plugin/marketplace.json` 与 `README.md` 是混合所有权文件；index 中只能加入 development-workflow 相关 hunk，保留工作树中的 gpt-bridge 2.0.0 hunk为未暂存用户改动。
- planning ≠ implementation；local edit ≠ staging；staging ≠ commit；commit ≠ push/tag/merge/publish。每个 Git 状态变化均需单独、scope-matched 的人类授权。
- 任何测试、npm、Git pack、PowerShell、Node 或 reviewer agent 启动前必须登记 purpose、owner、cwd、timeout、临时根、停止条件和 launch identity；结束后验证命令会话、精确 owned descendants、端口和临时差分。
- 禁止按进程名或通配符终止进程。只有 PID/handle、start time、executable、argv/parent、launch nonce/generation 全部匹配，才允许 graceful 后的 exact tree termination；身份不明进入 `HOLD`。
- 现存约 269 个历史 `dw-hooks-*` / `dw-v5-*` 路径只读盘点大小、时间和可见句柄；没有本次 ownership/generation 证明时不得删除。
- 受限环境中的 `Get-CimInstance Win32_Process` 权限失败只记 `UNVERIFIED_ENVIRONMENT_PERMISSION`，不得记为代码失败或 PASS；非沙箱复验需要独立批准。
- 不执行 `git push`、`git tag`、`npm publish`、PR、merge、部署、凭据修改、付费调用或 GPU 作业。

---

## File and Evidence Map

### Candidate include allowlist

以下路径构成 5.0.0 candidate；执行 Task 2 时必须逐项与工作树核对：

```text
.claude-plugin/marketplace.json                         # 仅 development-workflow hunk
README.md                                               # 仅 development-workflow hunk
plugins/development-workflow/.claude-plugin/plugin.json
plugins/development-workflow/hooks/embedding-utils.js   # 删除
plugins/development-workflow/hooks/hooks.json
plugins/development-workflow/hooks/post-code-check.js   # 删除
plugins/development-workflow/hooks/prune-rules.js       # 删除
plugins/development-workflow/hooks/session-start.js
plugins/development-workflow/hooks/skill-router.js
plugins/development-workflow/hooks/subagent-context.js  # 删除
plugins/development-workflow/hooks/task-utils.js
plugins/development-workflow/hooks/tool-inventory.js
plugins/development-workflow/hooks/tool-routing.js      # 删除
plugins/development-workflow/hooks/workflow-state.js    # 删除
plugins/development-workflow/hooks/rules-migrate.js     # 新增
plugins/development-workflow/hooks/session-rules.js     # 新增
plugins/development-workflow/package.json
plugins/development-workflow/rules/rules-lazy-load.md   # 删除
plugins/development-workflow/rules/rules-selection.md   # 新增
plugins/development-workflow/test/hooks.test.js
plugins/development-workflow/test/runtime-v5.test.js    # 新增
```

### Explicit exclusions

```text
.skillopt-sleep/**
docs/specs/2026-08-26-dw-collaboration-design.md
docs/superpowers/plans/**
plugins/gpt-bridge/.claude-plugin/plugin.json
.claude-plugin/marketplace.json                         # gpt-bridge hunk only
README.md                                               # gpt-bridge hunk only
```

### Evidence lease

Execution creates one retained, task-owned evidence lease outside the candidate index:

```text
$freezeRoot/
├── lease.json
├── preimage/
│   ├── status-v2.txt
│   ├── diff-binary.patch
│   ├── diff-stat.txt
│   ├── untracked-files.txt
│   ├── candidate-files.sha256
│   ├── planning-inputs.sha256
│   └── historical-temp-inventory.json
├── validation/
│   ├── npm-test.json
│   ├── pack-dry-run.json
│   ├── npm-pack.json
│   ├── packed-copy-test.json
│   └── resource-deltas.json
├── review/
│   └── independent-review.json
├── staging/
│   ├── shared-dw-only.patch
│   ├── cached-name-status.txt
│   └── cached.diff
└── handoff/
    └── baseline-receipt.json
```

执行变量在 Task 1 Step 2 一次性绑定：`$repoRoot` 来自 `git rev-parse --show-toplevel`；`$freezeRunId` 是 `freeze-` 加 32 位随机小写十六进制；`$freezeRoot` 是解析后的 `$env:TEMP/dw-release-freeze/development-workflow-5.0.0/$freezeRunId`。后文变量只能引用这些已验证值。

`lease.json` 的 `retention="keep_until_5.1.0_handoff_verified"` 表示证据租约不在本计划末尾删除；它仍计入磁盘占用并必须在 receipt 中报告 size/hash。TTL 只触发人工复查，不产生删除权限。

---

### Task 1: Open a bounded freeze run and prove the preconditions

**Files:**
- Read: `AGENTS.md:13-30`
- Read: `docs/specs/2026-08-26-dw-collaboration-design.md:617-end`
- Create outside repository: `$freezeRoot/lease.json`

**Interfaces:**
- Consumes: user approval of Scheme B and O-001 V1; parent SHA `c51195449c418294be7812641e28e46411231544`.
- Produces: `FreezeLease1 { run_id, owner, repo_root, parent_sha, generation, purpose, created_at, timeout_at, temp_root, retention, cleanup_policy, state }` with `state="ACTIVE"`.

- [ ] **Step 1: Announce the freeze-only boundary and inspect Git identity**

Run:

```powershell
git rev-parse --show-toplevel
git rev-parse HEAD
git branch --show-current
git diff --cached --quiet
```

Expected: repository root is the approved checkout, HEAD is `c51195449c418294be7812641e28e46411231544`, branch is `master`, and `git diff --cached --quiet` returns 0. A different HEAD, non-empty index, in-progress merge/rebase, or missing repository root is `HOLD`.

Process contract: purpose=`freeze preflight`; owner=`root`; cwd=`repo root`; timeout=`30s`; temp root=`none`; stop=`all four commands returned`; before/after=`record attached command-session ID and confirm it is closed`; cleanup=`no child or temp allocation expected`.

- [ ] **Step 2: Allocate a unique evidence root with an atomic lease manifest**

Bind the three execution variables defined above and create only the resolved descendant of the canonical system temp parent. Write this exact shape through the runtime's structured edit mechanism; timestamp and identity values come from the named command/runtime observations:

```json
{
  "schema": "FreezeLease1",
  "run_id": "$freezeRunId",
  "owner": "root",
  "repo_root": "$repoRoot",
  "parent_sha": "c51195449c418294be7812641e28e46411231544",
  "generation": 1,
  "purpose": "development-workflow-5.0.0-baseline-freeze",
  "created_at": "$createdAtUtc",
  "timeout_at": "$timeoutAtUtc",
  "temp_root": "$freezeRoot",
  "retention": "keep_until_5.1.0_handoff_verified",
  "cleanup_policy": "verify_identity_then_remove_only_nonretained_owned_paths",
  "state": "ACTIVE"
}
```

Expected: resolved lease root stays below the resolved `$env:TEMP/dw-release-freeze/development-workflow-5.0.0` parent defined in the File and Evidence Map, is not a symlink/junction/reparse point, and did not exist before this run.

- [ ] **Step 3: Record a resource ledger row before any test or reviewer dispatch**

Add to `lease.json` an append-only `resources` array. Every later launch receives one row with this shape before launch:

```json
{
  "resource_id": "cmd-<nonce>",
  "type": "command_session",
  "owner": "root",
  "purpose": "<exact-purpose>",
  "cwd": "<resolved-cwd>",
  "timeout_seconds": 120,
  "temp_root": "<resolved-lease-subdirectory-or-none>",
  "launch_identity": {"pid": "unknown-before-launch", "nonce": "<nonce>", "generation": 1},
  "stop_condition": "process-exit-or-timeout",
  "state": "DECLARED",
  "before_snapshot_ref": "<evidence-ref>",
  "after_snapshot_ref": null,
  "cleanup_verification": null
}
```

Expected: the ledger exists before the first `npm`, test, pack, or reviewer action. Missing ledger is `HOLD`, not a reason to continue informally.

### Task 2: Seal the dirty preimage and candidate ownership map

**Files:**
- Read: every path returned by `git status --short`
- Write outside repository: `$freezeRoot/preimage/*`

**Interfaces:**
- Consumes: active `FreezeLease1` and the include/exclusion lists above.
- Produces: `PreimageEvidence1` references for binary diff hash, status hash, candidate file hashes, exclusions, and historical temp inventory.

- [ ] **Step 1: Capture exact status, diff, untracked names, and diff statistics**

Run the following as separate attached commands and save stdout bytes under `preimage/` without normalizing line endings:

```powershell
git status --porcelain=v2 --untracked-files=all
git diff --binary --full-index HEAD
git diff --stat HEAD
git ls-files --others --exclude-standard
```

Expected: every changed path is classified as candidate include, explicit exclusion, or `HOLD_UNCLASSIFIED`; `HOLD_UNCLASSIFIED` must be empty before tests.

Process contract: purpose=`preimage capture`; owner=`root`; cwd=`repo root`; timeout=`60s each`; temp root=`lease/preimage`; stop=`exit 0`; before/after=`record command sessions and exact output file sizes`; cleanup=`outputs retained, sessions closed, no descendants`.

- [ ] **Step 2: Verify the candidate path set exactly**

Use this expected set in a read-only comparison script:

```javascript
const expected = new Set([
  '.claude-plugin/marketplace.json', 'README.md',
  'plugins/development-workflow/.claude-plugin/plugin.json',
  'plugins/development-workflow/hooks/embedding-utils.js',
  'plugins/development-workflow/hooks/hooks.json',
  'plugins/development-workflow/hooks/post-code-check.js',
  'plugins/development-workflow/hooks/prune-rules.js',
  'plugins/development-workflow/hooks/session-start.js',
  'plugins/development-workflow/hooks/skill-router.js',
  'plugins/development-workflow/hooks/subagent-context.js',
  'plugins/development-workflow/hooks/task-utils.js',
  'plugins/development-workflow/hooks/tool-inventory.js',
  'plugins/development-workflow/hooks/tool-routing.js',
  'plugins/development-workflow/hooks/workflow-state.js',
  'plugins/development-workflow/hooks/rules-migrate.js',
  'plugins/development-workflow/hooks/session-rules.js',
  'plugins/development-workflow/package.json',
  'plugins/development-workflow/rules/rules-lazy-load.md',
  'plugins/development-workflow/rules/rules-selection.md',
  'plugins/development-workflow/test/hooks.test.js',
  'plugins/development-workflow/test/runtime-v5.test.js'
]);
```

Expected: all expected paths are changed with the intended add/modify/delete disposition. New or missing paths stop the freeze for root review; the script never edits or discards them.

- [ ] **Step 3: Hash every direct postimage, deleted preimage, and shared-file candidate hunk**

For the 19 direct paths, run:

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath $includedExistingPath
git show "HEAD:$deletedPath"
```

Hash deleted preimage bytes with SHA-256. For `README.md` and `.claude-plugin/marketplace.json`, hash the exact development-workflow-only patch hunks from Task 6 rather than the mixed working-tree postimage, because the gpt-bridge hunk is explicitly excluded. Write sorted records as `disposition sha256 repo-relative-path` to `candidate-files.sha256`. Expected: 21 unique records (19 direct path records plus 2 `partial-hunk` records); duplicates, unreadable paths, or zero classified records are `HOLD`.

Process contract: purpose=`candidate hashing`; owner=`root`; cwd=`repo root`; timeout=`120s`; temp root=`lease/preimage`; stop=`all 21 records written`; before/after=`record output hash and size`; cleanup=`retained evidence only, no child process remains`.

- [ ] **Step 4: Inventory historical temp paths without deleting them**

Read only the canonical system temp root. For directories matching `dw-hooks-*` or `dw-v5-*`, record canonical path hash, size when observable, creation/last-write time, reparse flag, and visible-handle status or `not_observable` in `historical-temp-inventory.json`.

Expected: the report explicitly says `cleanup_authorized=false` and `ownership=unknown`. Do not rename, quarantine, remove, or open files for write merely because the prefix matches.

Process contract: purpose=`historical temp inventory`; owner=`root`; cwd=`repo root`; timeout=`120s`; temp root=`none`; stop=`inventory sealed`; before/after=`no path count reduction`; cleanup=`none; historical paths are not owned by this run`.

- [ ] **Step 5: Seal the approved design and both execution plans as non-candidate inputs**

Hash these three repository-working-tree files without staging them:

```text
docs/specs/2026-08-26-dw-collaboration-design.md
docs/superpowers/plans/2026-08-26-development-workflow-5.0.0-baseline-freeze.md
docs/superpowers/plans/2026-08-26-dw-collaboration-5.1.0-implementation.md
```

Write sorted `sha256 repo-relative-path` records to `preimage/planning-inputs.sha256`. Expected: exactly three unique records, design status is `APPROVED_FOR_IMPLEMENTATION_PLANNING`, D-008 records V1, and both plans are the user-approved bytes. These files remain excluded from the 5.0.0 index; Plan B imports the exact hashed bytes into its isolated 5.1.0 worktree before implementation. Any later byte drift invalidates this planning-input receipt and requires renewed review rather than silent copying.

Process contract: purpose=`seal approved planning inputs`; owner=`root`; cwd=`repo root`; timeout=`60s`; temp root=`lease/preimage`; stop=`three hashes written and reread`; before/after=`source files unchanged, output hash and size recorded`; cleanup=`planning-input hash receipt retained, no descendants`.

### Task 3: Validate the current candidate with attached, bounded tests

**Files:**
- Read: `plugins/development-workflow/package.json:1-38`
- Read: `plugins/development-workflow/test/runtime-v5.test.js:1-end`
- Read: `plugins/development-workflow/test/hooks.test.js:1-end`
- Write outside candidate index: `validation/npm-test.json`, `validation/resource-deltas.json`

**Interfaces:**
- Consumes: sealed preimage, active resource ledger, unchanged candidate hashes.
- Produces: `ValidationRun1` with command, exit, test counts, permission classification, session closure, process/temp before-after deltas.

- [ ] **Step 1: Record the test launch card and before snapshot**

Register purpose=`5.0.0 repository test`; owner=`root`; cwd=`plugins/development-workflow`; timeout=`180s`; temp root=`test-owned roots created by test runner plus lease/validation`; stop=`exit or timeout`; cleanup=`test finally blocks then root verification`. Capture process/session IDs available from the native process manager, exact `dw-v5-*`/`dw-hooks-*` directory identities, disk free/capacity, and existing listeners owned by this run (normally none).

- [ ] **Step 2: Run the known Windows baseline command and watch the real result**

Run:

```powershell
cmd /c npm test
```

Expected in a fully permitted environment: `runtime-v5.test.js` reports `12/12 tests passed`, `hooks.test.js` reports `20/20 tests passed`, exit 0. If only the three CIM-dependent cases fail with `0x80041003 Access denied`, record `UNVERIFIED_ENVIRONMENT_PERMISSION`; do not edit tests, weaken assertions, or label the candidate failed.

Process contract: purpose=`5.0.0 repository test`; owner=`root`; cwd=`plugins/development-workflow`; timeout=`180s`; temp root=`runner-managed system temp`; stop=`attached command exit`; before/after=`capture returned session, exit code, count lines, exact owned process identities and temp delta`; cleanup=`verify every returned task-owned PID/session exited and new dw test roots were removed`.

- [ ] **Step 3: Gate any non-sandbox rerun behind separate authorization**

If and only if Step 2 is `UNVERIFIED_ENVIRONMENT_PERMISSION`, present the exact same `cmd /c npm test`, cwd, timeout and no-network/no-publish boundary to the user. After explicit approval, rerun outside the sandbox without changing code or thresholds.

Expected: exit 0 and 12/12 + 20/20 makes the Windows process tests verified. A permission failure remains `UNVERIFIED`; a behavioral assertion failure is `FAIL_CODE` and blocks staging.

Process contract: purpose=`authorized CIM-capable baseline rerun`; owner=`root`; cwd=`plugins/development-workflow`; timeout=`180s`; temp root=`runner-managed system temp`; stop=`attached exit`; before/after=`same delta checks as Step 2`; cleanup=`no detached session, owned PID, port or new temp root`.

- [ ] **Step 4: Seal test evidence without changing candidate files**

Write `npm-test.json` with exact command, cwd, start/end, exit, test counts, stdout/stderr hashes, sandbox mode, permission classification and cleanup verification. Rehash the 19 direct paths and re-extract/hash the two shared development-workflow hunks; compare all 21 records with `candidate-files.sha256`.

Expected: candidate hashes are unchanged by testing. Drift supersedes the validation and returns to Task 2.

### Task 4: Verify package contents and execute tests from the actual packed copy

**Files:**
- Read: `plugins/development-workflow/package.json:20-38`
- Write outside candidate index: `validation/pack-dry-run.json`, `validation/npm-pack.json`, `validation/packed-copy-test.json`
- Create then reclaim: `$freezeRoot/pack-work/**`

**Interfaces:**
- Consumes: PASS repository tests and unchanged candidate hashes.
- Produces: package inventory evidence and a package-local PASS from extracted tarball bytes.

- [ ] **Step 1: Run npm pack dry-run as JSON**

Run:

```powershell
cmd /c npm pack --dry-run --json
```

Expected: exit 0; one JSON result for `development-workflow@5.0.0`; package contains both test files, 11 `SKILL.md` files, two registered hooks, rules, and no `.skillopt-sleep`, repository docs, `.tmp`, credentials, or gpt-bridge files.

Process contract: purpose=`5.0.0 pack dry-run`; owner=`root`; cwd=`plugins/development-workflow`; timeout=`120s`; temp root=`npm internal temp plus lease/validation`; stop=`attached exit`; before/after=`session closed, no tarball created in cwd, temp delta recorded`; cleanup=`only evidence JSON retained`.

- [ ] **Step 2: Validate the dry-run inventory programmatically**

Use a read-only Node assertion over the captured JSON:

```javascript
const result = JSON.parse(fs.readFileSync(dryRunPath, 'utf8'))[0];
assert.strictEqual(result.name, 'development-workflow');
assert.strictEqual(result.version, '5.0.0');
const names = result.files.map(file => file.path.replaceAll('\\', '/'));
assert.strictEqual(names.filter(name => /(^|\/)SKILL\.md$/.test(name)).length, 11);
assert(names.includes('test/runtime-v5.test.js'));
assert(names.includes('test/hooks.test.js'));
assert(!names.some(name => /(^|\/)(?:\.tmp|\.skillopt-sleep|gpt-bridge)(\/|$)/.test(name)));
```

Expected: PASS. Any inventory mismatch blocks the freeze; do not repair package scope under this plan without a newly reviewed change plan.

- [ ] **Step 3: Create one real tarball inside the owned pack lease**

Create `$freezeRoot/pack-work/tarball` and run:

```powershell
cmd /c npm pack --json --pack-destination "$freezeRoot\pack-work\tarball"
```

Expected: exactly one `.tgz`, version 5.0.0, SHA/integrity matching npm JSON. Reparse/symlink detection on the pack-work root must be false before extraction.

Process contract: purpose=`5.0.0 real package build`; owner=`root`; cwd=`plugins/development-workflow`; timeout=`120s`; temp root=`lease/pack-work`; stop=`attached exit and one tarball`; before/after=`record tarball hash/size and command closure`; cleanup=`tarball retained until packed-copy test is sealed`.

- [ ] **Step 4: Create and verify the extraction directory, then run the package-local tests**

Create the exact `$freezeRoot/pack-work/extracted` directory only after resolving its canonical parent, verifying it did not previously exist, and rejecting any reparse/symlink/junction boundary. Record the directory identity and lease generation before extraction.

Run:

```powershell
tar -xf "$tarballPath" -C "$freezeRoot\pack-work\extracted"
cmd /c npm test
```

`$tarballPath` is resolved from the single npm-pack JSON record and rechecked below `$freezeRoot/pack-work/tarball`. The second command's cwd is `$freezeRoot/pack-work/extracted/package` and environment includes `DW_PACKAGE_TEST=1` to prevent nested repacking.

Expected: exit 0, runtime-v5 12/12 and retained hooks 20/20 or the same separately approved CIM classification. Tests must resolve only files inside extracted package; repository-only fallback is forbidden.

Process contract: purpose=`packed-copy test`; owner=`root`; cwd=`extracted/package`; timeout=`180s`; temp root=`lease/pack-work plus test-owned system temp`; stop=`attached exit`; before/after=`record exact tar/extracted identities, test-owned PIDs, temp roots and disk usage`; cleanup=`verify test processes exit, then remove only extracted/ and tarball/ after canonical-root/reparse/generation recheck; keep hashes and JSON evidence`.

- [ ] **Step 5: Verify pack-work reclamation**

After all bound sessions are closed, re-resolve `$freezeRoot/pack-work`, reject any reparse point or identity drift, and remove only that exact generation. Verify path absence and disk space observation; write `cleanup_status="RECLAIMED"`.

Expected: no pack-work directory, tarball, extracted tree, test PID, terminal or port remains. An identity mismatch or open handle produces `QUARANTINED/HOLD`; do not retry deletion by broader path.

### Task 5: Obtain independent candidate review

**Files:**
- Read: candidate include allowlist and sealed binary diff
- Write outside candidate index: `review/independent-review.json`

**Interfaces:**
- Consumes: candidate diff hash plus PASS validation/pack evidence.
- Produces: read-only review verdict with P0-P3 findings and explicit scope exclusions.

- [ ] **Step 1: Dispatch one bounded read-only independent reviewer and require collect evidence**

Task packet must contain: objective=`review 5.0.0 hook/rule convergence diff`; acceptance=`correctness, security, process cleanup, package surface`; dependency hashes=`binary diff + test receipts`; owned paths=`none`; forbidden=`writes, descendants, Git state changes, network`; timeout=`20 minutes`; output schema=`ReviewReceipt1`; return=`final collect`.

Agent resource contract: purpose=`independent diff review`; owner=`root owns agent session`; cwd=`repo root`; timeout=`20m`; temp root=`none`; stop=`final result, failure, cancellation, or timeout`; before/after=`record child session ID/state and root collect event`; cleanup=`request close and verify CLOSED`; no descendant agents. If reviewer dispatch, collect, independence, identity, or closure cannot be verified, record `review.kind="independent"`, `review.status="UNVERIFIED"`, run the root-local review only as supplemental diagnosis, and stop before staging. Root-local review never upgrades the independent-review gate.

Expected: reviewer returns JSON with `diff_sha256`, `scope`, `findings[{severity,path,line,evidence}]`, `verdict`, `forbidden_actions_observed=false`. A dispatch request without collect is not review evidence. The freeze gate requires `{kind:"independent",status:"PASS_NO_P0_P1",evidence_ref:<sealed-ref>}`; unavailable or root-local-only review is `UNVERIFIED/HOLD`.

- [ ] **Step 2: Root independently checks the full diff and all review findings**

Run:

```powershell
git diff --check HEAD
git diff --name-status HEAD
git diff --stat HEAD
```

Then read every candidate diff and verify deleted hook references are gone, two registered hooks match tests, migration remains explicit/read-only by default, process cleanup tests are retained, and 5.0.0/11-Skill surfaces agree. Record the existing `AGENTS.md` Session lifecycle line that still names `PreToolUse/PostToolUse` as an explicit P2 documentation residual scheduled for Plan B Task 9; it is not silently called consistent or added to the frozen candidate without a revised allowlist approval.

Expected: no P0/P1; every P2/P3 is resolved or explicitly accepted by the user before staging. Reviewer disagreement or changed diff hash is `HOLD`.

Process contract: purpose=`root diff review`; owner=`root`; cwd=`repo root`; timeout=`15m`; temp root=`none`; stop=`all candidate files reviewed`; before/after=`attached Git sessions closed`; cleanup=`none expected`.

### Task 6: Prepare the exact staged candidate after a staging-specific approval

**Files:**
- Modify Git index only after approval: candidate include allowlist
- Preserve working tree: all explicit exclusions
- Write outside candidate index: `staging/shared-dw-only.patch`, `staging/cached-name-status.txt`, `staging/cached.diff`

**Interfaces:**
- Consumes: PASS tests/package/review, unchanged preimage hash, explicit human approval to stage the exact allowlist.
- Produces: index tree containing only development-workflow 5.0.0 candidate hunks; no commit.

- [ ] **Step 1: Request staging authorization with the exact path and hunk list**

Present the 21-path allowlist, the mixed-file staged-only patch below, exclusions, diff hash and validation verdict. Expected user authorization must explicitly say staging is allowed; O-001 V1 approval alone is not staging authorization.

- [ ] **Step 2: Build and check the staged-only patch for shared files**

Write this patch exactly to `$freezeRoot/staging/shared-dw-only.patch`:

```diff
diff --git a/.claude-plugin/marketplace.json b/.claude-plugin/marketplace.json
--- a/.claude-plugin/marketplace.json
+++ b/.claude-plugin/marketplace.json
@@ -7,7 +7,7 @@
       "name": "development-workflow",
       "source": "./plugins/development-workflow",
       "description": "全流程开发准则：风险分级的诊断、规划、实现、验证与收尾。共11个 Skill（1个总纲 + 10个子 Skill），并含 hooks、rules 及环境健康检查。",
-      "version": "4.2.0",
+      "version": "5.0.0",
       "author": { "name": "JocuperDARY" },
       "homepage": "https://github.com/JocuperDARY/dw-marketplace",
       "repository": "https://github.com/JocuperDARY/dw-marketplace",
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -7,4 +7,4 @@
 | 插件 | 版本 | 说明 |
 |------|------|------|
-| [development-workflow](./plugins/development-workflow/) | 4.2.0 | 风险分级开发闭环，11个 Skill（1个总纲 + 10个子 Skill）+ 8 hooks + 8 rules |
+| [development-workflow](./plugins/development-workflow/) | 5.0.0 | 风险分级开发闭环，11个 Skill（1个总纲 + 10个子 Skill）+ 2 hooks + 8 rules |
 | [gpt-bridge](./plugins/gpt-bridge/) | 1.0.0 | MCP Server：Claude Code 对话中调用 GPT 执行子任务 |
@@ -40,5 +40,28 @@
 1. 替换 `extraKnownMarketplaces` 中的 marketplace source 为 `JocuperDARY/dw-marketplace`
 2. 替换 `enabledPlugins` 键为 `development-workflow@dw-marketplace`
-3. 功能完全继承，当前版本为 4.2.0
-
+3. 功能完成安全收敛，当前版本为 5.0.0
+
+### 5.0.0 钩子收敛
+
+5.0.0 只注册两个轻量钩子：
+
+- `SessionStart`：识别真实项目边界并只读选择相关规则
+- `UserPromptSubmit`：仅对高置信度开发意图提示对应 DW skill
+
+工具清单改为显式按需运行，不再在会话启动时构造推测性的 MCP/skill 列表：
+
+```bash
+node "${CLAUDE_PLUGIN_ROOT}/hooks/tool-inventory.js" --json
+```
+
+旧版 `prune-rules.js` 已移除。运行时选择器不会修改用户规则；若需要把活跃语言规则
+移出自动加载目录，必须先审阅只读迁移计划：
+
+```bash
+node "${CLAUDE_PLUGIN_ROOT}/hooks/rules-migrate.js" --dry-run
+```
+
+只有在计划无冲突且用户明确同意后才运行 `--apply`。原目录会保存在
+`~/.claude/rules-archive/<migration-id>/`，不会被删除。
+
 旧仓库 [JocuperDARY/development-workflow-skill](https://github.com/JocuperDARY/development-workflow-skill) 保留归档。
```

Run:

```powershell
git apply --cached --check --whitespace=nowarn "$freezeRoot\staging\shared-dw-only.patch"
git apply --cached --whitespace=nowarn "$freezeRoot\staging\shared-dw-only.patch"
```

Expected: both commands exit 0. The index gets only development-workflow hunks; working-tree gpt-bridge 2.0.0 lines remain unstaged.

Process contract: purpose=`stage shared development-workflow hunks`; owner=`root`; cwd=`repo root`; timeout=`60s`; temp root=`lease/staging`; stop=`git apply returned`; before/after=`index tree hash captured`; cleanup=`patch retained as evidence, no child processes`.

- [ ] **Step 3: Stage direct candidate paths by explicit allowlist**

Run one `git add -A --` command with only the 19 direct development-workflow paths listed in File and Evidence Map; do not use `git add .`, `git add -A` without pathspec, wildcard pathspecs, or a generated list from untrusted status output.

Expected: `git diff --cached --name-status` contains exactly 21 paths including the two shared files. `git diff --name-status` still contains the gpt-bridge-only working-tree changes and excluded docs/temp paths.

Process contract: purpose=`stage direct 5.0.0 candidate paths`; owner=`root`; cwd=`repo root`; timeout=`60s`; temp root=`none`; stop=`git add returned and allowlist comparison passed`; before/after=`index tree hashes recorded`; cleanup=`none; staging is intentional authorized state`.

- [ ] **Step 4: Verify the index as a reproducible candidate, not a commit**

Run:

```powershell
git diff --cached --check
git diff --cached --name-status
git diff --cached --binary --full-index
git write-tree
git diff --name-status
```

Save cached diff/hash and tree SHA. Expected: cached diff contains 5.0.0 only; no 5.1.0 collaboration files, gpt-bridge-only changes, `.skillopt-sleep`, design doc or plans. Do not run `git commit` in this task.

### Task 7: Human-authorized commit and exact-SHA postcondition

**Files:**
- Modify Git history only after a new explicit commit authorization
- Write outside candidate index: `handoff/baseline-receipt.json`

**Interfaces:**
- Consumes: approved staged tree SHA, all validation receipts, no P0/P1, separate user authorization containing the commit action.
- Produces: exact 5.0.0 commit SHA and tree SHA for Plan B; working-tree exclusions preserved.

- [ ] **Step 1: Present the staged snapshot and ask for commit authorization**

Report staged name-status, cached diff SHA-256, `git write-tree` SHA, repository test result, pack inventory result, packed-copy result, independent review, remaining unstaged paths, and resource cleanup state.

Expected: user explicitly authorizes exactly one local commit. Silence, plan approval, V1 selection, staging approval, or “ready” is not commit authorization.

- [ ] **Step 2: Create exactly one local commit after authorization**

Run:

```powershell
git commit -m "release: freeze development-workflow 5.0.0 baseline"
```

Expected: exit 0, one new local commit, no hook/test spawned beyond Git's configured behavior without appearing in the command ledger. If a commit hook launches a child, record its identity and verify it exits before continuing.

Process contract: purpose=`authorized local 5.0.0 baseline commit`; owner=`root`; cwd=`repo root`; timeout=`180s`; temp root=`Git-owned plus none task-specific`; stop=`commit exit or timeout`; before/after=`HEAD/index/tree/session and any hook descendants`; cleanup=`verify commit/hook sessions closed; no push/tag/publish`.

- [ ] **Step 3: Verify commit SHA, tree SHA, index, and preserved user changes**

Run:

```powershell
git rev-parse HEAD
git rev-parse HEAD^{tree}
git status --short
git diff --cached --quiet
git show --stat --oneline --decorate --no-renames HEAD
git show --format= --name-status --no-renames HEAD
```

Expected: HEAD parent is `c51195449c418294be7812641e28e46411231544`; commit tree equals the precommit `git write-tree`; index is empty; commit paths exactly match the allowlist; excluded gpt-bridge/docs/temp user changes remain in working tree; no push/tag/publish occurred.

Process contract: purpose=`postcommit verification`; owner=`root`; cwd=`repo root`; timeout=`60s`; temp root=`none`; stop=`all read-only commands returned`; before/after=`no new descendants or temp`; cleanup=`none expected`.

- [ ] **Step 4: Seal the Plan B handoff receipt**

Write this complete interface to `handoff/baseline-receipt.json` and hash it:

```json
{
  "schema": "DevelopmentWorkflowBaselineReceipt1",
  "version": "5.0.0",
  "parent_sha": "c51195449c418294be7812641e28e46411231544",
  "commit_sha": "<40-lowercase-hex-from-git>",
  "tree_sha": "<40-lowercase-hex-from-git>",
  "cached_diff_sha256": "<64-lowercase-hex>",
  "candidate_files_sha256_ref": "preimage/candidate-files.sha256",
  "planning_inputs_sha256_ref": "preimage/planning-inputs.sha256",
  "repository_tests": "PASS",
  "pack_dry_run": "PASS",
  "packed_copy_tests": "PASS",
  "review": {
    "kind": "independent",
    "status": "PASS_NO_P0_P1",
    "evidence_ref": "review/independent-review.json"
  },
  "index_clean": true,
  "working_tree_clean": false,
  "preserved_unrelated_changes": true,
  "resources": "ALL_TASK_OWNED_RECLAIMED_OR_EVIDENCE_RETAINED",
  "residual_risks": [
    "AGENTS.md hook inventory remains stale in the 5.0.0 baseline and is gated for correction in Plan B Task 9"
  ],
  "evidence_root": "<resolved-lease-root>",
  "created_at": "<RFC3339-UTC>"
}
```

The angle-bracket values here are populated only from commands named in this task, never guessed. Validate them with exact regex/enum checks before sealing. The evidence lease is retained intentionally; report its size, disk free/capacity and future retention review condition.

### Task 8: Final freeze audit and handoff

**Files:**
- Read: all evidence files and final Git state
- Do not modify: repository candidate or Git history

**Interfaces:**
- Consumes: sealed baseline receipt and exact commit.
- Produces: a human-readable handoff containing the only accepted Plan B base SHA.

- [ ] **Step 1: Audit every explicit freeze requirement**

Verify: dirty scope classified; diff/hash/status sealed; repository tests PASS; permission failures separately classified; pack dry-run PASS; actual packed-copy PASS; independent review no P0/P1; staged allowlist exact; commit separately authorized; SHA/tree/index/status postconditions proven; unrelated user changes preserved; historical temp not deleted; all task-owned sessions/process/temp reclaimed or retained evidence declared.

- [ ] **Step 2: Recheck resource terminal states**

Every resource ledger row must end in `RECLAIMED`, `CLOSED`, or `RETAINED_EVIDENCE`. Any `ACTIVE`, `UNKNOWN`, `QUARANTINED`, missing after-snapshot, unclosed agent/terminal, or unidentified PID forces `HOLD` and blocks Plan B worktree creation.

- [ ] **Step 3: Report the immutable handoff without broadening authority**

Report exact commit SHA, tree SHA, evidence receipt SHA-256, validation counts, remaining user-owned dirty paths, retained evidence bytes and resource terminal states. State explicitly: no push, tag, merge, publish, worktree creation or 5.1.0 implementation was performed.

The report also transfers bounded ownership of `$freezeRoot` to Plan B Task 1 with teardown condition `planning artifacts imported and baseline handoff copied into the 5.1.0 run ledger`. Until that condition is met, the lease remains `RETAINED_EVIDENCE`, has a recorded byte size and review date, and is not an abandoned temp directory. Plan B must migrate the minimal retained receipt/hash set to its approved evidence policy and then reclaim the exact freeze-root generation; failure to do so blocks final completion.

---

## Plan A Acceptance Checklist

- [ ] `DevelopmentWorkflowBaselineReceipt1` validates and names an actual local commit.
- [ ] The commit parent and tree are proven; the index is empty after commit.
- [ ] Candidate paths and mixed-file hunks match the approved allowlist.
- [ ] The approved design and both plans are sealed as exactly three non-candidate planning-input hashes.
- [ ] `cmd /c npm test`, pack dry-run and packed-copy tests have fresh PASS evidence.
- [ ] Any CIM permission issue was classified and separately authorized for rerun.
- [ ] Independent review has no unresolved P0/P1.
- [ ] Independent reviewer dispatch, collect, identity and closure are verified; root-local review was not substituted for the independent gate.
- [ ] Existing unrelated changes remain untouched and uncommitted.
- [ ] Historical temp paths were inventoried only.
- [ ] All task-owned agents, command sessions, processes, ports and disposable temp paths are reclaimed; retained evidence has an explicit lease.
- [ ] `$freezeRoot` has a named Plan B consumer, byte count, review date and exact teardown condition; it is not left with indefinite or ownerless retention.
- [ ] No push, tag, merge, publish, deployment or 5.1.0 work occurred.

## Execution Handoff

Plan A must be executed before Plan B. Because it freezes a shared dirty worktree and later mutates one Git index, the recommended execution is root-controlled inline serial execution through `superpowers:executing-plans`; no implementation worker may write or stage concurrently. The independent review in Task 5 may use exactly one bounded read-only reviewer after the candidate hash is sealed, and that reviewer must be collected and closed before staging. Neither execution mode nor review completion grants commit authority: staging and commit remain separate human gates.
