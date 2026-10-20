import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRuntime, ROUTE } from '../src/sdk-runner.js';
import { planExecution } from '../src/planning.js';

test('execution guidance reaches only a registered native Shell without changing executor, effort or caps', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-guidance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const kind of ['shell', 'unsupported-shell', 'native-files', 'inference-only']) {
    const native = kind === 'inference-only' ? undefined : kind === 'native-files'
      ? { selected: ['files'], components: [{ capability: 'files', selected: true }] }
      : { selected: ['shell'], components: [{ capability: 'shell', selected: kind === 'shell' }] };
    const access = kind === 'shell' ? 'workspace-write' : 'read-only';
    const tools = kind === 'shell' ? ['pwsh'] : [];
    const profile = { access, digest: 'test', modules: [], tools, fileTools: false, skills: [], native };
    const task = {
      taskId: kind, sessionId: kind, workspace: root, access,
      route: { ...ROUTE, effort: 'off' }, maxTokens: 1234, maxModelRequests: 1,
      maxToolCalls: 0, maxRequestBytes: 10000, attempts: [{ number: 1 }],
      planning: { executionMode: kind === 'inference-only' ? 'single-request' : 'automatic' },
    };
    const prepared = await prepareRuntime({ task, home: join(root, kind), env: {}, resolveCapabilities: async () => profile });
    const patch = JSON.parse(await readFile(prepared.options.patches[0], 'utf8'));
    const persona = patch.find(row => row.id === 'system-prompt').config.personaPrefix;
    assert.equal(persona.includes('Execution reuse:'), kind === 'shell');
    assert.deepEqual(prepared.expectedTools, tools);
    assert.equal(prepared.options.requestTimeoutMs, undefined);
    const inserted = patch.flatMap(row => row.insert ?? []);
    assert.deepEqual(inserted.map(row => row.id), ['bridge-budget', 'bridge-files']);
    const budget = inserted.find(row => row.id === 'bridge-budget').config;
    assert.equal(budget.effort, 'off');
    assert.equal(budget.maxTokens, 1234);
    assert.equal(budget.maxModelRequests, 1);
    assert.equal(budget.maxRequestBytes, 10000);
    assert.equal(inserted.find(row => row.id === 'bridge-files').config.maxToolCalls, 0);
    if (kind === 'inference-only') assert.equal(patch.find(row => row.id === 'compaction-basic').disabled, true);
  }
});

test('reasoning selection remains explicit and does not infer new caps or override user effort', () => {
  const reasoning = planExecution({ workload: 'reasoning' });
  assert.equal(reasoning.effort, 'high');
  assert.equal(reasoning.maxTokens, null);
  const explicit = planExecution({ workload: 'reasoning', effort: 'low', maxTokens: 8192, maxModelRequests: 2 });
  assert.equal(explicit.effort, 'low');
  assert.equal(explicit.maxTokens, 8192);
  assert.equal(explicit.maxModelRequests, 2);
});
