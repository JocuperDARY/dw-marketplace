import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { localConfig } from './local-config.js';

/** Observation-only CLI connection; never load/decrypt an execution credential. */
export async function withResultClient(observe) {
  const config = await localConfig();
  if (config.dataDir && (typeof config.dataDir !== 'string' || !isAbsolute(config.dataDir))) throw new Error('Configured dataDir must be absolute.');
  const env = { ...getDefaultEnvironment(), ...process.env };
  delete env.DEEPSEEK_API_KEY;
  if (config.dataDir) env.DSH_BRIDGE_DATA_DIR ||= config.dataDir;
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../index.js', import.meta.url))], env, stderr: 'pipe' });
  transport.stderr?.resume();
  const client = new Client({ name: 'bridge-result-observer', version: '1' });
  try {
    await client.connect(transport);
    return await observe(request => {
      if (!['dsh_result', 'dsh_check_result'].includes(request.name)) throw new Error('Only saved-result observation is permitted.');
      return client.callTool(request);
    });
  } finally { try { await client.close(); } finally { await transport.close(); } }
}
