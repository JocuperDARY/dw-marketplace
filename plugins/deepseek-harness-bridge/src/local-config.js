import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { readFile } from 'node:fs/promises';
import { requireValue } from './errors.js';

export function configurationDirectory(env = process.env) {
  return env.DSH_BRIDGE_CONFIG_DIR || join(env.LOCALAPPDATA || homedir(), 'DeepSeekHarnessBridge');
}

export async function localConfig(env = process.env) {
  const directory = configurationDirectory(env);
  requireValue(isAbsolute(directory), 'INVALID_CONFIG', 'The local configuration directory must be absolute.');
  try {
    const content = await readFile(join(directory, 'config.json'), 'utf8');
    requireValue(Buffer.byteLength(content) <= 65536, 'INVALID_CONFIG', 'Local configuration exceeds 64 KiB.');
    const config = JSON.parse(content);
    requireValue(config && typeof config === 'object' && !Array.isArray(config), 'INVALID_CONFIG', 'Invalid local configuration.');
    return config;
  } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
