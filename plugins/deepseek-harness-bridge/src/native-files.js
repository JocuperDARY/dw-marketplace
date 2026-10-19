import { createHash } from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { WorkspaceFiles } from './workspace.js';
import { requireValue, safeError } from './errors.js';

export const name = 'bridge-native-file-replacement';
export const inject = ['tools'];
const fields = ['path', 'pattern', 'replacement', 'expectedSha256'];

/** A single-file literal operation, not the third-party recursive ops API. */
export async function replaceWorkspaceText(files, args, signal) {
  requireValue(files.access === 'workspace-write', 'READ_ONLY', 'This task only has read access.');
  requireValue(args && typeof args === 'object' && !Array.isArray(args) &&
    Object.keys(args).every(key => fields.includes(key)) && fields.every(key => typeof args[key] === 'string'),
  'INVALID_ARGUMENT', 'Supply only path, pattern, replacement and expectedSha256 strings.');
  requireValue(args.pattern.length > 0 && Buffer.byteLength(args.pattern) <= 262144 &&
    Buffer.byteLength(args.replacement) <= 262144 && args.pattern.isWellFormed() && args.replacement.isWellFormed() &&
    !args.pattern.includes('\0') && !args.replacement.includes('\0'),
  'INVALID_ARGUMENT', 'Use a nonempty literal pattern and bounded UTF-8 replacement without NUL characters.');
  requireValue(/^[a-f0-9]{64}$/.test(args.expectedSha256), 'INVALID_ARGUMENT', 'Supply the whole-file sha256 from bridge_read.');
  signal?.throwIfAborted();
  // read() is paged. Read the bounded whole file so later pages are never lost.
  const bytes = await files.readBytes(await files.resolve(args.path));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  requireValue(sha256 === args.expectedSha256, 'FILE_CHANGED', 'File changed since it was read. Read it again before replacing.');
  requireValue(!bytes.includes(0), 'BINARY_FILE', 'Only UTF-8 text files are available.');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { requireValue(false, 'BINARY_FILE', 'Only UTF-8 text files are available.'); }
  const parts = text.split(args.pattern);
  const matched = parts.length - 1;
  signal?.throwIfAborted();
  if (!matched || args.pattern === args.replacement) return { path: args.path, matched, changed: 0, sha256, bytes: bytes.length };
  // Enforce the existing write size before allocating an expanded replacement.
  const nextBytes = bytes.length + matched * (Buffer.byteLength(args.replacement) - Buffer.byteLength(args.pattern));
  requireValue(nextBytes <= 262144, 'FILE_LIMIT', 'Replacement would exceed the 256 KiB file limit.');
  const result = await files.write(args.path, parts.join(args.replacement), sha256, signal);
  return { ...result, matched, changed: 1 };
}

export async function apply(ctx, config) {
  if (config.access !== 'workspace-write') return;
  const files = new WorkspaceFiles(config);
  ctx.tools.register(defineTool({
    name: 'ops_replace',
    description: 'Replace all literal matches in one existing workspace UTF-8 file up to 256 KiB. Use the whole-file sha256 from bridge_read. Relative paths only; protected names and links are denied. Creates a backup and refuses concurrent changes. No regex, glob, directory recursion or dryRun; this is a bridge adapter, not the dsh-ops recursive API.',
    parameters: {
      path: { type: 'string', required: true, description: 'Relative path to one ordinary workspace file.' },
      pattern: { type: 'string', required: true, description: 'Nonempty case-sensitive literal text to replace.' },
      replacement: { type: 'string', required: true, description: 'Literal replacement text; empty deletes matches. Dollar sequences have no special meaning.' },
      expectedSha256: { type: 'string', required: true, description: 'Whole-file lowercase SHA-256 from bridge_read.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      try { return JSON.stringify(await replaceWorkspaceText(files, args, exec.signal)); }
      catch (error) { return JSON.stringify({ error: safeError(error) }); }
    },
  }));
}
