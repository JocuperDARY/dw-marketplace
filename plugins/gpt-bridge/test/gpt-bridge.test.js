#!/usr/bin/env node
import assert from 'assert';
import { spawnSync } from 'child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  autoCollectFiles,
  codexSandboxArgs,
  extractSessionId,
  runCodex,
} from '../index.js';

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function makeDir() {
  return mkdtempSync(join(tmpdir(), 'gpt-bridge-'));
}

function write(p, content) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, 'utf8');
}

function makeFakeCodex(dir, behavior = 'success') {
  const script = join(dir, process.platform === 'win32' ? 'fake-codex.cmd' : 'fake-codex');
  if (process.platform === 'win32') {
    writeFileSync(script, `@echo off\nnode "%~dp0fake-codex.js" %*\n`, 'utf8');
  } else {
    writeFileSync(script, `#!/bin/sh\nnode "$(dirname "$0")/fake-codex.js" "$@"\n`, 'utf8');
    chmodSync(script, 0o755);
  }
  writeFileSync(join(dir, 'fake-codex.js'), `
const fs = require('fs');
const args = process.argv.slice(2);
let stdin = '';
process.stdin.on('data', d => stdin += d);
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(join(dir, 'argv.json'))}, JSON.stringify(args), 'utf8');
  fs.writeFileSync(${JSON.stringify(join(dir, 'stdin.txt'))}, stdin, 'utf8');
  if (${JSON.stringify(behavior)} === 'timeout') return setTimeout(() => {}, 10000);
  if (${JSON.stringify(behavior)} === 'fail') {
    console.error('fake failure');
    process.exit(3);
  }
  const outIndex = args.indexOf('-o');
  if (outIndex >= 0) {
    fs.mkdirSync(require('path').dirname(args[outIndex + 1]), { recursive: true });
    fs.writeFileSync(args[outIndex + 1], 'FAKE FINAL OUTPUT', 'utf8');
  }
  console.log(JSON.stringify({ type: 'turn.started', session_id: 'abc-session' }));
  console.log(JSON.stringify({ type: 'assistant.message', message: 'done' }));
});
`, 'utf8');
  return script;
}

test('sandbox mode maps to current Codex CLI flags', () => {
  assert.deepStrictEqual(codexSandboxArgs('strict'), ['--sandbox', 'read-only']);
  assert.deepStrictEqual(codexSandboxArgs('workspace'), ['--sandbox', 'workspace-write']);
  assert.deepStrictEqual(codexSandboxArgs('yolo'), ['--dangerously-bypass-approvals-and-sandbox']);
});

test('new Codex exec calls use --sandbox instead of old -p profile misuse', async () => {
  const cwd = makeDir();
  const bin = makeFakeCodex(cwd);
  process.env.CODEX_PATH = bin;
  const result = await runCodex({
    prompt: 'Summarize this.',
    model: 'gpt-test',
    mode: 'workspace',
    cwd,
    timeout: 5,
  });
  assert.strictEqual(result.success, true, result.error);
  const argv = JSON.parse(readFileSync(join(cwd, 'argv.json'), 'utf8'));
  assert.deepStrictEqual(argv.slice(0, 3), ['exec', '--sandbox', 'workspace-write']);
  assert(!argv.includes('-p'), `did not expect old -p profile flag in ${argv.join(' ')}`);
  assert(argv.includes('-m'));
  assert(argv.includes('gpt-test'));
  assert(argv.includes('--json'));
  assert(argv.includes('-o'));
  assert.strictEqual(readFileSync(join(cwd, 'stdin.txt'), 'utf8').includes('## Task'), true);
});

test('resume Codex exec passes resume subcommand and sandbox flags', async () => {
  const cwd = makeDir();
  const bin = makeFakeCodex(cwd);
  process.env.CODEX_PATH = bin;
  const result = await runCodex({
    prompt: 'Continue.',
    sessionId: 'session-123',
    mode: 'strict',
    cwd,
    timeout: 5,
  });
  assert.strictEqual(result.success, true, result.error);
  const argv = JSON.parse(readFileSync(join(cwd, 'argv.json'), 'utf8'));
  assert.deepStrictEqual(argv.slice(0, 5), ['exec', 'resume', 'session-123', '--sandbox', 'read-only']);
  assert(argv.includes('--ephemeral'));
});

test('relative outputFile is resolved under cwd and preserved', async () => {
  const cwd = makeDir();
  const bin = makeFakeCodex(cwd);
  process.env.CODEX_PATH = bin;
  const result = await runCodex({
    prompt: 'Write output.',
    mode: 'workspace',
    outputFile: 'out/result.txt',
    cwd,
    timeout: 5,
  });
  assert.strictEqual(result.success, true, result.error);
  assert.strictEqual(readFileSync(join(cwd, 'out', 'result.txt'), 'utf8'), 'FAKE FINAL OUTPUT');
});

test('missing explicit files fail before launching Codex', async () => {
  const cwd = makeDir();
  const bin = makeFakeCodex(cwd);
  process.env.CODEX_PATH = bin;
  const result = await runCodex({
    prompt: 'Use missing file.',
    mode: 'workspace',
    files: ['missing.txt'],
    cwd,
    timeout: 5,
  });
  assert.strictEqual(result.success, false);
  assert.match(result.error, /Files not found: missing\.txt/);
});

test('auto context respects max file count and excludes explicit files', async () => {
  const cwd = makeDir();
  write(join(cwd, 'src', 'a.txt'), 'A');
  write(join(cwd, 'src', 'b.txt'), 'B');
  const collected = await autoCollectFiles({
    patterns: ['src/*.txt'],
    cwd,
    maxFiles: 5,
    maxSizeKB: 1,
    explicitFiles: ['src/a.txt'],
  });
  assert.deepStrictEqual(collected.map(f => f.path), ['src/b.txt']);
});

test('timeout returns an error instead of success', async () => {
  const cwd = makeDir();
  const bin = makeFakeCodex(cwd, 'timeout');
  process.env.CODEX_PATH = bin;
  const result = await runCodex({
    prompt: 'Hang.',
    mode: 'workspace',
    cwd,
    timeout: 1,
  });
  assert.strictEqual(result.success, false);
  assert.match(result.error, /timed out/);
});

test('session id can be extracted from JSONL stdout', () => {
  assert.strictEqual(extractSessionId('', '{"session_id":"sid-1"}'), 'sid-1');
  assert.strictEqual(extractSessionId('session id: sid-2', ''), 'sid-2');
});

test('MCP server exposes gpt tool over stdio', () => {
  const child = spawnSync(process.execPath, ['plugins/gpt-bridge/index.js'], {
    input: [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    ].join('\n') + '\n',
    encoding: 'utf8',
    timeout: 2000,
  });
  assert.match(child.stdout, /"name":"gpt"/);
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

if (process.exitCode) {
  console.error(`${passed}/${tests.length} tests passed`);
} else {
  console.log(`${passed}/${tests.length} tests passed`);
}
