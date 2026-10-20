# Execution efficiency and evidence reuse

Reduce repeated discovery and duplicate execution while preserving task identity, failures and parent acceptance. A prior local observation report recorded 382 requests, 3 complete training runs and 9 test/evaluation executions. Those counts motivate this workflow; they are a baseline observation, not measured savings, a target quota, or proof that any run was redundant. Keep its detailed request accounting in the local report.

## Prepare once, then prove the selected runtime

Use a NEW absolute workspace below an existing parent. Do not stage into, overwrite or adopt an existing workspace:

```json
{
  "workspace": "D:\\bridge-work\\assignment-001",
  "stageRuntimeSupport": true
}
```

Pass this object to `dsh_prepare_workspace`. The optional flag defaults to false. Preparation creates a worker-owned workspace and, when requested, `.bridge-runtime/Invoke-BridgeProcess.ps1` plus `.bridge-runtime/manifest.json`, without making a model request. The manifest records the helper relative path and SHA256 and the current Bridge process's Node path/version. It is data for discovery, not permission to execute, proof of child-runtime compatibility, or an acceptance decision. Preserve the preparation receipt.

Check the helper at its fixed path against the preparation receipt's SHA256; a hash or path read only from a mutable manifest is not independent verification. Reuse a prior successful probe when its account, sandbox, launcher and executable identity still match. Otherwise, in the task's actual native Shell, dot-source the staged helper and make one minimal child probe before relying on that Node path:

```powershell
$workspace = 'D:\bridge-work\assignment-001'
$manifest = Get-Content -LiteralPath (Join-Path $workspace '.bridge-runtime\manifest.json') -Raw | ConvertFrom-Json
. (Join-Path $workspace '.bridge-runtime\Invoke-BridgeProcess.ps1')
$probe = Invoke-BridgeProcess `
  -FilePath $manifest.node.path `
  -ArgumentList @('-e', 'process.stdout.write(JSON.stringify({node:process.version,cwd:process.cwd()}))') `
  -WorkingDirectory $workspace `
  -OutputDirectory 'artifacts/runtime-probe-001'
$probe | ConvertTo-Json -Compress
Get-Content -LiteralPath $probe.stdoutPath -Raw
Get-Content -LiteralPath $probe.stderrPath -Raw
```

Require exitCode 0 and inspect the probe output for the intended runtime and cwd. A helper's packaged offline tests do not establish execution through the official native Shell, which has its own account, sandbox and launch path. Preparation reports `shellExecutionVerified: false` until corresponding actual Shell evidence is collected. If launch fails, preserve its exception and output files; do not claim that a missing successful receipt is exit 0.

The helper's exact parameters are `FilePath`, `string[] ArgumentList`, absolute canonical `WorkingDirectory`, and relative NEW `OutputDirectory`. It runs a foreground executable without shell interpretation, streams stdout/stderr to separate files, waits for its real exit and returns only `exitCode`, `startedAt`, `endedAt`, `stdoutPath`, `stderrPath`. It adds no duration/token caps, retries, ACL changes, elevation or network operations. It accepts nonzero exits as evidence; the parent decides what they mean.

Output paths must stay inside the working directory and cannot traverse `..`, use a rooted path, pass through reparse ancestry, or reuse an existing output directory. New receipts never overwrite old evidence. These path checks are not atomic protection against malicious concurrent directory replacement. On failure, modern .NET can terminate the helper-owned process tree; Windows PowerShell 5.1 can terminate only the direct child. Upstream supervision remains responsible for descendant teardown and must not assume a complete tree cleanup from a PS5.1 helper exception.

## Reuse an observed path and its failure evidence

Carry the verified executable path, version, cwd, helper identity and probe receipt into later steps within the same applicable environment. Prefer those facts over rediscovering PATH or switching launch mechanisms. Mark evidence from another account, sandbox, machine or changed installation as historical until rechecked. A manifest path alone does not satisfy this match.

When a command fails, first read its existing receipt, stdout/stderr and relevant source. Classify launch, environment, input, numerical and acceptance failures separately. Keep the original exit, timeout, truncated output and unknown state. Retry only after a concrete correction or a required identity check, within existing authorization; use a fresh output directory and link the prior evidence. Do not replay training merely to recover a lost summary.

## Match identity before reusing training or evaluation

Before reuse, compare the relevant source revision/dirty changes, command and parameters, dataset and split identity, preprocessing, seeds, checkpoint identity, runtime/dependency versions and acceptance rules. Record a known mismatch or an unknown rather than guessing. Reuse the result only for claims covered by matching identity and preserved artifacts. Loading an existing checkpoint does not prove that its training or its new evaluation was performed in the present task.

Rerun affected work when inputs, effective code/configuration, dataset/splits, preprocessing, checkpoint, runtime-sensitive behavior or required acceptance rules change; when artifacts are incomplete; or when independent execution is itself required. A documentation-only change can usually reuse unchanged execution evidence. A change to evaluation code usually requires evaluation again; it does not automatically require retraining. A change to source physics, training data or training implementation requires the corresponding new scientific evidence. Never change splits, thresholds or model physics to manufacture a pass.

## Batch independent operations without losing their outcomes

Batch independent checks in one Shell invocation when this reduces repeated setup. Give every child a distinct output directory and preserve its own receipt, exit and errors. Avoid shell chains that retain only the last exit. For example, after the runtime probe above:

```powershell
$jobs = @(
  @{ id = 'check-a'; script = 'checks\check-a.js' },
  @{ id = 'check-b'; script = 'checks\check-b.js' }
)
$ledger = foreach ($job in $jobs) {
  try {
    $receipt = Invoke-BridgeProcess -FilePath $manifest.node.path `
      -ArgumentList @($job.script) -WorkingDirectory $workspace `
      -OutputDirectory ('artifacts/' + $job.id + '-001')
    [pscustomobject]@{ id=$job.id; status='executed'; receipt=$receipt; accepted=$null }
  } catch {
    [pscustomobject]@{ id=$job.id; status='execution-error'; receipt=$null; accepted=$null }
  }
}
$ledger | ConvertTo-Json -Depth 6
```

This loop is appropriate only for independent checks. Stop dependent work when its prerequisite fails. Preserve failed operation artifacts and diagnostic evidence separately; sanitize any error text before sharing if it can contain sensitive command data. An exception with no receipt is an execution error, not a fabricated numeric exit. A batch finishing does not mean all children passed.

## Effort and continuation

The supported effort vocabulary is `off`, `low`, `high`, `max`; there is no middle effort setting. Use `mechanical`/`drafting` with off for literal extraction or prose from supplied facts, `standard` with low for routine maintenance, and `reasoning` or `verification` with high for substantive analysis. Geometry, numerical analysis and diagnosis belong to `workload: "reasoning"` with high when effort is omitted. Max requires a task-specific need and authorization; it is not a routine retry setting.

Preserve explicit effort and all user limits. Warnings are not permission to raise either. Do not silently upgrade a continued task's effort or reset its budgets; report that an explicit low/off choice may be insufficient and let the existing authority determine the next step. Execution reuse reduces needless tool work, not the required reasoning or acceptance standard.

## Execution ledger and parent acceptance

Maintain a compact ledger per logical operation; update it from receipts and artifacts, not recollection:

| Field | Required content |
| --- | --- |
| Identity | operation ID, source/data/checkpoint/runtime identities and known mismatches |
| Execution | exact command/parameters in private evidence, cwd, start/end, receipt/output paths |
| Outcome | observed exit or original failure/timeout/unknown; NOT_RUN for absent execution |
| Reuse | original evidence locator, identity comparison, claim scope, reason for reuse or rerun |
| Cost | observed requests/training/evaluations and available usage; missing values remain unknown |
| Acceptance | parent judgment, authoritative criterion, evidence locator, limits and next action |

Keep sensitive arguments out of shared ledgers. Count requests, complete training runs and test/evaluation executions separately, with their denominators and scope. Do not infer savings from fewer visible Shell calls, null usage, test success or artifact existence.

Use the following parent record for each relevant acceptance dimension:

| Dimension | Criterion and identity | Direct evidence | Parent result | Claim limit / next action |
| --- | --- | --- | --- | --- |
| Geometry / animation | entity counts, connectivity, transforms, viewport/zoom, cycle phases and applicable revision | actual rendered frames and interaction/geometry matrix; independent expected coordinates rather than the drawing function as its own oracle | PASS / FAIL / NOT_RUN / UNKNOWN | unresolved visual defects and affected scenarios |
| Numerical / learning | gradients, boundary inputs, preprocessing, data splits, seeds, checkpoint and tolerance identity | synthetic boundary/gradient checks; frozen-model evaluation with numerator/denominator and reference comparison | PASS / FAIL / NOT_RUN / UNKNOWN | training completion versus measured accuracy or scientific validity; required independent checks |
| Delivery | owned files, packaging/API behavior, required checks and requested artifacts | diff, relevant tests, receipts and artifact inspection | ACCEPTED / REJECTED / NOT_ASSESSED | exactly accepted scope, corrections and remaining work |

Static/package success, helper offline success, native Shell success, solver completion and scientific acceptance are distinct claims. Parent acceptance must cite the applicable evidence for each; a worker's completion or a generated PASS label does not establish any other dimension.
