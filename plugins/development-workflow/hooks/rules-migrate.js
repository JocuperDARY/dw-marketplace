#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { MANAGED_LANGUAGES, isWithin } = require('./session-rules.js');

function migrationId() {
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `${timestamp}-${process.pid}`;
}

function listTree(root, relative = '', output = []) {
  let entries;
  try {
    if (fs.lstatSync(root).isSymbolicLink()) throw new Error(`symbolic link is not allowed: ${root}`);
    entries = fs.readdirSync(root, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    if (error.code === 'ENOENT') return output;
    throw error;
  }
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    const rel = path.join(relative, entry.name).replace(/\\/g, '/');
    if (entry.isSymbolicLink()) throw new Error(`symbolic link is not allowed: ${absolute}`);
    if (entry.isDirectory()) {
      output.push({ type: 'directory', path: rel });
      listTree(absolute, rel, output);
    } else if (entry.isFile()) {
      const content = fs.readFileSync(absolute);
      output.push({
        type: 'file',
        path: rel,
        bytes: content.length,
        sha256: crypto.createHash('sha256').update(content).digest('hex'),
      });
    } else {
      throw new Error(`unsupported filesystem entry: ${absolute}`);
    }
  }
  return output;
}

function treeDigest(root) {
  const tree = listTree(root);
  const digest = crypto.createHash('sha256').update(JSON.stringify(tree)).digest('hex');
  return { tree, digest };
}

function copyTree(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const src = path.join(source, entry.name);
    const dst = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`symbolic link is not allowed: ${src}`);
    if (entry.isDirectory()) copyTree(src, dst);
    else if (entry.isFile()) fs.copyFileSync(src, dst);
    else throw new Error(`unsupported filesystem entry: ${src}`);
  }
}

function buildMigrationPlan(home) {
  const resolvedHome = path.resolve(home);
  const claudeRoot = path.join(resolvedHome, '.claude');
  const rulesRoot = path.join(claudeRoot, 'rules');
  const storeRoot = path.join(claudeRoot, 'rules-store');
  const candidates = [];
  const conflicts = [];

  for (const language of MANAGED_LANGUAGES) {
    const source = path.join(rulesRoot, language);
    if (!fs.existsSync(source)) continue;
    if (!isWithin(rulesRoot, source)) throw new Error(`source escaped rules root: ${source}`);
    const sourceStat = fs.lstatSync(source);
    if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
      conflicts.push({ language, reason: 'source is not a real directory' });
      continue;
    }
    const sourceTree = treeDigest(source);
    const destination = path.join(storeRoot, language);
    let destinationState = 'create';
    if (fs.existsSync(destination)) {
      const destinationStat = fs.lstatSync(destination);
      if (destinationStat.isSymbolicLink() || !destinationStat.isDirectory()) {
        conflicts.push({ language, reason: 'destination is not a real directory' });
        continue;
      }
      const destinationTree = treeDigest(destination);
      if (destinationTree.digest !== sourceTree.digest) {
        conflicts.push({
          language,
          reason: 'rules-store has different content; refusing to overwrite either copy',
          sourceDigest: sourceTree.digest,
          destinationDigest: destinationTree.digest,
        });
        continue;
      }
      destinationState = 'already-identical';
    }
    candidates.push({
      language,
      source,
      destination,
      destinationState,
      digest: sourceTree.digest,
      files: sourceTree.tree.filter(entry => entry.type === 'file').length,
      bytes: sourceTree.tree.filter(entry => entry.type === 'file').reduce((sum, entry) => sum + entry.bytes, 0),
    });
  }

  return {
    schemaVersion: 1,
    mode: 'dry-run',
    home: resolvedHome,
    rulesRoot,
    storeRoot,
    candidates,
    conflicts,
    safeToApply: conflicts.length === 0,
  };
}

function assertMigrationBoundary(plan, target) {
  const claudeRoot = path.join(plan.home, '.claude');
  if (!isWithin(claudeRoot, target)) throw new Error(`migration target escaped ~/.claude: ${target}`);
}

function removeMigrationOwnedTree(plan, target, expectedDigest = null) {
  assertMigrationBoundary(plan, target);
  if (!fs.existsSync(target)) return false;
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`refusing to remove non-directory migration path: ${target}`);
  }
  if (expectedDigest && treeDigest(target).digest !== expectedDigest) {
    throw new Error(`refusing to remove changed migration path: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
  return true;
}

function applyMigration(home, id = migrationId()) {
  const plan = buildMigrationPlan(home);
  if (!plan.safeToApply) {
    const error = new Error('migration conflicts must be resolved before --apply');
    error.plan = plan;
    throw error;
  }
  if (!plan.candidates.length) return { ...plan, mode: 'apply', migrationId: id, applied: [], manifest: null };
  if (!/^[0-9A-Za-z._-]+$/.test(id)) throw new Error('invalid migration id');

  const archiveRoot = path.join(plan.home, '.claude', 'rules-archive', id);
  const stagingRoot = path.join(plan.storeRoot, `.dw-migration-${id}`);
  assertMigrationBoundary(plan, archiveRoot);
  assertMigrationBoundary(plan, stagingRoot);
  if (fs.existsSync(archiveRoot) || fs.existsSync(stagingRoot)) throw new Error(`migration id already exists: ${id}`);

  const staged = [];
  const applied = [];
  const createdDestinations = [];
  try {
    for (const candidate of plan.candidates.filter(item => item.destinationState === 'create')) {
      const stagedDestination = path.join(stagingRoot, candidate.language);
      copyTree(candidate.source, stagedDestination);
      const stagedDigest = treeDigest(stagedDestination).digest;
      if (stagedDigest !== candidate.digest) throw new Error(`copy verification failed for ${candidate.language}`);
      staged.push({ ...candidate, stagedDestination });
    }

    fs.mkdirSync(archiveRoot, { recursive: true });
    for (const candidate of staged) {
      fs.mkdirSync(path.dirname(candidate.destination), { recursive: true });
      fs.renameSync(candidate.stagedDestination, candidate.destination);
      createdDestinations.push(candidate);
    }
    for (const candidate of plan.candidates) {
      const currentSourceDigest = treeDigest(candidate.source).digest;
      if (currentSourceDigest !== candidate.digest) {
        throw new Error(`source changed after preflight for ${candidate.language}`);
      }
      if (candidate.destinationState === 'already-identical') {
        const currentDestinationDigest = treeDigest(candidate.destination).digest;
        if (currentDestinationDigest !== candidate.digest) {
          throw new Error(`destination changed after preflight for ${candidate.language}`);
        }
      }
      const archived = path.join(archiveRoot, candidate.language);
      fs.renameSync(candidate.source, archived);
      applied.push({
        language: candidate.language,
        archived,
        destination: candidate.destination,
        destinationCreated: candidate.destinationState === 'create',
        digest: candidate.digest,
      });
    }

    const manifestPath = path.join(archiveRoot, 'manifest.json');
    const manifest = {
      schemaVersion: 1,
      migrationId: id,
      appliedAt: new Date().toISOString(),
      rulesRoot: plan.rulesRoot,
      storeRoot: plan.storeRoot,
      applied,
      rollback: 'Move each archived directory back to rulesRoot only when the target is absent; keep rules-store copies as the read-only selector source.',
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    removeMigrationOwnedTree(plan, stagingRoot);
    return { ...plan, mode: 'apply', migrationId: id, applied, manifest: manifestPath };
  } catch (error) {
    for (const item of [...applied].reverse()) {
      const original = path.join(plan.rulesRoot, item.language);
      if (fs.existsSync(item.archived) && !fs.existsSync(original)) fs.renameSync(item.archived, original);
    }
    for (const item of [...createdDestinations].reverse()) {
      if (!fs.existsSync(item.destination)) continue;
      const unchanged = treeDigest(item.destination).digest === item.digest;
      if (unchanged) removeMigrationOwnedTree(plan, item.destination, item.digest);
    }
    removeMigrationOwnedTree(plan, stagingRoot);
    if (fs.existsSync(archiveRoot) && fs.readdirSync(archiveRoot).length === 0) {
      removeMigrationOwnedTree(plan, archiveRoot);
    }
    throw error;
  }
}

function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--apply') && args.has('--dry-run')) throw new Error('choose either --dry-run or --apply');
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  if (args.has('--apply')) {
    const result = applyMigration(home);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const plan = buildMigrationPlan(home);
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  if (!plan.safeToApply) process.exitCode = 2;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    if (error.plan) process.stdout.write(`${JSON.stringify(error.plan, null, 2)}\n`);
    process.stderr.write(`[rules-migrate] ${error.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = {
  applyMigration,
  buildMigrationPlan,
  copyTree,
  listTree,
  migrationId,
  removeMigrationOwnedTree,
  treeDigest,
};
