import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireValue } from './errors.js';
import { validateNativeShellWorkspace } from './native-workspace.js';

const require = createRequire(import.meta.url);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const choices = ['skills', 'files', 'shell', 'teams'];
const teamTools = ['create', 'approve', 'edit_plan', 'add_member', 'remove_member', 'create_task', 'reassign_task', 'claim_task', 'update_task', 'amend_task', 'send_message', 'status', 'resume', 'delete'].map(name => `agent_teams_${name}`);

async function packageRoot(home, name) {
  for (const profile of ['desktop', 'web']) {
    const root = join(home, 'profiles', profile, 'node_modules', ...name.split('/'));
    try {
      const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
      return { root, name, version: pkg.version, profile };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return null;
}

/** Resolve installed components, not the desktop profile or saved conversations. */
export async function resolveNativeProfile(config, { workspace, requestedWorkspace, access = 'read-only', nativePlugins } = {}) {
  const selected = nativePlugins ?? (access === 'workspace-write' ? choices : ['skills', 'files']);
  requireValue(Array.isArray(selected) && selected.every(name => choices.includes(name)) && new Set(selected).size === selected.length,
    'INVALID_PROFILE', 'nativePlugins must contain unique skills/files/shell/teams names.');
  requireValue(access === 'workspace-write' || !selected.some(name => ['shell', 'teams'].includes(name)), 'PROFILE_ACCESS', 'Native shell and team state require workspace-write access; read-only access is retained.');
  if (selected.includes('shell') && process.platform === 'win32') await validateNativeShellWorkspace(requestedWorkspace ?? workspace);
  const home = config.inventoryHome || join(homedir(), '.dsh');
  requireValue(isAbsolute(home), 'INVALID_CONFIG', 'inventoryHome must be absolute.');
  const modules = [];
  const tools = [];
  const components = [];
  const add = async (path, names = [], settings = {}, extra = {}) => {
    path = await realpath(path);
    modules.push({ path, sha256: digest(await readFile(path)), tools: names, config: settings, native: true, ...extra });
    tools.push(...names);
  };
  const official = (name, names = [], settings = {}, extra = {}) => add(require.resolve(`@deepseek-ai/${name}`), names, settings, extra);
  if (selected.includes('skills')) {
    const manager = await packageRoot(home, '@michengai/dsh-skills-manager');
    const managerCore = manager ? join(manager.root, 'lib', 'core.js') : null;
    await official('dsh-skill');
    await official('dsh-skill-filesystem', [], { dshHome: home, agentsHome: join(homedir(), '.agents'), watch: false });
    await add(fileURLToPath(new URL('./native-skills.js', import.meta.url)), ['bridge_skill_search', 'bridge_skill_load'], {
      workspace, inventoryHome: home, managerCore,
      managerCoreSha256: managerCore ? digest(await readFile(managerCore)) : null,
    }, { skillReceipt: true });
    components.push({ capability: 'skills', implementation: manager ? `${manager.name}@${manager.version} provider plus official skill registry` : 'official skill filesystem registry', selected: true, runtimeVerified: false });
  }
  const ops = selected.some(name => ['files', 'shell'].includes(name)) ? await packageRoot(home, 'dsh-ops') : null;
  if (selected.includes('files')) {
    if (ops && process.platform === 'win32') {
      await add(join(ops.root, 'lib', 'components', 'file', 'index.js'), ['ops_inspect_local_file', 'ops_grep', 'ops_glob', 'ops_replace'], { required: true });
      components.push({ capability: 'files', implementation: `${ops.name}@${ops.version}`, selected: true, runtimeVerified: false });
    } else components.push({ capability: 'files', selected: false, reason: 'Compatible dsh-ops Windows package unavailable; bridge workspace files remain available.' });
  }
  if (selected.includes('shell')) {
    if (process.platform === 'win32') {
      await official('dsh-pwsh-sandbox', [], {}, { runtimeId: 'pwsh-sandbox' });
      await official('dsh-shell-env');
      await official('dsh-tool-pwsh', ['pwsh']);
      await official('dsh-tool-jobs', ['job_output', 'job_list', 'job_kill']);
      if (ops) await add(join(ops.root, 'lib', 'components', 'shell', 'index.js'), [], { publishBashTool: false });
      components.push({ capability: 'shell', implementation: 'official sandboxed PowerShell' + (ops ? ` with ${ops.name}@${ops.version} runtime selection` : ''), selected: true, runtimeVerified: false });
    } else components.push({ capability: 'shell', selected: false, reason: 'This native shell adapter currently targets Windows; it does not substitute an unconfined shell.' });
  }
  if (selected.includes('teams')) {
    const teams = await packageRoot(home, '@nanmicoder/dsh-agent-teams');
    if (teams) {
      await official('dsh-subagent');
      await official('dsh-subagent-spawn-in-process');
      await add(join(teams.root, 'lib', 'index.js'), teamTools, { memberProvider: 'spawn' }, { teamState: true });
      components.push({ capability: 'teams', implementation: `${teams.name}@${teams.version} with official in-process subagents`, selected: true, runtimeVerified: false });
    } else components.push({ capability: 'teams', selected: false, reason: 'Agent Teams is not installed in a supported profile.' });
  }
  const identity = { selected, access, modules, components };
  return { id: 'native', digest: digest(JSON.stringify(identity)), fileTools: true, access,
    modules, tools: tools.sort(), skills: [], native: { selected, components, runtimePeers: 'Bridge locked @deepseek-ai SDK graph; no alternate cached peer SDK is loaded.',
      skillPolicy: 'Search the DSH registry first. Load selected skill bodies only; supplement from Codex only after no suitable native skill is found.',
      remainingImplementationConstraints: [
        'Pinned SDK 0.2.1-rc.2 supplies a 256000 output-token default and 1000000 context setting. These are SDK adapter settings, not verified provider hard maxima; inspect recorded reservations for actual requests.',
        'Automatic native sessions use the official compaction service; its auxiliary requests share the bridge meter and explicit caps. The native compactor defaults to 65536 summary tokens and limited no-progress/overflow recovery. Budgeted mode uses durable checkpoint stages without a fixed total stage count. Neither mechanism creates infinite physical context or guarantees completion.',
        'SDK initialization is bounded at 30 seconds, teardown at 1/3/2 seconds. Bridge prompt storage is 64 KiB, stage JSON 32 KiB and retained text 1 MiB. File/tool output paging remains. These are implementation boundaries, not task spending authorization.',
        'Native Agent Teams defaults to 8 members; the official subagent service defaults to 8 active children and depth 1. These are native configurable defaults, not removed limits or bridge task totals.',
        'Native shell foreground waits can promote work to jobs; job_output/job_list/job_kill are provided. Native dsh-ops has its own operation timeouts and file paging. Installation and registration alone do not prove successful execution.',
      ] } };
}
