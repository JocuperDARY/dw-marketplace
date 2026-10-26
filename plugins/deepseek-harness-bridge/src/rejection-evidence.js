import { createHash } from 'node:crypto';
import { lstat, mkdir, open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { atomicWrite } from './concurrent-store.js';
import { BridgeError, requireValue } from './errors.js';
import { payloadSha256Schema } from './payload.js';

export const rejectionSchema = z.object({
  requestId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/),
  payloadSha256: payloadSha256Schema,
  taskId: z.null().describe('Only a parent-reported rejection before receiving any task receipt may be recorded here.'),
  reason: z.enum(['host-approval-rejected', 'invalid-arguments']),
}).strict();
const savedSchema = z.object({ version: z.literal(1), reportedAt: z.string().datetime(), report: rejectionSchema }).strict();

async function readReport(path) {
  const before = await lstat(path);
  requireValue(before.isFile() && !before.isSymbolicLink(), 'INVALID_REJECTION_RECORD', 'The rejection evidence record is invalid.');
  const handle = await open(path, 'r');
  try {
    const current = await handle.stat();
    requireValue(current.isFile() && current.ino === before.ino && current.dev === before.dev,
      'INVALID_REJECTION_RECORD', 'The rejection evidence record changed.');
    const buffer = Buffer.alloc(4097);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    let parsed;
    if (length <= 4096) try { parsed = savedSchema.safeParse(JSON.parse(buffer.subarray(0, length).toString('utf8'))); } catch { /* Invalid persisted evidence must not be echoed. */ }
    requireValue(parsed?.success, 'INVALID_REJECTION_RECORD', 'The rejection evidence record is invalid.');
    return parsed.data;
  } finally { await handle.close(); }
}

// Metadata only. This never opens TaskManager, task registries or execution leases.
export async function recordRejection(input, { dataDir }) {
  const parsed = rejectionSchema.safeParse(input);
  if (!parsed.success) throw new BridgeError('INVALID_ARGUMENT', 'Arguments do not match the rejection schema.', {
    validation: { phase: 'schema', issues: parsed.error.issues },
  });
  requireValue(typeof dataDir === 'string' && isAbsolute(dataDir), 'INVALID_CONFIG', 'The bridge data directory must be absolute.');
  const report = parsed.data;
  const directory = join(dataDir, 'rejections-v1');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  requireValue(info.isDirectory() && !info.isSymbolicLink(), 'INVALID_REJECTION_RECORD', 'The rejection evidence directory is invalid.');
  const reportId = createHash('sha256').update(report.requestId).digest('hex');
  const path = join(directory, `${reportId}.json`);
  let saved = { version: 1, reportedAt: new Date().toISOString(), report };
  let duplicate = false;
  try { await atomicWrite(path, JSON.stringify(saved), { immutable: true }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    saved = await readReport(path);
    requireValue(JSON.stringify(saved.report) === JSON.stringify(report), 'REJECTION_CONFLICT', 'This request ID already has different rejection evidence. Preserve it and use the actual distinct request ID.');
    duplicate = true;
  }
  return { kind: 'parent-reported-rejection', reportId, reportedAt: saved.reportedAt, ...report, duplicate,
    reporter: 'parent', admission: 'reported-not-admitted', independentlyVerified: false,
    destination: { provider: 'deepseek-official', model: 'deepseek-flash' }, modelUsage: null,
    usageIncluded: false, generationQualityIncluded: false, validation: { modelCalls: 0, workerStarts: 0 },
  };
}
