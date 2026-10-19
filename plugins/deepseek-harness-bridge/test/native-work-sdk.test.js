import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client';
import { resolveNativeProfile } from '../src/native-profile.js';
import { prepareNativeWorkspace } from '../src/native-workspace.js';
import { createSdkRunner, ROUTE, workerEnvironment } from '../src/sdk-runner.js';

const sha = text => createHash('sha256').update(text).digest('hex');
const modelPath = fileURLToPath(new URL('./fixtures/native-work-model.js', import.meta.url));
function toolText(requests, id) {
  const reply = requests.at(-1).messages.find(message => message.role === 'tool' && message.toolCallId === id);
  assert.ok(reply, `Missing tool result ${id}`);
  assert.notEqual(reply.isError, true, JSON.stringify(reply));
  return reply.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
}

async function fixture(t, selected, steps, resumeSteps = []) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-native-work-'));
  const workspacePath = join(root, 'workspace');
  if (selected.includes('shell')) await prepareNativeWorkspace({ workspace: workspacePath, dataDir: join(root, 'state') });
  else await mkdir(workspacePath);
  const workspace = await realpath(workspacePath);
  const home = join(root, 'worker-home');
  const receipt = join(root, 'model-requests.json');
  const taskId = randomUUID();
  const task = { taskId, sessionId: `bridge-${randomUUID()}`, workspace, access: 'workspace-write',
    capabilityProfile: 'native', nativePlugins: selected, planning: { executionMode: 'automatic' },
    route: { ...ROUTE, effort: 'off' }, maxTokens: null, maxModelRequests: null,
    maxToolCalls: null, maxRequestBytes: null, attempts: [{ number: 1, timeoutMs: null }] };
  const profile = await resolveNativeProfile({}, task);
  profile.modules.push({ path: modelPath, sha256: sha(await readFile(modelPath)), tools: [], native: true,
    config: { receipt, steps, resumeSteps } });
  const runner = createSdkRunner({ resolveCapabilities: async () => profile,
    env: { ...workerEnvironment(), DEEPSEEK_API_KEY: 'offline-synthetic-not-a-secret' },
    clientFactory: options => new HarnessClient({ ...options, env: { ...options.env,
      NODE_OPTIONS: `${options.env.NODE_OPTIONS ?? ''} --import=${new URL('./fixtures/offline-network.js', import.meta.url).href}` } }),
  });
  t.after(async () => {
    // Keep failed fixtures inspectable; only successful owned temp roots are removed.
    if (t.passed) await rm(root, { recursive: true, force: true });
    else t.diagnostic(`Retained synthetic evidence: ${root}`);
  });
  const run = async (resume = false) => {
    if (resume) task.attempts.push({ number: 2, timeoutMs: null });
    const result = await runner({ task, home, resume, signal: AbortSignal.timeout(90000),
      prompt: resume ? 'CAMPAIGN_RESUME_WORK: execute the fixed continuation steps.' : 'Execute only the authorized synthetic offline fixture steps.' });
    await writeFile(join(root, resume ? 'resumed-result.json' : 'result.json'), JSON.stringify(result, null, 2));
    assert.equal(result.terminal, 'completed', JSON.stringify(result));
    assert.equal(result.cleanup, 'confirmed');
    const requests = JSON.parse(await readFile(receipt, 'utf8'));
    assert.equal(result.budget.modelRequests, requests.length);
    assert.equal(result.budget.calls.every(call => call.finished && call.usage?.outputTokens === 10), true);
    return { result, requests, messages: JSON.stringify(requests.at(-1).messages) };
  };
  return { root, workspace, home, task, run };
}

test('native real SDK reads, replaces and rejects stale CAS with preserved backup', { timeout: 100000 }, async t => {
  const original = 'alpha alpha\n';
  const steps = [
    { name: 'bridge_read', args: { path: 'input.txt' } },
    { name: 'ops_replace', args: { path: 'input.txt', pattern: 'alpha', replacement: 'beta', expectedSha256: sha(original) } },
    { name: 'ops_replace', args: { path: 'input.txt', pattern: 'beta', replacement: 'WRONG', expectedSha256: sha(original) } },
    { name: 'bridge_read', args: { path: 'input.txt' } },
  ];
  const f = await fixture(t, ['files'], steps);
  await writeFile(join(f.workspace, 'input.txt'), original);
  const { result, messages } = await f.run();
  assert.equal(result.toolCalls, steps.length);
  assert.equal(await readFile(join(f.workspace, 'input.txt'), 'utf8'), 'beta beta\n');
  const backups = await readdir(join(f.home, 'backups'));
  assert.equal(backups.length, 1);
  assert.equal(await readFile(join(f.home, 'backups', backups[0]), 'utf8'), original);
  assert.match(messages, /FILE_CHANGED/);
  assert.match(messages, /beta beta/);
  assert.equal(result.capabilities.toolOutcomes.ops_replace.returned, 2,
    'Transport success includes a returned structured error; inspect its payload above.');
});

test('native skills, sandbox Shell, job collection/kill and resumed workspace execute offline', { timeout: 190000 }, async t => {
  if (process.platform !== 'win32') return t.skip('The advertised native Shell adapter requires Windows.');
  const foreground = "if ($env:DEEPSEEK_API_KEY) { throw 'Credential environment leaked' }; Set-Content -LiteralPath shell-output.txt -Value NATIVE_SHELL_FIXTURE; Write-Output ('CWD=' + (Get-Location).Path); Write-Output CREDENTIAL_ENV_SCRUBBED";
  const steps = [
    { name: 'bridge_skill_search', args: { query: 'offline-campaign-fixture' } },
    { name: 'bridge_skill_load', args: { name: 'offline-campaign-fixture' } },
    { name: 'pwsh', args: { description: 'Verify sandbox cwd and write fixture', command: foreground } },
    { name: 'pwsh', args: { description: 'Start finite fixture background job', command: "Start-Sleep -Milliseconds 200; Write-Output JOB_COLLECTED", run_in_background: true } },
    { name: 'job_list', args: {} },
    { name: 'job_output', args: { job_id: '$latestJob', wait: true, timeout_ms: 10000 } },
    { name: 'pwsh', args: { description: 'Start owned cancellable fixture job', command: 'Start-Sleep -Seconds 30; Write-Output SHOULD_NOT_COMPLETE', run_in_background: true } },
    { name: 'job_kill', args: { job_id: '$latestJob', reason: 'The fixture checks cancellation of this owned job.' } },
    { name: 'job_output', args: { job_id: '$latestJob', wait: true, timeout_ms: 10000 } },
  ];
  const resumeSteps = [
    { name: 'bridge_read', args: { path: 'shell-output.txt' } },
    { name: 'pwsh', args: { description: 'Verify resumed session workspace directory', command: "Write-Output ('RESUMED_CWD=' + (Get-Location).Path); Get-Content -LiteralPath shell-output.txt" } },
    { name: 'job_list', args: {} },
  ];
  const f = await fixture(t, ['skills', 'files', 'shell'], steps, resumeSteps);
  await mkdir(join(f.workspace, '.dsh', 'skills', 'offline-campaign-fixture'), { recursive: true });
  await mkdir(join(f.workspace, '.git'));
  await writeFile(join(f.workspace, '.dsh', 'skills', 'offline-campaign-fixture', 'SKILL.md'),
    '---\nname: offline-campaign-fixture\ndescription: Unique offline-campaign-fixture validation skill\n---\nUse the marker NATIVE_SKILL_BODY_LOADED when verifying synthetic artifacts.\n');
  const first = await f.run();
  assert.equal(first.result.toolCalls, steps.length);
  assert.ok(first.result.capabilities.skills.loaded.some(skill => skill.name === 'offline-campaign-fixture'));
  assert.match(first.messages, /NATIVE_SKILL_BODY_LOADED/);
  assert.match(first.messages, /CREDENTIAL_ENV_SCRUBBED/);
  assert.match(toolText(first.requests, 'work-start-6'), /JOB_COLLECTED/);
  assert.match(toolText(first.requests, 'work-start-8'), /requested cancellation of job/);
  const killed = toolText(first.requests, 'work-start-9');
  assert.doesNotMatch(killed, /SHOULD_NOT_COMPLETE/);
  assert.match(killed, /cancelled|killed|exit code: 1/i);
  assert.ok(first.messages.includes(JSON.stringify(`CWD=${f.workspace}`).slice(1, -1)));
  assert.equal((await readFile(join(f.workspace, 'shell-output.txt'), 'utf8')).trim(), 'NATIVE_SHELL_FIXTURE');
  const second = await f.run(true);
  assert.equal(second.result.toolCalls, resumeSteps.length);
  assert.ok(second.messages.includes(JSON.stringify(`RESUMED_CWD=${f.workspace}`).slice(1, -1)));
  assert.match(second.messages, /NATIVE_SHELL_FIXTURE/);
  assert.match(second.messages, /no background jobs/);
});
