#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isAbsolute, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readCompleteResult, ResultReadError } from '../src/result-reader.js';
import { localConfig } from '../src/local-config.js';

export async function main(args = process.argv.slice(2)) {
  const positional = args.filter(arg => arg !== '--json');
  if (positional.length < 1 || positional.length > 2 || args.filter(arg => arg === '--json').length > 1) {
    throw new Error('Usage: node scripts/read-result.js TASK_UUID [ATTEMPT] [--json]');
  }
  const taskId = positional[0];
  const attempt = positional.length === 2 ? Number(positional[1]) : undefined;
  // Apply launch.js's state-directory precedence without loading/decrypting its
  // execution credential. Observation uses the caller's already selected Node.
  const config = await localConfig();
  if (config.dataDir && (typeof config.dataDir !== 'string' || !isAbsolute(config.dataDir))) {
    throw new Error('Configured dataDir must be absolute.');
  }
  const env = { ...getDefaultEnvironment(), ...process.env };
  if (config.dataDir) env.DSH_BRIDGE_DATA_DIR ||= config.dataDir;
  // The worker environment and all credentials stay in the environment. Arguments
  // contain only the existing task identity; this program never submits work.
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../index.js', import.meta.url))],
    env, stderr: 'pipe' });
  // Drain diagnostics without forwarding provider/runtime stderr to the parent.
  transport.stderr.resume();
  const client = new Client({ name: 'bridge-result-reader', version: '1' });
  try {
    await client.connect(transport);
    const result = await readCompleteResult(request => client.callTool(request), { taskId, attempt, parseJson: args.includes('--json') });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally { await client.close(); await transport.close(); }
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
