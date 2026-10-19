import { defineTool } from '@deepseek-ai/dsh-tools';
import { WorkspaceFiles } from './workspace.js';
import { safeError } from './errors.js';
import { writeFile, rename } from 'node:fs/promises';

export const name = 'deepseek-bridge-files';
export const inject = ['tools', 'llm'];

export async function apply(ctx, config) {
  const files = new WorkspaceFiles(config);
  const allowed = [...(config.fileTools === false ? [] : config.access === 'workspace-write' ? ['bridge_list', 'bridge_read', 'bridge_write'] : ['bridge_list', 'bridge_read']), ...(config.extraTools || [])];
  const currentTools = () => ctx.tools.schemas().map(tool => tool.name).sort();
  const expected = JSON.stringify([...allowed].sort());
  let publication = Promise.resolve();
  let publicationError;
  let calls = 0;
  const usedTools = new Set();
  const toolOutcomes = {};
  let mismatch = null;
  const publish = () => {
    // The SDK can finish a preparation/dispatch failure without post-execute.
    // Preserve the missing outcome instead of dropping the attempted call.
    const outcomes = Object.fromEntries(Object.entries(toolOutcomes).map(([name, counts]) => [name,
      { ...counts, unobserved: Math.max(0, counts.attempted - counts.returned - counts.error) }]));
    const content = JSON.stringify({ nonce: config.nonce, tools: currentTools(), toolCalls: calls, usedTools: [...usedTools].sort(), toolOutcomes: outcomes, mismatch });
    publication = publication.then(async () => {
      await writeFile(`${config.receiptPath}.tmp`, content, { mode: 0o600 });
      await rename(`${config.receiptPath}.tmp`, config.receiptPath);
    }).catch(error => { publicationError = error; });
    return publication;
  };
  ctx.on('tools/change', () => { void publish(); });
  ctx.on('llm/stream', async function* (_options, next) {
    await publication;
    if (publicationError || JSON.stringify(currentTools()) !== expected) {
      mismatch = currentTools();
      await publish();
      throw new Error('Bridge capabilities changed before model dispatch.');
    }
    yield* next();
  }, { prepend: true });
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!allowed.includes(exec.name)) return { kind: 'deny', reason: 'This tool is outside the bridge capability set.' };
    if (config.maxToolCalls != null && calls >= config.maxToolCalls) return { kind: 'deny', reason: 'The explicit bridge tool call budget is exhausted.' };
    calls++;
    usedTools.add(exec.name);
    (toolOutcomes[exec.name] ??= { attempted: 0, returned: 0, error: 0 }).attempted++;
    await publish();
    if (publicationError) return { kind: 'deny', reason: 'The bridge tool receipt could not be saved.' };
    return next();
  }, { prepend: true });
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next();
    const status = result.isError || decision.kind === 'block' ? 'error' : 'returned';
    const counts = toolOutcomes[exec.name] ??= { attempted: 0, returned: 0, error: 0 };
    counts[status]++;
    await publish();
    if (publicationError) throw new Error('The bridge tool outcome receipt could not be saved.');
    return decision;
  }, { prepend: true });
  const path = { type: 'string', required: true, description: 'Relative workspace path; no parent traversal, links or known protected metadata/credential names. Ordinary file contents are not scanned for secrets.' };
  const register = (name, description, parameters, run) => ctx.tools.register(defineTool({
    name, description, parameters,
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      try { return JSON.stringify(await run(args, exec.signal)); }
      catch (error) { return JSON.stringify({ error: safeError(error) }); }
    },
  }));
  if (config.fileTools !== false) {
    register('bridge_list', 'List at most 1000 entries in one workspace directory.', { path }, (args, signal) => files.list(args.path, signal));
    register('bridge_read', 'Read a page of at most 16384 UTF-16 characters from a UTF-8 file up to 256 KiB. sha256 covers the whole file; use nextOffset for more pages.',
      { path, offset: { type: 'number', description: 'Optional nonnegative UTF-16 character offset, default 0.' } }, (args, signal) => files.read(args.path, signal, args.offset));
    if (config.access === 'workspace-write') register('bridge_write', 'Create or replace a bounded text file. Existing contents are backed up. Supply the sha256 from bridge_read, or new for creation.', {
    path, text: { type: 'string', required: true }, expectedSha256: { type: 'string', required: true },
    }, (args, signal) => files.write(args.path, args.text, args.expectedSha256, signal));
  }
  await publish();
  if (publicationError) throw new Error('Bridge capability receipt could not be saved.');
}
