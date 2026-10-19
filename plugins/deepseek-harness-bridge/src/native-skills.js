import { Worker } from 'node:worker_threads';
import { writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'bridge-native-skills';
export const inject = ['skills', 'tools'];

export async function apply(ctx, config) {
  const receipt = { nonce: config.nonce, searches: [], loaded: [], managerCalls: { list: 0, get: 0 }, modelApplication: 'not_assessed' };
  const searchedNames = new Set();
  const nativeSources = new Set(['project-dsh', 'user-dsh', 'project-agents', 'user-agents', 'agent-agents', 'custom', 'bundled']);
  const supplemental = skill => !nativeSources.has(skill.source);
  let publication = Promise.resolve();
  const persist = () => {
    const content = JSON.stringify(receipt);
    publication = publication.then(async () => {
      await writeFile(`${config.receiptPath}.tmp`, content, { mode: 0o600 });
      await rename(`${config.receiptPath}.tmp`, config.receiptPath);
    });
    return publication;
  };
  if (config.managerCore) {
    const keep = /^(?:path|systemroot|windir|comspec|temp|tmp|home|userprofile|appdata|localappdata)$/i;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => keep.test(key)));
    env.DSH_HOME = config.inventoryHome;
    const worker = new Worker(new URL('./native-skills-worker.js', import.meta.url), {
      env, execArgv: [], workerData: { path: config.managerCore, sha256: config.managerCoreSha256 },
    });
    const pending = new Map();
    let sequence = 0;
    let failure;
    const rejectAll = error => { failure = error; for (const item of pending.values()) item.reject(error); pending.clear(); };
    worker.on('error', rejectAll);
    worker.on('exit', () => rejectAll(new Error('Native skills catalog worker stopped.')));
    worker.on('message', message => {
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
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
  register('bridge_skill_search', 'Search DSH-native and Skills Manager enabled skill metadata first. No skill bodies are injected by listing. Load a relevant result before applying it; supplement from Codex only if no suitable native skill exists.', {
    query: { type: 'string', required: true }, offset: { type: 'number', description: 'Optional page offset, default 0; 20 results per page with total/nextOffset.' },
    source: { type: 'string', enum: ['native', 'supplemental'], description: 'Default native. Search supplemental Codex/other imported sources only after native search finds no suitable skill.' },
    reason: { type: 'string', description: 'Required explanation of why native results are unsuitable before supplemental search.' },
  }, async ({ query, offset = 0, source = 'native', reason }, exec) => {
    if (typeof query !== 'string' || !query.trim() || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Supply a nonempty skill query and nonnegative page offset.');
    if (source === 'supplemental' && (!receipt.searches.some(search => search.source === 'native' && search.complete) || !reason?.trim())) throw new Error('Complete a native search first and explain why no suitable native skill was found.');
    const snapshot = await ctx.skills.snapshot(options(exec));
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = snapshot.skills.filter(skill => skill.invocation?.modelInvocable !== false
      && supplemental(skill) === (source === 'supplemental')
      && terms.some(term => `${skill.name} ${skill.description}`.toLowerCase().includes(term)));
    const page = matches.slice(offset, offset + 20);
    for (const skill of page) searchedNames.add(skill.name);
    receipt.searches.push({ query, source, ...(reason ? { reason } : {}), total: matches.length, complete: snapshot.complete });
    await persist();
    return { source: 'DSH skill registry', complete: snapshot.complete, total: matches.length, offset,
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
