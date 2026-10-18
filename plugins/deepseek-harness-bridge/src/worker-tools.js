import { defineTool } from '@deepseek-ai/dsh-tools';
import { WorkspaceFiles } from './workspace.js';
import { safeError } from './errors.js';
import { writeFile } from 'node:fs/promises';

export const name = 'deepseek-bridge-files';
export const inject = ['tools'];

export async function apply(ctx, config) {
  const files = new WorkspaceFiles(config);
  const allowed = config.access === 'workspace-write' ? ['bridge_list', 'bridge_read', 'bridge_write'] : ['bridge_list', 'bridge_read'];
  let calls = 0;
  ctx.on('tools/pre-execute', (exec, next) => {
    if (!allowed.includes(exec.name)) return { kind: 'deny', reason: 'This tool is outside the bridge capability set.' };
    if (++calls > config.maxToolCalls) return { kind: 'deny', reason: 'The bridge tool call budget is exhausted.' };
    return next();
  });
  const path = { type: 'string', required: true, description: 'Relative workspace path; no parent traversal, links or credential/config directories.' };
  const register = (name, description, parameters, run) => ctx.tools.register(defineTool({
    name, description, parameters,
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      try { return JSON.stringify(await run(args, exec.signal)); }
      catch (error) { return JSON.stringify({ error: safeError(error) }); }
    },
  }));
  register('bridge_list', 'List at most 1000 entries in one workspace directory.', { path }, (args, signal) => files.list(args.path, signal));
  register('bridge_read', 'Read a UTF-8 file up to 256 KiB and its sha256.', { path }, (args, signal) => files.read(args.path, signal));
  if (config.access === 'workspace-write') register('bridge_write', 'Create or replace a bounded text file. Existing contents are backed up. Supply the sha256 from bridge_read, or new for creation.', {
    path, text: { type: 'string', required: true }, expectedSha256: { type: 'string', required: true },
  }, (args, signal) => files.write(args.path, args.text, args.expectedSha256, signal));
  await writeFile(config.receiptPath, JSON.stringify({ nonce: config.nonce, tools: ctx.tools.schemas().map(tool => tool.name).sort() }), { mode: 0o600 });
}
