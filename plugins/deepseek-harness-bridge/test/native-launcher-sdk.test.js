import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client';
import { resolveNativeProfile } from '../src/native-profile.js';
import { prepareNativeWorkspace } from '../src/native-workspace.js';
import { createSdkRunner, ROUTE, workerEnvironment } from '../src/sdk-runner.js';

const modelPath = fileURLToPath(new URL('./fixtures/native-work-model.js', import.meta.url));

test('staged launcher executes in official native Shell and owned job cancellation reaps its descendants', { timeout: 150000 }, async t => {
  if (process.platform !== 'win32') return t.skip('Native Shell targets Windows.');
  const root = await mkdtemp(join(tmpdir(), 'bridge-native-launcher-'));
  const prepared = await prepareNativeWorkspace({ workspace: join(root, 'workspace'), dataDir: join(root, 'state'), stageRuntimeSupport: true });
  const workspace = await realpath(prepared.workspace);
  const receipt = join(root, 'model-requests.json');
  // Finite child lifetime is a fixture teardown backstop, never a user task cap.
  await writeFile(join(workspace, 'owned-tree.cjs'), `const fs=require('node:fs'),{spawn}=require('node:child_process');
if(process.argv[2]==='child'){setTimeout(()=>{},20000);}
else {const child=spawn(process.execPath,[__filename,'child'],{stdio:'ignore',windowsHide:true});
fs.writeFileSync('tree-pids.json',JSON.stringify([process.pid,child.pid]));setTimeout(()=>{},20000);}
`);
  const common = "$ErrorActionPreference='Stop'; . .\\.bridge-runtime\\Invoke-BridgeProcess.ps1; $m=Get-Content .\\.bridge-runtime\\manifest.json -Raw | ConvertFrom-Json; ";
  const steps = [
    { name: 'pwsh', args: { description: 'Execute the staged launcher with a real nonzero child', command: common
      + "$r=Invoke-BridgeProcess -FilePath $m.node.path -ArgumentList @('-e','process.stdout.write(JSON.stringify({cwd:process.cwd(),node:process.version}));process.stderr.write(\"STDERR_PRESERVED\");process.exit(7)') -WorkingDirectory (Get-Location).Path -OutputDirectory 'artifacts/nonzero'; $r | ConvertTo-Json | Set-Content launcher-receipt.json; if($r.exitCode -ne 7){throw 'Wrong exit'}; Write-Output NATIVE_LAUNCHER_NONZERO_OK" } },
    { name: 'pwsh', args: { description: 'Start this fixture owned finite child tree', command: common
      + "Invoke-BridgeProcess -FilePath $m.node.path -ArgumentList @('owned-tree.cjs') -WorkingDirectory (Get-Location).Path -OutputDirectory 'artifacts/cancelled' | ConvertTo-Json | Set-Content cancelled-success.json", run_in_background: true } },
    { name: 'pwsh', args: { description: 'Capture exact process identities before cancelling the fixture job', command:
      "$ErrorActionPreference='Stop'; $until=[DateTime]::UtcNow.AddSeconds(8); while(-not(Test-Path tree-pids.json)){if([DateTime]::UtcNow -gt $until){throw 'No owned identities'};Start-Sleep -Milliseconds 50}; $ids=Get-Content tree-pids.json -Raw | ConvertFrom-Json; $identities=@($ids | ForEach-Object { $p=Get-Process -Id $_ -ErrorAction Stop; @{id=$p.Id;startTicks=$p.StartTime.ToUniversalTime().Ticks.ToString()} }); $identities | ConvertTo-Json | Set-Content tree-identities.json; Write-Output OWNED_IDENTITIES_CAPTURED" } },
    { name: 'job_kill', args: { job_id: '$latestJob', reason: 'Cancel exactly the owned finite fixture job.' } },
    { name: 'job_output', args: { job_id: '$latestJob', wait: true, timeout_ms: 10000 } },
    { name: 'pwsh', args: { description: 'Verify the captured identities exited without killing unrelated processes', command:
      "$ErrorActionPreference='Stop'; $ids=Get-Content tree-identities.json -Raw | ConvertFrom-Json; $until=[DateTime]::UtcNow.AddSeconds(5); do { $remaining=@($ids | Where-Object { $p=Get-Process -Id $_.id -ErrorAction SilentlyContinue; $p -and $p.StartTime.ToUniversalTime().Ticks.ToString() -eq $_.startTicks }); if($remaining.Count -eq 0){break}; Start-Sleep -Milliseconds 100 } while([DateTime]::UtcNow -lt $until); if($remaining.Count){throw 'Owned child identity survived cancellation'}; if((Test-Path cancelled-success.json) -and (Get-Item cancelled-success.json).Length -gt 0){throw 'Cancelled launch emitted success'}; 'NATIVE_TREE_CANCELLED' | Set-Content tree-cleanup.txt; Write-Output NATIVE_TREE_CANCELLED" } },
  ];
  const task = { taskId: randomUUID(), sessionId: `bridge-${randomUUID()}`, workspace, access: 'workspace-write',
    capabilityProfile: 'native', nativePlugins: ['shell'], planning: { executionMode: 'automatic' },
    route: { ...ROUTE, effort: 'off' }, maxTokens: null, maxModelRequests: null, maxToolCalls: null, maxRequestBytes: null,
    attempts: [{ number: 1, timeoutMs: null }] };
  const profile = await resolveNativeProfile({}, task);
  profile.modules.push({ path: modelPath, sha256: createHash('sha256').update(await readFile(modelPath)).digest('hex'),
    tools: [], native: true, config: { receipt, steps } });
  const runner = createSdkRunner({ resolveCapabilities: async () => profile,
    env: { ...workerEnvironment(), DEEPSEEK_API_KEY: 'offline-synthetic-not-a-secret' },
    clientFactory: options => new HarnessClient({ ...options, env: { ...options.env,
      NODE_OPTIONS: `${options.env.NODE_OPTIONS ?? ''} --import=${new URL('./fixtures/offline-network.js', import.meta.url).href}` } }),
  });
  t.after(async () => {
    if (t.passed) await rm(root, { recursive: true, force: true });
    else t.diagnostic(`Retained synthetic native launcher evidence: ${root}`);
  });
  const result = await runner({ task, home: join(root, 'worker-home'), resume: false, signal: AbortSignal.timeout(100000),
    prompt: 'Execute only the fixed local fixture steps. No provider or network access is authorized.' });
  await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2));
  assert.equal(result.terminal, 'completed', JSON.stringify(result));
  assert.equal(result.cleanup, 'confirmed');
  const requests = JSON.parse(await readFile(receipt, 'utf8'));
  assert.equal(result.budget.modelRequests, steps.length + 1);
  const replies = requests.at(-1).messages.filter(message => message.role === 'tool');
  for (const index of [1, 2, 3, 4, 6]) {
    const reply = replies.find(message => message.toolCallId === `work-start-${index}`);
    assert.ok(reply && !reply.isError, JSON.stringify(reply));
  }
  const launched = JSON.parse((await readFile(join(workspace, 'launcher-receipt.json'), 'utf8')).replace(/^\uFEFF/, ''));
  assert.equal(launched.exitCode, 7);
  assert.deepEqual(JSON.parse(await readFile(launched.stdoutPath, 'utf8')), { cwd: workspace, node: process.version });
  assert.equal(await readFile(launched.stderrPath, 'utf8'), 'STDERR_PRESERVED');
  assert.match(await readFile(join(workspace, 'tree-cleanup.txt'), 'utf8'), /NATIVE_TREE_CANCELLED/);
  const cancelledReceipt = await readFile(join(workspace, 'cancelled-success.json'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  assert.equal(cancelledReceipt.trim(), '');
});
