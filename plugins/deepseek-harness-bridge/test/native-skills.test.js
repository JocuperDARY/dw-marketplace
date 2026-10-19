import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../src/native-skills.js';
import { createPresetSkillProvider, presetSkillRoot } from '../src/native-skill-sources.js';

test('native skills are searched first; imported Codex skills require an explained fallback', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-skills-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = new Map();
  let preset;
  const skills = [
    { name: 'dsh-animation', description: 'animation', source: 'user-dsh', provider: 'filesystem', content: 'DSH body' },
    { name: 'codex-animation', description: 'animation', source: 'agent-codex', provider: 'dsh-skills-manager-external', content: 'Codex body' },
  ];
  await apply({ effect: fn => fn(), tools: { register: tool => tools.set(tool.name, tool) }, skills: {
    registerProvider: create => { preset = create(); return () => {}; },
    snapshot: async () => { await preset.list({}); return { skills, complete: true }; }, get: async name => skills.find(skill => skill.name === name),
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

async function toolFixture(t, snapshot) {
  const root = await mkdtemp(join(tmpdir(), 'native-skill-query-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = new Map();
  let preset;
  const disposers = [];
  t.after(async () => { for (const dispose of disposers.reverse()) await dispose?.(); });
  await apply({ effect: fn => { disposers.push(fn()); }, tools: { register: tool => tools.set(tool.name, tool) },
    skills: { registerProvider: create => { preset = create(); return () => {}; },
      snapshot: async () => { await preset.list({}); return snapshot; } } },
  { workspace: root, nonce: 'query-fixture', receiptPath: join(root, 'receipt.json') });
  return { root, call: async args => JSON.parse(await tools.get('bridge_skill_search').execute(args, {})) };
}

test('a zero-match query distinguishes a populated catalog from an empty source and supports inventory paging', async t => {
  const skills = Array.from({ length: 21 }, (_, i) => ({ name: `native-${i}`, description: 'Cordis composition', source: 'custom' }));
  skills.push({ name: 'codex-web', description: 'website design', source: 'agent-codex' },
    { name: 'disabled', description: 'animation', source: 'user-dsh', invocation: { modelInvocable: false } });
  const f = await toolFixture(t, { skills, complete: true });
  const none = await f.call({ query: 'animation' });
  assert.equal(none.state, 'no_matches');
  assert.equal(none.catalogTotal, 21);
  assert.deepEqual(none.sourceCounts, { native: 21, supplemental: 1 });
  assert.match(none.guidance, /Broaden/);
  const all = await f.call({ query: '*' });
  assert.equal(all.total, 21);
  assert.equal(all.skills.length, 20);
  assert.equal(all.nextOffset, 20);
  assert.equal((await f.call({ query: '*', offset: 20 })).skills.length, 1);
  const fallback = await f.call({ query: 'animation', source: 'supplemental', reason: 'Native catalog lacks the requested format.' });
  assert.equal(fallback.state, 'no_matches');
  assert.equal(fallback.catalogTotal, 1);
  const receipt = JSON.parse(await readFile(join(f.root, 'receipt.json'), 'utf8'));
  assert.equal(receipt.searches.at(-1).catalogTotal, 1);
});

test('empty and incomplete catalogs are distinct; a returned native search permits an explained fallback', async t => {
  const empty = await toolFixture(t, { skills: [], complete: true });
  assert.equal((await empty.call({ query: '*' })).state, 'empty');
  const partial = await toolFixture(t, { skills: [], complete: false });
  const result = await partial.call({ query: '*' });
  assert.equal(result.state, 'incomplete');
  assert.equal(result.complete, false);
  assert.equal(result.searchCompleted, true);
  await assert.rejects(partial.call({ query: '*', source: 'supplemental' }), /explain/);
  const fallback = await partial.call({ query: '*', source: 'supplemental', reason: 'Native coverage is incomplete and observed results do not fit.' });
  assert.equal(fallback.state, 'incomplete');
  assert.equal(fallback.searchCompleted, true);
  const receipt = JSON.parse(await readFile(join(partial.root, 'receipt.json'), 'utf8'));
  assert.equal(receipt.searches[0].searchCompleted, true);
  assert.equal(receipt.searches[0].complete, false);
});

test('a failed native search that never returned does not authorize supplemental fallback', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-search-failed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = new Map();
  const disposers = [];
  t.after(async () => { for (const dispose of disposers.reverse()) await dispose?.(); });
  await apply({ effect: fn => disposers.push(fn()), tools: { register: tool => tools.set(tool.name, tool) }, skills: {
    registerProvider: () => () => {}, snapshot: async () => { throw new Error('catalog read failed'); },
  } }, { workspace: root, nonce: 'failed-search', receiptPath: join(root, 'receipt.json') });
  const call = args => tools.get('bridge_skill_search').execute(args, {});
  await assert.rejects(call({ query: '*' }), /catalog read failed/);
  await assert.rejects(call({ query: '*', source: 'supplemental', reason: 'Native search failed.' }), /native search first/);
});

async function presetFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'native-preset-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const skills = join(root, 'skills');
  await mkdir(join(skills, 'composition'), { recursive: true });
  await writeFile(join(skills, 'composition', 'SKILL.md'), '---\nname: composition\ndescription: Cordis native composition\n---\nPRIVATE_SKILL_BODY');
  const observations = [];
  const provider = await createPresetSkillProvider(skills, value => observations.push(value));
  t.after(() => provider.dispose());
  return { root, skills, provider, observations };
}

test('official preset metadata is native, bodies load only on selection, and forged paths are rejected', async t => {
  const f = await presetFixture(t);
  const candidates = await f.provider.list({});
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].source, 'custom');
  assert.equal(JSON.stringify(candidates).includes('PRIVATE_SKILL_BODY'), false);
  assert.equal((await f.provider.get(candidates[0], {})).content, 'PRIVATE_SKILL_BODY');
  assert.equal(await f.provider.get({ ...candidates[0], path: join(f.root, 'outside.md') }, {}), undefined);
  await rm(f.skills, { recursive: true });
  await assert.rejects(f.provider.list({}));
  assert.equal(f.observations.at(-1).state, 'unavailable');
});

test('preset source does not follow directory links or a skill replaced by a link', async t => {
  const f = await presetFixture(t);
  const candidates = await f.provider.list({});
  const outside = join(f.root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'SKILL.md'), '---\nname: escaped\ndescription: outside\n---\nESCAPED');
  await symlink(outside, join(f.skills, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await f.provider.list({})).length, 1);
  await rm(join(f.skills, 'composition'), { recursive: true });
  await symlink(outside, join(f.skills, 'composition'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.provider.get(candidates[0], {}), /links are not allowed|escaped/);
});

test('preset parse errors remain incomplete instead of becoming an empty catalog', async t => {
  const f = await presetFixture(t);
  await writeFile(join(f.skills, 'composition', 'SKILL.md'), 'invalid frontmatter');
  const result = await f.provider.list({});
  assert.deepEqual(result, { candidates: [], complete: false });
  assert.equal(f.observations.at(-1).state, 'incomplete');
});

test('preset package resolution records installed versus explicit pinned SDK origin', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-preset-resolve-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const managerCore = join(root, 'manager', 'lib', 'core.js');
  const missing = await presetSkillRoot(managerCore);
  assert.equal(missing.origin, 'bridge-sdk');
  assert.equal(missing.installedPreset, 'not_resolved');
  const pkg = join(root, 'node_modules', '@deepseek-ai', 'dsh-agent-preset');
  await mkdir(pkg, { recursive: true });
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-agent-preset', version: 'fixture' }));
  const installed = await presetSkillRoot(managerCore);
  assert.equal(installed.origin, 'installed-profile');
  assert.equal(installed.version, 'fixture');
});

for (const nativeRoot of [true, false]) test(`manager diagnostics keep unavailable ${nativeRoot ? 'native' : 'supplemental'} roots separate`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-manager-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const core = join(root, 'manager.mjs');
  const unavailableRoot = join(root, 'not-a-directory');
  await writeFile(unavailableRoot, 'fixture');
  await writeFile(core, `export async function listProviderCandidates(){ return []; }
    export async function getProviderSkill(){ return undefined; }
    export async function readManagerState(){ return {writable:true}; }
    export function userRoots(){ return [{key:'dsh',path:${JSON.stringify(unavailableRoot)},native:${nativeRoot}}]; }
    export async function projectRoots(){ return []; }`);
  const providers = [];
  const disposers = [];
  t.after(async () => { for (const dispose of disposers.reverse()) await dispose?.(); });
  const tools = new Map();
  await apply({ effect: fn => { disposers.push(fn()); }, tools: { register: tool => tools.set(tool.name, tool) }, skills: {
    registerProvider: create => { providers.push(create()); return () => {}; },
    snapshot: async () => {
      const observations = await Promise.all(providers.map(provider => provider.list({ cwd: root })));
      return { skills: observations.flatMap(item => Array.isArray(item) ? item : item.candidates),
        complete: observations.every(item => Array.isArray(item) || item.complete) };
    },
  } }, { workspace: root, inventoryHome: root, managerCore: core,
    managerCoreSha256: createHash('sha256').update(await readFile(core)).digest('hex'), nonce: 'manager', receiptPath: join(root, 'receipt.json') });
  const result = JSON.parse(await tools.get('bridge_skill_search').execute({ query: '*' }, {}));
  assert.equal(result.state, nativeRoot ? 'incomplete' : 'available');
  assert.equal(result.complete, !nativeRoot);
  assert.equal(result.sources.manager.state, 'incomplete');
  assert.equal(result.sources.manager.count, 0);
  assert.equal(result.sources.manager.roots[0].state, 'unavailable');
  assert.equal(result.sources.manager.rootAvailability[nativeRoot ? 'native' : 'supplemental'], false);
  assert.equal(result.sources.manager.catalogCoverage[nativeRoot ? 'native' : 'supplemental'], 'unavailable');
});

for (const swallowed of ['nested-read-error', 'malformed-header', 'depth-truncated']) {
  test(`a readable manager root with ${swallowed} cannot prove an empty complete catalog`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'native-manager-nested-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const skillRoot = join(root, 'skills');
    const doc = join(skillRoot, ...Array(swallowed === 'depth-truncated' ? 8 : 1).fill('nested'), 'SKILL.md');
    await mkdir(join(doc, '..'), { recursive: true });
    await writeFile(doc, swallowed === 'malformed-header' ? 'invalid frontmatter'
      : '---\nname: animation\ndescription: SVG animation\n---\nfixture body');
    const core = join(root, 'manager.mjs');
    // Match the public contract of a manager that swallows nested failures or
    // stops traversal at depth six without exposing diagnostics to its provider.
    await writeFile(core, `import { readFile, readdir } from 'node:fs/promises';
      export async function listProviderCandidates(){
        try {
          ${swallowed === 'nested-read-error' ? "throw Object.assign(new Error('nested read denied'), {code:'EACCES'});"
    : swallowed === 'malformed-header' ? `if (!(await readFile(${JSON.stringify(doc)}, 'utf8')).startsWith('---')) throw new SyntaxError('invalid metadata');`
      : `let path=${JSON.stringify(skillRoot)}; for(let depth=0;depth<6;depth++){ const names=await readdir(path); path += '/'+names[0]; }`}
        } catch {}
        return [];
      }
      export async function getProviderSkill(){return undefined;}
      export async function readManagerState(){return {writable:true};}
      export function userRoots(){return [{key:'dsh',path:${JSON.stringify(skillRoot)},native:true}];}
      export async function projectRoots(){return [];}`);
    const providers = [];
    const tools = new Map();
    const disposers = [];
    t.after(async () => { for (const dispose of disposers.reverse()) await dispose?.(); });
    await apply({ effect: fn => disposers.push(fn()), tools: { register: tool => tools.set(tool.name, tool) }, skills: {
      registerProvider: create => { providers.push(create()); return () => {}; },
      snapshot: async () => {
        const observations = await Promise.all(providers.map(provider => provider.list({ cwd: root })));
        return { skills: observations.flatMap(item => Array.isArray(item) ? item : item.candidates),
          complete: observations.every(item => Array.isArray(item) || item.complete) };
      },
    } }, { workspace: root, inventoryHome: root, managerCore: core,
      managerCoreSha256: createHash('sha256').update(await readFile(core)).digest('hex'), nonce: swallowed, receiptPath: join(root, 'receipt.json') });
    const call = async args => JSON.parse(await tools.get('bridge_skill_search').execute(args, {}));
    const result = await call({ query: 'animation' });
    assert.equal(result.searchCompleted, true);
    assert.equal(result.complete, false);
    assert.equal(result.state, 'incomplete');
    assert.equal(result.total, 0);
    assert.equal(result.sources.manager.count, 0);
    assert.equal(result.sources.manager.rootAvailability.native, true);
    assert.equal(result.sources.manager.scanCompleteness.native, 'unverified');
    assert.equal(result.sources.manager.completeBySource.native, false);
    assert.equal(result.sources.manager.roots[0].state, 'present');
    const fallback = await call({ query: '*', source: 'supplemental', reason: 'Native manager scan coverage is unverified; observed native results do not cover animation.' });
    assert.equal(fallback.searchCompleted, true);
  });
}
