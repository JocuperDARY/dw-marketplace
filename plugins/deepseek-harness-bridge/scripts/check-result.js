#!/usr/bin/env node
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withResultClient } from '../src/readonly-client.js';
import { checkResultSchema, normalizeEvidenceChecks } from '../src/parent-evidence.js';
import { BridgeError, safeError } from '../src/errors.js';

export async function main(args = process.argv.slice(2)) {
  if (args.length !== 3) throw new BridgeError('INVALID_ARGUMENT', 'Usage: node scripts/check-result.js TASK_UUID ATTEMPT CHECKS_JSON_FILE');
  const file = await open(args[2], 'r');
  let checks;
  try {
    const size = (await file.stat()).size;
    if (size > 32768) throw new BridgeError('INVALID_ARGUMENT', 'Checks file must not exceed 32768 bytes.');
    const bytes = Buffer.alloc(32769);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 32768) throw new BridgeError('INVALID_ARGUMENT', 'Checks file must not exceed 32768 bytes.');
    checks = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
  } finally { await file.close(); }
  const input = checkResultSchema.parse({ taskId: args[0], attempt: Number(args[1]), checks });
  normalizeEvidenceChecks(checks);
  const result = await withResultClient(async callTool => {
    const response = await callTool({ name: 'dsh_check_result', arguments: input });
    if (response.isError || !response.structuredContent) throw new Error('Result checker observation failed.');
    return response.structuredContent;
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== 'checks_passed') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`${JSON.stringify({ error: safeError(error) })}\n`); process.exitCode = 1; });
}
