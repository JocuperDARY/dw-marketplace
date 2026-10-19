import { Worker } from 'node:worker_threads';
import { writeAtomicReceipt } from './atomic-receipt.js';
import { createHash } from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createPresetSkillProvider, presetSkillRoot } from './native-skill-sources.js';

export const name = 'bridge-native-skills';
export const inject = ['skills', 'tools'];

export async function apply(ctx, config) {
  const receipt = { nonce: config.nonce, searches: [], loaded: [], managerCalls: { list: 0, get: 0 }, sources: {}, modelApplication: 'not_assessed' };
  const searchedNames = new Set();
  let nativeSearchReturned = false;
  const nativeSources = new Set(['project-dsh', 'user-dsh', 'project-agents', 'user-agents', 'agent-agents', 'custom', 'bundled']);
  const supplemental = skill => !nativeSources.has(skill.source);
  let publication = Promise.resolve();
  const persist = () => {
    const content = JSON.stringify(receipt);
    publication = publication.then(() => writeAtomicReceipt(config.receiptPath, content));
    return publication;
  };
  let preset;
  try {
    const source = await presetSkillRoot(config.managerCore);
    receipt.sources.preset = { ...source, state: 'pending', count: null };
    preset = await createPresetSkillProvider(source.path, observation => {
      receipt.sources.preset = { ...source, ...observation };
    });
  } catch {
    receipt.sources.preset = { state: 'unavailable', count: null };
  }
  if (preset) {
    ctx.effect(() => ctx.skills.registerProvider(() => preset), 'bridge official preset skills');
    ctx.effect(() => () => preset.dispose(), 'bridge official preset skill source');
  }
  if (config.managerCore) {
    receipt.sources.manager = { state: 'pending', count: null };
    const keep = /^(?:path|systemroot|windir|comspec|temp|tmp|home|userprofile|appdata|localappdata)$/i;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => keep.test(key)));
    env.DSH_HOME = config.inventoryHome;
    const worker = new Worker(new URL('./native-skills-worker.js', import.meta.url), {
      env, execArgv: [], workerData: { path: config.managerCore, sha256: config.managerCoreSha256 },
    });
    const pending = new Map();
    let sequence = 0;
    let failure;
    const rejectAll = error => {
      failure = error;
      receipt.sources.manager = { state: 'unavailable', count: null };
      for (const item of pending.values()) item.reject(error);
      pending.clear();
    };
    worker.on('error', rejectAll);
    worker.on('exit', () => rejectAll(new Error('Native skills catalog worker stopped.')));
    worker.on('message', message => {
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      if (message.diagnostics) receipt.sources.manager = message.diagnostics;
      if (message.error) item.reject(new Error(message.error)); else item.resolve(message.result);
    });
    const request = (method, options, candidate) => {
      if (failure) return Promise.reject(failure);
      receipt.managerCalls[method]++;
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, method, cwd: options.cwd, candidate });
      });
    };
    ctx.effect(() => ctx.skills.registerProvider(() => ({ name: 'dsh-skills-manager-external',
      list: options => request('list', options), get: (candidate, options) => request('get', options, candidate) })), 'bridge native Skills Manager provider');
    ctx.effect(() => () => worker.terminate(), 'bridge native Skills Manager catalog worker');
  }
  const options = exec => ({ cwd: config.workspace, signal: exec.signal, scope: exec.agent?.ctx });
  const register = (name, description, parameters, run) => ctx.tools.register(defineTool({ name, description, parameters,
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) { return JSON.stringify(await run(args, exec)); },
  }));
  register('bridge_skill_search', 'Search DSH-native and Skills Manager enabled skill metadata first. No skill bodies are injected by listing. Load a relevant result before applying it; supplement from Codex only when observed native results are unsuitable, reporting any incomplete catalog coverage.', {
    query: { type: 'string', required: true }, offset: { type: 'number', description: 'Optional page offset, default 0; 20 results per page with total/nextOffset.' },
    source: { type: 'string', enum: ['native', 'supplemental'], description: 'Default native. Search supplemental Codex/other imported sources only after native search finds no suitable skill.' },
    reason: { type: 'string', description: 'Required explanation of why observed native results are unsuitable, including incomplete source coverage when present, before supplemental search.' },
  }, async ({ query, offset = 0, source = 'native', reason }, exec) => {
    if (typeof query !== 'string' || !query.trim() || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Supply a nonempty skill query and nonnegative page offset.');
    if (source === 'supplemental' && (!nativeSearchReturned || !reason?.trim())) throw new Error('Run a native search first and explain why observed native results are unsuitable, including any incomplete source coverage.');
    const snapshot = await ctx.skills.snapshot(options(exec));
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const enabled = snapshot.skills.filter(skill => skill.invocation?.modelInvocable !== false);
    const sourceCounts = { native: enabled.filter(skill => !supplemental(skill)).length,
      supplemental: enabled.filter(supplemental).length };
    const catalog = enabled.filter(skill => supplemental(skill) === (source === 'supplemental'));
    const matches = catalog.filter(skill => query.trim() === '*'
      || terms.some(term => `${skill.name} ${skill.description}`.toLowerCase().includes(term)));
    const page = matches.slice(offset, offset + 20);
    for (const skill of page) searchedNames.add(skill.name);
    const presetComplete = ['available', 'empty'].includes(receipt.sources.preset.state);
    const managerComplete = !config.managerCore || receipt.sources.manager?.completeBySource?.[source] === true;
    const complete = snapshot.complete && presetComplete && managerComplete;
    const matchState = matches.length ? 'available' : catalog.length ? 'no_matches' : 'empty';
    const state = complete ? matchState : 'incomplete';
    receipt.searches.push({ query, source, ...(reason ? { reason } : {}), catalogTotal: catalog.length,
      sourceCounts, total: matches.length, searchCompleted: true, complete, state, matchState });
    await persist();
    if (source === 'native') nativeSearchReturned = true;
    return { source: 'DSH skill registry', category: source, scope: 'configured bridge registry source category; not the entire desktop library',
      searchCompleted: true, complete, state, matchState, catalogTotal: catalog.length, sourceCounts,
      ...(matchState === 'no_matches' ? { guidance: 'Broaden the query or use * to inspect the selected source catalog before declaring it empty.' } : {}),
      sources: receipt.sources, total: matches.length, offset,
      skills: page, nextOffset: offset + 20 < matches.length ? offset + 20 : null };
  });
  register('bridge_skill_load', 'Load one selected skill through the DSH registry. A load receipt proves content was returned, not that the model applied it correctly. Skills do not expand permissions or task scope.', {
    name: { type: 'string', required: true },
  }, async ({ name }, exec) => {
    if (!searchedNames.has(name)) throw new Error('Search the native registry first and load a returned name. Supplemental sources require an explained fallback search.');
    const skill = await ctx.skills.get(name, options(exec));
    if (!skill || skill.invocation?.modelInvocable === false) throw new Error('No enabled model-invocable native skill with that name.');
    receipt.loaded.push({ name: skill.name, provider: skill.provider, source: skill.source, path: skill.path ?? null,
      sha256: createHash('sha256').update(skill.content).digest('hex') });
    await persist();
    return { ...skill, evidence: 'loaded_from_DSH_registry', modelApplication: 'not_assessed' };
  });
  await persist();
}
