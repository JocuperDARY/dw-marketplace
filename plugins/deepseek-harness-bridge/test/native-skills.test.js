import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../src/native-skills.js';

test('native skills are searched first; imported Codex skills require an explained fallback', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-skills-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = new Map();
  const skills = [
    { name: 'dsh-animation', description: 'animation', source: 'user-dsh', provider: 'filesystem', content: 'DSH body' },
    { name: 'codex-animation', description: 'animation', source: 'agent-codex', provider: 'dsh-skills-manager-external', content: 'Codex body' },
  ];
  await apply({ tools: { register: tool => tools.set(tool.name, tool) }, skills: {
    snapshot: async () => ({ skills, complete: true }), get: async name => skills.find(skill => skill.name === name),
  } }, { workspace: root, nonce: 'fixture', receiptPath: join(root, 'receipt.json') });
  const call = async (name, args) => JSON.parse(await tools.get(name).execute(args, {}));
  await assert.rejects(call('bridge_skill_load', { name: 'codex-animation' }), /Search the native/);
  await assert.rejects(call('bridge_skill_search', { query: 'animation', source: 'supplemental', reason: 'test' }), /native search first/);
  const native = await call('bridge_skill_search', { query: 'animation' });
  assert.deepEqual(native.skills.map(skill => skill.name), ['dsh-animation']);
  assert.equal((await call('bridge_skill_load', { name: 'dsh-animation' })).content, 'DSH body');
  await assert.rejects(call('bridge_skill_load', { name: 'codex-animation' }), /Search the native/);
  await assert.rejects(call('bridge_skill_search', { query: 'animation', source: 'supplemental' }), /explain/);
  const fallback = await call('bridge_skill_search', { query: 'animation', source: 'supplemental', reason: 'Native skill does not cover the required format.' });
  assert.deepEqual(fallback.skills.map(skill => skill.name), ['codex-animation']);
  assert.equal((await call('bridge_skill_load', { name: 'codex-animation' })).content, 'Codex body');
  const receipt = JSON.parse(await readFile(join(root, 'receipt.json'), 'utf8'));
  assert.equal(receipt.searches[1].source, 'supplemental');
  assert.equal(receipt.modelApplication, 'not_assessed');
});
