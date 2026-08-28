#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function readJsonSafe(filePath) {
  const content = readFileSafe(filePath);
  if (content === null) return null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function findProjectRoot(startDirectory, options = {}) {
  const start = path.resolve(startDirectory || process.cwd());
  const home = path.resolve(options.home || process.env.HOME || process.env.USERPROFILE || os.homedir());
  let current = start;
  for (let depth = 0; depth < 20; depth += 1) {
    if (fs.existsSync(path.join(current, '.git'))) {
      const capturedHome = current.toLowerCase() === home.toLowerCase()
        && start.toLowerCase() !== home.toLowerCase();
      return capturedHome ? start : current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return start;
}

function outputHook(eventName, additionalContext, extra) {
  const hookSpecificOutput = { hookEventName: eventName };
  if (additionalContext) hookSpecificOutput.additionalContext = additionalContext;
  if (extra && typeof extra === 'object') Object.assign(hookSpecificOutput, extra);
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput })}\n`);
}

function detectTechStack(root) {
  const markers = [
    ['package.json', 'Node.js'],
    ['go.mod', 'Go'],
    ['pyproject.toml', 'Python'],
    ['requirements.txt', 'Python'],
    ['Cargo.toml', 'Rust'],
    ['pom.xml', 'Java'],
    ['build.gradle', 'Java/Kotlin'],
    ['build.gradle.kts', 'Kotlin'],
  ];
  const values = markers.filter(([file]) => fs.existsSync(path.join(root, file))).map(([, label]) => label);
  return [...new Set(values)].join(' + ') || 'Unknown';
}

function getGitInfo(root) {
  try {
    const branch = childProcess.execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
      windowsHide: true,
    }).trim();
    const status = childProcess.execFileSync('git', ['status', '--porcelain'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
      windowsHide: true,
    });
    return { branch: branch || 'detached', dirtyCount: status.split(/\r?\n/).filter(Boolean).length };
  } catch {
    return { branch: 'not-a-repository', dirtyCount: null };
  }
}

function verifyHookScripts() {
  const hooksDirectory = __dirname;
  const required = ['task-utils.js', 'session-rules.js', 'rules-migrate.js', 'session-start.js', 'skill-router.js', 'tool-inventory.js'];
  return required.filter(file => !fs.existsSync(path.join(hooksDirectory, file)));
}

module.exports = {
  detectTechStack,
  findProjectRoot,
  getGitInfo,
  isWithin,
  outputHook,
  readFileSafe,
  readJsonSafe,
  verifyHookScripts,
};
