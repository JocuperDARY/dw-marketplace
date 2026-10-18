import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { VERSION } from '../src/server.js';
import { SDK_VERSION } from '../src/sdk-runner.js';
import { doctor } from '../index.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const json = async path => JSON.parse(await readFile(join(root, path), 'utf8'));

test('package, plugin manifests, runtime and source marketplace versions agree', async () => {
  const pkg = await json('package.json');
  assert.ok(pkg.files.includes('npm-shrinkwrap.json'));
  const portable = await json('plugin.json');
  assert.equal(portable.name, pkg.name);
  assert.equal(portable.version, pkg.version);
  assert.equal(portable.extensions['com.openai'].requires_local_executor, true);
  await access(join(root, portable.extensions['com.openai'].onboardingSkill));
  for (const name of ['plugin.json', 'mcp.json']) assert.ok(pkg.files.includes(name));
  const native = await json('.codex-plugin/plugin.json');
  const compatible = await json('.claude-plugin/plugin.json');
  for (const manifest of [native, compatible]) {
    assert.equal(manifest.name, pkg.name);
    assert.equal(manifest.version, pkg.version);
    assert.equal(manifest.skills, './skills/');
    await access(join(root, manifest.mcpServers));
  }
  assert.equal(VERSION, pkg.version);
  assert.equal((await doctor({})).version, pkg.version);
  assert.equal(SDK_VERSION, pkg.dependencies['@deepseek-ai/dsh-sdk-client']);
  assert.equal(native.requires_local_executor, true);
  const lock = await json('npm-shrinkwrap.json');
  assert.equal(lock.version, pkg.version);
  assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
  assert.equal(lock.packages['node_modules/@deepseek-ai/dsh'].version, SDK_VERSION);
  // The marketplace is outside the distributed plugin package.
  let marketplace;
  try { marketplace = await json('../../.claude-plugin/marketplace.json'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (marketplace) {
    const entry = marketplace.plugins.find(plugin => plugin.name === pkg.name);
    assert.equal(entry.version, pkg.version);
    assert.equal(entry.source, `./plugins/${pkg.name}`);
  }
});

test('portable Codex MCP entry uses supported fields and expands the plugin root', async () => {
  const config = await json('mcp.json');
  assert.equal(config.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
  const mcp = config.mcpServers['deepseek-harness-bridge'];
  assert.deepEqual(Object.keys(mcp).sort(), ['args', 'command', 'cwd', 'type']);
  assert.equal(mcp.type, 'stdio');
  assert.equal(mcp.command, 'node');
  assert.equal(mcp.cwd, '${PLUGIN_ROOT}');
  assert.deepEqual(mcp.args, ['${PLUGIN_ROOT}/launch.js']);
  await access(join(root, mcp.args[0].replace('${PLUGIN_ROOT}/', '')));
  const manifest = await json('plugin.json');
  assert.equal(manifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.ok(Array.isArray(manifest.extensions['com.openai'].interface.defaultPrompt));
});

test('MCP entry, onboarding and packaged skill references resolve without shell wrappers', async () => {
  const native = await json('.codex-plugin/plugin.json');
  const mcp = (await json('.mcp.json')).mcpServers['deepseek-harness-bridge'];
  assert.equal(mcp.command, 'node');
  assert.deepEqual(mcp.args, ['${CLAUDE_PLUGIN_ROOT}/launch.js']);
  assert.ok(mcp.env_vars.includes('DEEPSEEK_API_KEY'));
  assert.ok(mcp.env_vars.includes('DSH_BRIDGE_DATA_DIR'));
  assert.ok(mcp.tool_timeout_sec > 30);
  await access(join(root, native.extensions['com.openai'].onboardingSkill, 'SKILL.md'));
  for (const name of ['deepseek-setup', 'deepseek-delegate']) {
    const skill = await readFile(join(root, 'skills', name, 'SKILL.md'), 'utf8');
    assert.ok(skill.replaceAll('\r\n', '\n').startsWith(`---\nname: ${name}\n`));
    assert.ok(skill.includes('../../README.md'));
  }
  const readme = await readFile(join(root, 'README.md'), 'utf8');
  assert.ok(readme.includes((await json('package.json')).version));
  await access(join(root, 'docs', 'design.md'));
});
