#!/usr/bin/env node
import assert from 'assert';
import { spawnSync } from 'child_process';
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, relative, isAbsolute, sep } from 'path';
import { fileURLToPath } from 'url';
import {
  autoCollectFiles,
  buildToolResponse,
  codexSandboxArgs,
  extractSessionId,
  formatToolResult,
  runCodex,
} from '../index.js';

const tests = [];
const testDirs = new Set();
const testRoot = realpathSync(tmpdir());
const pluginRoot = fileURLToPath(new URL('..', import.meta.url));
const originalCodexPath = process.env.CODEX_PATH;
function test(name, fn) {
  tests.push({ name, fn });
}

function makeDir() {
  const dir = mkdtempSync(join(testRoot, 'gpt-bridge-test-'));
  testDirs.add(dir);
  return dir;
}

function cleanupTestDirs() {
  for (const dir of testDirs) {
    const rel = relative(testRoot, realpathSync(dir));
    assert(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    assert(!lstatSync(dir).isSymbolicLink());
    rmSync(dir, { recursive: true });
  }
  if (originalCodexPath === undefined) delete process.env.CODEX_PATH;
  else process.env.CODEX_PATH = originalCodexPath;
}

function callMcpTool(args, cwd) {
  const child = spawnSync(process.execPath, [join(pluginRoot, 'index.js')], {
    input: [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'gpt', arguments: { prompt: 'Test only.', cwd, timeout: 5, ...args } } },
    ].map(value => JSON.stringify(value)).join('\n') + '\n',
    env: { ...process.env, CODEX_PATH: makeFakeCodex(cwd) },
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 8000,
  });
  assert.ifError(child.error);
  assert.strictEqual(child.status, 0, child.stderr);
  const reply = child.stdout.trim().split('\n').map(line => JSON.parse(line)).find(message => message.id === 2);
  assert(reply?.result, child.stdout);
  return reply.result;
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
  const behavior = ${JSON.stringify(behavior)};
  if (behavior === 'timeout') return setTimeout(() => {}, 10000);
  if (behavior === 'fail') {
    console.error('fake failure');
    process.exit(3);
  }
  if (behavior === 'unsupported') {
    fs.appendFileSync(${JSON.stringify(join(dir, 'attempts.txt'))}, 'attempt\\n');
    console.error('OpenAI Codex test');
    console.error('reasoning effort: medium');
    console.error('Unsupported model: requested model or reasoning effort');
    process.exit(2);
  }
  if (behavior === 'json-error') {
    console.log(JSON.stringify({ type: 'error', message: 'jsonl schema failure' }));
    console.log(JSON.stringify({ type: 'turn.failed', error: { message: 'jsonl turn failure' } }));
    process.exit(1);
  }
  const schemaIndex = args.indexOf('--output-schema');
  if (schemaIndex >= 0) {
    fs.writeFileSync(${JSON.stringify(join(dir, 'schema.json'))}, fs.readFileSync(args[schemaIndex + 1], 'utf8'), 'utf8');
  }
  const outIndex = args.indexOf('-o');
  if (outIndex >= 0) {
    fs.mkdirSync(require('path').dirname(args[outIndex + 1]), { recursive: true });
    fs.writeFileSync(args[outIndex + 1], behavior === 'json' ? '{"ok":true}' : 'FAKE FINAL OUTPUT', 'utf8');
  }
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'abc-session' }));
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
    model: 'gpt-6.1-sol',
    mode: 'workspace',
    cwd,
    timeout: 5,
  });
  assert.strictEqual(result.success, true, result.error);
  const argv = JSON.parse(readFileSync(join(cwd, 'argv.json'), 'utf8'));
  assert.deepStrictEqual(argv.slice(0, 3), ['exec', '--sandbox', 'workspace-write']);
  assert(!argv.includes('-p'), `did not expect old -p profile flag in ${argv.join(' ')}`);
  assert(argv.includes('-m'));
  assert(argv.includes('gpt-6.1-sol'));
  assert(argv.includes('--json'));
  assert(argv.includes('-o'));
  assert.strictEqual(readFileSync(join(cwd, 'stdin.txt'), 'utf8').includes('## Task'), true);
});

for (const sessionId of [undefined, 'previous-session']) {
  test(`default selection pins an eligible pair for ${sessionId ? 'resume' : 'new exec'}`, async () => {
    const cwd = makeDir();
    process.env.CODEX_PATH = makeFakeCodex(cwd);
    const result = await runCodex({ prompt: 'Test default.', sessionId, cwd, timeout: 5 });
    assert.strictEqual(result.success, true, result.error);
    const argv = JSON.parse(readFileSync(join(cwd, 'argv.json'), 'utf8'));
    assert.strictEqual(argv[argv.indexOf('-m') + 1], 'gpt-6.1-sol');
    assert.strictEqual(argv[argv.indexOf('-c') + 1], 'model_reasoning_effort=medium');
    assert.strictEqual(result.modelSelection, 'bridge_default');
    assert.strictEqual(result.requestedModel, 'gpt-6.1-sol');
    assert.strictEqual(result.requestedEffort, 'medium');
    assert.strictEqual(result.actualModel, 'unknown');
    assert.strictEqual(result.actualEffort, 'unknown');
    assert.strictEqual(result.model, 'unknown');
  });
}

test('explicit model and effort override defaults without claiming observed identity', async () => {
  const cwd = makeDir();
  process.env.CODEX_PATH = makeFakeCodex(cwd);
  const result = await runCodex({ prompt: 'Test explicit.', model: ' gpt-6.1-terra ', effort: 'low', mode: 'strict', cwd, timeout: 5 });
  assert.strictEqual(result.success, true, result.error);
  const argv = JSON.parse(readFileSync(join(cwd, 'argv.json'), 'utf8'));
  assert.strictEqual(argv[argv.indexOf('-m') + 1], 'gpt-6.1-terra');
  assert.strictEqual(argv[argv.indexOf('-c') + 1], 'model_reasoning_effort=low');
  assert.strictEqual(result.modelSelection, 'explicit_request');
  assert.strictEqual(result.requestedModel, 'gpt-6.1-terra');
  assert.strictEqual(result.requestedEffort, 'low');
  assert.strictEqual(result.actualModel, 'unknown');
});

for (const [profile, model, effort, sandbox] of [
  ['fast', 'gpt-6.1-terra', 'low', ['--sandbox', 'read-only']],
  ['balanced', 'gpt-6.1-sol', 'medium', ['--sandbox', 'workspace-write']],
  ['max', 'gpt-6-astra', 'high', ['--dangerously-bypass-approvals-and-sandbox']],
]) {
  test(`MCP ${profile} profile sends its model, effort and documented permission mode`, () => {
    const cwd = makeDir();
    const result = callMcpTool({ profile }, cwd);
    assert(!result.isError, result.content[0].text);
    const argv = JSON.parse(readFileSync(join(cwd, 'argv.json'), 'utf8'));
    assert.deepStrictEqual(argv.slice(1, 1 + sandbox.length), sandbox);
    const permissionOptions = argv.flatMap((arg, index) => {
      if (arg === '--sandbox' || arg === '-s') return [arg, argv[index + 1]];
      if (arg.startsWith('--sandbox=') || arg === '--dangerously-bypass-approvals-and-sandbox') return [arg];
      return [];
    });
    assert.deepStrictEqual(permissionOptions, sandbox, 'unexpected or repeated permission option');
    assert.strictEqual(argv[argv.indexOf('-m') + 1], model);
    assert.strictEqual(argv[argv.indexOf('-c') + 1], `model_reasoning_effort=${effort}`);
    assert.strictEqual(result._meta['gpt-bridge/modelSelection'], 'profile');
    assert.strictEqual(result._meta['gpt-bridge/requestedModel'], model);
    assert.strictEqual(result._meta['gpt-bridge/actualModel'], 'unknown');
  });
}

test('MCP effort override and resume retain explicit requested metadata', () => {
  const cwd = makeDir();
  const result = callMcpTool({ profile: 'fast', effort: 'high', sessionId: 'prior' }, cwd);
  assert(!result.isError, result.content[0].text);
  const argv = JSON.parse(readFileSync(join(cwd, 'argv.json'), 'utf8'));
  assert(argv.includes('resume'));
  assert.strictEqual(argv[argv.indexOf('-c') + 1], 'model_reasoning_effort=high');
  assert.strictEqual(result._meta['gpt-bridge/requestedEffort'], 'high');
});

test('invalid selection arguments fail before direct or MCP Codex launch', async () => {
  const invalid = [
    { model: '' }, { model: '  ' }, { model: 5 },
    { mode: '' }, { mode: '__proto__' }, { mode: 'constructor' },
    { effort: '' }, { effort: 'unsupported' }, { effort: 5 },
    { profile: '' }, { profile: '__proto__' }, { profile: 'constructor' },
    { profile: 'fast', model: '' }, { profile: 'fast', mode: '' },
    { profile: 'fast', model: 'gpt-6.1-sol' }, { profile: 'fast', mode: 'workspace' },
  ];
  for (const args of invalid) {
    const cwd = makeDir();
    process.env.CODEX_PATH = makeFakeCodex(cwd);
    const direct = await runCodex({ prompt: 'Reject.', cwd, timeout: 5, ...args });
    assert.strictEqual(direct.success, false, JSON.stringify(args));
    assert.throws(() => readFileSync(join(cwd, 'argv.json')));
    const mcp = callMcpTool(args, cwd);
    assert.strictEqual(mcp.isError, true, JSON.stringify(args));
    assert.throws(() => readFileSync(join(cwd, 'argv.json')));
  }
});

test('unsupported provider selection returns its error without a model fallback', async () => {
  const cwd = makeDir();
  process.env.CODEX_PATH = makeFakeCodex(cwd, 'unsupported');
  const result = await runCodex({ prompt: 'Reject unsupported selection.', cwd, timeout: 5 });
  assert.strictEqual(result.success, false);
  assert.match(result.error, /Unsupported model: requested model or reasoning effort/);
  assert.doesNotMatch(result.error, /OpenAI Codex test|reasoning effort: medium/);
  assert.deepStrictEqual(readFileSync(join(cwd, 'attempts.txt'), 'utf8').trim().split('\n'), ['attempt']);
});

test('model metadata is available without a session and preserves structured JSON', () => {
  const response = buildToolResponse({
    result: '{"ok":true}', structuredContent: { ok: true },
    modelSelection: 'bridge_default', requestedModel: 'gpt-6.1-sol', requestedEffort: 'medium',
    actualModel: 'unknown', actualEffort: 'unknown',
  }, { preserveRawText: true });
  assert.deepStrictEqual(JSON.parse(response.content[0].text), { ok: true });
  assert.strictEqual(response._meta['gpt-bridge/requestedModel'], 'gpt-6.1-sol');
  assert.strictEqual(response._meta['gpt-bridge/actualModel'], 'unknown');
  assert(!('gpt-bridge/sessionId' in response._meta));
});

test('resume Codex exec puts exec-level flags before the resume subcommand', async () => {
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
  assert.deepStrictEqual(argv.slice(0, 4), ['exec', '--sandbox', 'read-only', 'resume']);
  assert(argv.includes('--skip-git-repo-check'));
  assert(argv.includes('--json'));
  assert(argv.includes('-o'));
  assert.strictEqual(argv.at(-2), 'session-123');
  assert.strictEqual(argv.at(-1), '-');
  assert(!argv.includes('--ephemeral'), 'resume should persist by default so future calls can continue the Codex thread');
});

test('ephemeral opt-in is passed to Codex resume', async () => {
  const cwd = makeDir();
  const bin = makeFakeCodex(cwd);
  process.env.CODEX_PATH = bin;
  const result = await runCodex({
    prompt: 'Continue without persistence.',
    sessionId: 'session-ephemeral',
    mode: 'workspace',
    cwd,
    timeout: 5,
    ephemeral: true,
  });
  assert.strictEqual(result.success, true, result.error);
  const argv = JSON.parse(readFileSync(join(cwd, 'argv.json'), 'utf8'));
  assert(argv.includes('--ephemeral'));
  assert.strictEqual(argv.at(-2), 'session-ephemeral');
  assert.strictEqual(argv.at(-1), '-');
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

test('absolute explicit files are rejected before launching Codex', async () => {
  const cwd = makeDir();
  const outside = join(makeDir(), 'secret.txt');
  write(outside, 'secret');
  const bin = makeFakeCodex(cwd);
  process.env.CODEX_PATH = bin;
  const result = await runCodex({
    prompt: 'Use absolute file.',
    mode: 'workspace',
    files: [outside],
    cwd,
    timeout: 5,
  });
  assert.strictEqual(result.success, false);
  assert.match(result.error, /Absolute file paths are not allowed/);
  assert.throws(() => readFileSync(join(cwd, 'argv.json'), 'utf8'));
});

test('escaping explicit files are rejected before launching Codex', async () => {
  const cwd = makeDir();
  const bin = makeFakeCodex(cwd);
  process.env.CODEX_PATH = bin;
  const result = await runCodex({
    prompt: 'Use parent file.',
    mode: 'workspace',
    files: ['../secret.txt'],
    cwd,
    timeout: 5,
  });
  assert.strictEqual(result.success, false);
  assert.match(result.error, /escapes project root/);
  assert.throws(() => readFileSync(join(cwd, 'argv.json'), 'utf8'));
});

test('project-relative files starting with dotdot text are allowed inside cwd', async () => {
  const cwd = makeDir();
  write(join(cwd, '..not-parent.txt'), 'local');
  const bin = makeFakeCodex(cwd);
  process.env.CODEX_PATH = bin;
  const result = await runCodex({
    prompt: 'Use local file.',
    mode: 'workspace',
    files: ['..not-parent.txt'],
    cwd,
    timeout: 5,
  });
  assert.strictEqual(result.success, true, result.error);
  assert.match(readFileSync(join(cwd, 'stdin.txt'), 'utf8'), /local/);
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
  assert.strictEqual(extractSessionId('', '{"type":"thread.started","thread_id":"thread-1"}'), 'thread-1');
  assert.strictEqual(extractSessionId('', '{"session_id":"sid-1"}'), 'sid-1');
  assert.strictEqual(extractSessionId('session id: sid-2', ''), 'sid-2');
});

test('tool result exposes continuation metadata when Codex returns a session id', () => {
  const text = formatToolResult({
    success: true,
    result: 'Answer body',
    sessionId: 'sid-"123',
  });
  assert.match(text, /<gpt-bridge-session>/);
  assert.match(text, /sessionId: sid-"123/);
  const continueLine = text.split('\n').find(line => line.startsWith('continueWith: '));
  assert.strictEqual(JSON.parse(continueLine.replace('continueWith: ', '')).sessionId, 'sid-"123');
  assert.match(text, /sync boundary/);
  assert.match(text, /Answer body/);
});

test('outputSchema responses preserve raw JSON and move session data to metadata', async () => {
  const cwd = makeDir();
  const bin = makeFakeCodex(cwd, 'json');
  process.env.CODEX_PATH = bin;
  const result = await runCodex({
    prompt: 'Return JSON.',
    mode: 'workspace',
    outputSchema: {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
    },
    cwd,
    timeout: 5,
  });
  assert.strictEqual(result.success, true, result.error);
  assert.deepStrictEqual(JSON.parse(result.result), { ok: true });
  assert.strictEqual(JSON.parse(readFileSync(join(cwd, 'schema.json'), 'utf8')).additionalProperties, false);

  const response = buildToolResponse(result, { preserveRawText: true });
  assert.deepStrictEqual(JSON.parse(response.content[0].text), { ok: true });
  assert.deepStrictEqual(response.structuredContent, { ok: true });
  assert.strictEqual(response._meta['gpt-bridge/sessionId'], 'abc-session');
  assert.deepStrictEqual(response._meta['gpt-bridge/continueWith'], { sessionId: 'abc-session' });
});

test('outputSchema forces root additionalProperties false for Codex compatibility', async () => {
  const cwd = makeDir();
  const bin = makeFakeCodex(cwd, 'json');
  process.env.CODEX_PATH = bin;
  const result = await runCodex({
    prompt: 'Return JSON.',
    mode: 'workspace',
    outputSchema: {
      type: 'object',
      additionalProperties: true,
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
    },
    cwd,
    timeout: 5,
  });
  assert.strictEqual(result.success, true, result.error);
  assert.strictEqual(JSON.parse(readFileSync(join(cwd, 'schema.json'), 'utf8')).additionalProperties, false);
});

test('JSONL error and turn.failed events are surfaced on Codex failure', async () => {
  const cwd = makeDir();
  const bin = makeFakeCodex(cwd, 'json-error');
  process.env.CODEX_PATH = bin;
  const result = await runCodex({
    prompt: 'Fail with JSONL events.',
    mode: 'workspace',
    cwd,
    timeout: 5,
  });
  assert.strictEqual(result.success, false);
  assert.match(result.error, /jsonl schema failure/);
  assert.match(result.error, /jsonl turn failure/);
});

test('MCP server exposes gpt tool over stdio', () => {
  const child = spawnSync(process.execPath, [join(pluginRoot, 'index.js')], {
    input: [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    ].join('\n') + '\n',
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
  });
  assert.ifError(child.error);
  assert.strictEqual(child.status, 0, child.stderr);
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

cleanupTestDirs();

if (process.exitCode) {
  console.error(`${passed}/${tests.length} tests passed`);
} else {
  console.log(`${passed}/${tests.length} tests passed`);
}
