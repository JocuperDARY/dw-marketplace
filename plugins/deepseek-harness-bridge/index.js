#!/usr/bin/env node
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFile, access } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { safeError } from './src/errors.js';

export function stateDirectory(env = process.env) {
  return resolve(env.DSH_BRIDGE_DATA_DIR || join(env.PLUGIN_DATA || env.CLAUDE_PLUGIN_DATA || homedir(), '.deepseek-harness-bridge'));
}

export async function doctor(env = process.env) {
  const dependencies = {};
  for (const name of ['@deepseek-ai/dsh-sdk-client', '@deepseek-ai/dsh', '@modelcontextprotocol/sdk']) {
    try {
      const url = name === '@modelcontextprotocol/sdk' ? new URL('./node_modules/@modelcontextprotocol/sdk/package.json', import.meta.url) : import.meta.resolve(`${name}/package.json`);
      dependencies[name] = JSON.parse(await readFile(new URL(url), 'utf8')).version;
    } catch { dependencies[name] = 'unavailable'; }
  }
  let ownerLockPresent = false;
  try { await access(join(stateDirectory(env), 'owner.lock')); ownerLockPresent = true; } catch (error) { if (error.code !== 'ENOENT') ownerLockPresent = 'unknown'; }
  const [major, minor] = process.versions.node.split('.').map(Number);
  return { plugin: 'deepseek-harness-bridge', version: '0.1.1', node: process.versions.node,
    nodeSupported: major > 24 || (major === 24 && minor >= 18), dependencies,
    credentialConfigured: Boolean(env.DEEPSEEK_API_KEY?.trim()), stateDirectory: stateDirectory(env), ownerLockPresent,
    route: { provider: 'deepseek-official', model: 'deepseek-flash', displayName: 'DeepSeek-V4.1-Flash (SDK catalog)' },
    tools: ['bounded-list', 'bounded-read', 'guarded-write'], maxActiveTasks: 1,
    validation: { modelCalls: 0, liveModel: 'NOT_RUN', codexHost: 'NOT_ASSESSED', desktopSessionReuse: false } };
}

export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--doctor') { process.stdout.write(`${JSON.stringify(await doctor(), null, 2)}\n`); return; }
  if (args.length) throw new Error('Unsupported arguments');
  const [{ StdioServerTransport }, { TaskManager }, { createSdkRunner, preflight }, { createServer }] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/stdio.js'), import('./src/tasks.js'), import('./src/sdk-runner.js'), import('./src/server.js'),
  ]);
  const manager = await new TaskManager({ dataDir: stateDirectory(), runner: createSdkRunner() }).open();
  const server = createServer({ manager, doctor, preflight });
  let shutdown;
  const stop = () => (shutdown ??= (async () => { await manager.close(); await server.close(); })());
  const onStop = () => { stop().catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT', onStop);
  process.once('SIGTERM', onStop);
  process.stdin.once('end', onStop);
  server.onclose = onStop;
  try { await server.connect(new StdioServerTransport()); }
  catch (error) { await stop(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`${JSON.stringify({ error: safeError(error) })}\n`); process.exitCode = 1; });
}
