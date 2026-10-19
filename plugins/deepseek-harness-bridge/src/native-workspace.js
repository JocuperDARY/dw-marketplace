import { execFile } from 'node:child_process';
import { mkdir, realpath, rmdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { BridgeError, requireValue } from './errors.js';

// Read-only, fixed program. The path is data in an environment variable, never
// interpolated into PowerShell source. Do not add ACL preparation to this probe.
const INSPECT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$ProgressPreference = 'SilentlyContinue'
Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$item = Get-Item -LiteralPath $env:DSH_BRIDGE_WORKSPACE_CHECK -Force
$points = @()
$cursor = $item
while ($null -ne $cursor) {
  if ($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) { $points += $cursor.FullName }
  $cursor = $cursor.Parent
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$acl = Get-Acl -LiteralPath $item.FullName
@{ workspace=$item.FullName; currentSid=$identity.User.Value; ownerSid=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value; directory=[bool]$item.PSIsContainer; reparseAncestors=@($points) } | ConvertTo-Json -Compress
`;
const samePath = (left, right) => normalize(resolve(left)).toLowerCase() === normalize(resolve(right)).toLowerCase();
const inside = (root, child) => { const path = relative(root, child); return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path)); };
const sid = value => typeof value === 'string' && /^S-1-(?:\d+-)*\d+$/.test(value);

// ConnectionTasks may not have created its state store yet. Resolve the nearest
// existing ancestor without opening or creating that store.
async function canonicalFuturePath(path) {
  let cursor = resolve(path);
  const suffix = [];
  while (true) {
    try { return join(await realpath(cursor), ...suffix); }
    catch (error) {
      if (error.code !== 'ENOENT' || dirname(cursor) === cursor) throw error;
      suffix.unshift(basename(cursor));
      cursor = dirname(cursor);
    }
  }
}

/** Inspect the calling worker account and an existing directory; never edit security. */
export async function inspectNativeWorkspace(workspace) {
  requireValue(process.platform === 'win32', 'NATIVE_WORKSPACE_UNSUPPORTED', 'Native Shell workspace preparation currently requires Windows.');
  requireValue(typeof workspace === 'string' && isAbsolute(workspace), 'INVALID_ARGUMENT', 'workspace must be an absolute directory path.');
  const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const env = { SystemRoot: process.env.SystemRoot || 'C:\\Windows', WINDIR: process.env.SystemRoot || 'C:\\Windows',
    ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}), ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
    DSH_BRIDGE_WORKSPACE_CHECK: workspace };
  let evidence;
  try {
    const stdout = await new Promise((accept, reject) => {
      execFile(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(INSPECT, 'utf16le').toString('base64')], {
        windowsHide: true, timeout: 10000, maxBuffer: 65536, encoding: 'utf8',
        env,
      }, (error, output) => error ? reject(error) : accept(output));
    });
    evidence = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
  } catch {
    throw new BridgeError('NATIVE_WORKSPACE_UNVERIFIED', 'Could not inspect the native Shell workspace and worker account. No directory security was changed and no model request was made.');
  }
  requireValue(evidence && typeof evidence.workspace === 'string' && samePath(evidence.workspace, workspace)
    && sid(evidence.currentSid) && sid(evidence.ownerSid) && typeof evidence.directory === 'boolean'
    && Array.isArray(evidence.reparseAncestors) && evidence.reparseAncestors.every(path => typeof path === 'string'),
  'NATIVE_WORKSPACE_UNVERIFIED', 'Native Shell workspace inspection returned invalid evidence.');
  return evidence;
}

function assertDirectory(evidence) {
  requireValue(evidence.directory, 'INVALID_ARGUMENT', 'Native Shell workspace must be an existing directory.');
  requireValue(evidence.reparseAncestors.length === 0, 'NATIVE_WORKSPACE_REPARSE',
    'Native Shell workspace ancestry contains a junction or symlink. Choose a direct directory path; no security was changed.');
}

/** Match the upstream ownership boundary before worker launch or model spending. */
export async function validateNativeShellWorkspace(workspace, { inspect = inspectNativeWorkspace } = {}) {
  const evidence = await inspect(workspace);
  assertDirectory(evidence);
  requireValue(evidence.ownerSid === evidence.currentSid, 'NATIVE_WORKSPACE_OWNER',
    `Native Shell workspace owner ${evidence.ownerSid} differs from worker account ${evidence.currentSid}. Use dsh_prepare_workspace with a NEW path to create a directory owned by the worker account, or exclude shell from nativePlugins. Existing ownership and ACLs were preserved; no model request was made.`);
  return evidence;
}

/** Create one new worker-owned directory. Existing paths are never adopted. */
export async function prepareNativeWorkspace({ workspace, dataDir }, { inspect = inspectNativeWorkspace } = {}) {
  requireValue(typeof workspace === 'string' && isAbsolute(workspace), 'INVALID_ARGUMENT', 'workspace must be an absolute NEW directory path.');
  requireValue(typeof dataDir === 'string' && isAbsolute(dataDir), 'INVALID_ARGUMENT', 'Bridge dataDir must be supplied as an absolute path.');
  const target = resolve(workspace);
  requireValue(dirname(target) !== target, 'INVALID_ARGUMENT', 'workspace must name a new directory below an existing parent.');
  const state = await canonicalFuturePath(dataDir);
  requireValue(!inside(state, target) && !inside(target, state), 'INVALID_ARGUMENT', 'New workspace and bridge state must not contain one another.');
  const parent = await inspect(dirname(target));
  assertDirectory(parent);
  // realpath also rejects missing parents and catches aliases not reported as
  // reparse points by a particular filesystem. Creation stays nonrecursive.
  const canonicalParent = await realpath(dirname(target));
  requireValue(samePath(canonicalParent, dirname(target)), 'NATIVE_WORKSPACE_REPARSE', 'Workspace parent must be a direct canonical directory.');
  try { await mkdir(target); }
  catch (error) {
    if (error.code === 'EEXIST') throw new BridgeError('NATIVE_WORKSPACE_EXISTS', 'Workspace already exists. Choose a NEW path; existing directories are never adopted or changed.');
    throw new BridgeError('NATIVE_WORKSPACE_CREATE', 'Could not create the new workspace under its existing parent. No existing directory security was changed.');
  }
  try {
    const evidence = await validateNativeShellWorkspace(target, { inspect });
    requireValue(samePath(await realpath(target), target), 'NATIVE_WORKSPACE_REPARSE', 'New workspace does not resolve to the requested direct path.');
    return { workspace: target, created: true, evidence, aclChanged: false, modelRequests: 0,
      shellExecutionVerified: false,
      nextAction: 'Submit a task using this workspace. Official native Shell confinement may add its own workspace ACL grants when Shell first executes.' };
  } catch (error) {
    // Only remove our still-empty new directory. Never recursively remove a
    // path after a failed verification or alter an existing directory ACL.
    try { await rmdir(target); }
    catch { throw new BridgeError(error.code ?? 'NATIVE_WORKSPACE_UNVERIFIED', `${error.message} The newly created path could not be removed as an empty directory; inspect it before reuse.`); }
    throw error;
  }
}
