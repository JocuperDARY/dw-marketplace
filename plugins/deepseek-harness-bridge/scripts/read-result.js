#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readCompleteResult, ResultReadError } from '../src/result-reader.js';
import { withResultClient } from '../src/readonly-client.js';

export async function main(args = process.argv.slice(2)) {
  const positional = args.filter(arg => arg !== '--json');
  if (positional.length < 1 || positional.length > 2 || args.filter(arg => arg === '--json').length > 1) {
    throw new Error('Usage: node scripts/read-result.js TASK_UUID [ATTEMPT] [--json]');
  }
  const taskId = positional[0];
  const attempt = positional.length === 2 ? Number(positional[1]) : undefined;
  const result = await withResultClient(callTool => readCompleteResult(callTool, { taskId, attempt, parseJson: args.includes('--json') }));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    const known = error instanceof ResultReadError;
    process.stderr.write(`${JSON.stringify({ error: { code: known ? error.code : 'RESULT_READ_FAILED',
      category: known ? error.category : 'read', message: known ? error.message : 'Result reader failed; check arguments and the bridge connection.' },
      ...(error.partial ? { partial: error.partial } : {}), ...(error.result ? { result: error.result } : {}) })}\n`);
    process.exitCode = 1;
  });
}
