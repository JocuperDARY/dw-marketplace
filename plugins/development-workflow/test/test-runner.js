#!/usr/bin/env node
'use strict';
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--portable-direct') { options.portableDirect = true; continue; }
    if (!['--manifest', '--suite'].includes(key) || !argv[i+1] || argv[i+1].startsWith('--')) return null;
    options[key.slice(2)] = argv[++i];
  }
  return options.manifest && options.suite ? options : null;
}
function testIdentity(test) { return JSON.stringify([test.command, test.args || []]); }
function executableFor(command) {
  if (command === 'node') return process.execPath;
  if (typeof command !== 'string' || !path.isAbsolute(command)) throw Object.assign(new Error('Use node or an absolute executable path'), { code: 'TEST_EXECUTABLE_NOT_ABSOLUTE' });
  return command;
}
async function createExecutionContext(options, dependencies = {}) {
  const platform = dependencies.platform || process.platform;
  if (platform === 'win32') {
    if (options.portableDirect) throw Object.assign(new Error('Portable direct mode is forbidden on Windows'), {code:'PORTABLE_DIRECT_WINDOWS_FORBIDDEN'});
    const backend = dependencies.backend || require('../skills/dw-collaboration/scripts/lib/windows-command-backend');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-suite-supervisor-'));
    let prepared;
    try {
      prepared = await backend.prepareWindowsCommandBackend(directory);
      if (!prepared || !prepared.supervisorPath) throw Object.assign(new Error('No supervisor path'), {code:'WINDOWS_BACKEND_UNAVAILABLE'});
    } catch (error) {
      fs.rmSync(directory, {recursive:true, force:true});
      throw error;
    }
    let sessionsClosed = true;
    return {
      owned:true, label:'windows-job',
      execute:async request => {
        sessionsClosed = false;
        const result = await backend.runWindowsCommand({...request, supervisorPath:prepared.supervisorPath});
        sessionsClosed = result.supervisorClosed === true;
        return result;
      },
      dispose:() => {
        if (sessionsClosed) fs.rmSync(directory, {recursive:true, force:true});
        else console.error(`SUPERVISOR_ARTIFACTS_RETAINED:${directory}`);
      },
    };
  }
  if (!options.portableDirect) throw Object.assign(new Error('Use --portable-direct explicitly for portable non-Windows tests'), {code:'COMMAND_BACKEND_UNSUPPORTED'});
  return {owned:false, label:'portable-direct', dispose:()=>{}, execute:async request => cp.spawnSync(request.executable, request.args, {
    env:request.env, cwd:request.cwd, encoding:'utf8', timeout:request.timeoutMs, maxBuffer:request.maxOutputBytes, windowsHide:true,
  })};
}
async function runTest(test, context) {
  const env = {...process.env};
  // Named suites must exercise the full fixture set in a fresh fixture root.
  delete env.DW_TASK_RESOURCE_TEST_FOCUS;
  delete env.DW_TRANSACTION_TEST_ROOT;
  let result;
  try {
    result = await context.execute({executable:executableFor(test.command), args:test.args || [], cwd:process.cwd(), env,
      timeoutMs:test.timeoutMs || 120000, maxOutputBytes:8*1024*1024});
  } catch (error) { result = {error, cleanup:'unknown'}; }
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const cleanup = context.owned ? result.cleanup === 'verified_absent' ? 'VERIFIED_ABSENT' : 'UNKNOWN' : 'UNVERIFIED';
  const common = {output, cleanup, terminal:result.terminal};
  if (result.error) return {...common, status:'fail', error:result.error, stopSuite:true};
  if (context.owned && (cleanup !== 'VERIFIED_ABSENT' || !result.terminal || result.supervisorClosed !== true || result.outputComplete !== true || result.releaseError)) {
    return {...common, status:'fail', error:{code:result.reason || 'WINDOWS_EXECUTION_BOUNDARY'}, stopSuite:true};
  }
  if (result.status == null) return {...common, status:'fail', error:{code:result.reason || result.signal || 'UNKNOWN_EXIT'}, stopSuite:true};
  if (context.owned && result.reason && result.reason !== 'child_exit') return {...common, status:'fail', error:{code:result.reason}, stopSuite:true};
  if (result.status !== 0) return {...common, status:'fail'};
  const skipped = /(?:^|\r?\n)(?:SKIP_NOT_APPLICABLE:|# SKIP )/.test(output);
  const lifecycle = /(?:^|\r?\n)LIFECYCLE_RAN:[a-z]+/.test(output);
  if (skipped && !lifecycle) return {...common, status:'skip', skipped:true};
  return {...common, status:'pass', skipped};
}
async function runSuite(manifest, suiteName, context, log = console, stdout = process.stdout) {
  const suite = manifest.suites[suiteName];
  if (!suite || !Array.isArray(suite.tests)) throw new Error('TEST_SUITE_UNKNOWN');
  const ids = new Set(Object.values(manifest.suites).flatMap(s=>Array.isArray(s.tests)?s.tests:[]).map(testIdentity));
  const selected = new Set(suite.tests.map(testIdentity));
  const counts = {pass:0, fail:0, skip:0, 'not-run':[...ids].filter(id=>!selected.has(id)).length};
  const marker = suite.requiredLifecycle ? `LIFECYCLE_RAN:${suite.requiredLifecycle}` : null;
  let lifecycleRan = false;
  log.log(`COMMAND_BACKEND:${context.label}`);
  if (!context.owned) log.error('DESCENDANT_CLEANUP:UNVERIFIED');
  for (const [index, test] of suite.tests.entries()) {
    const result = await runTest(test, context);
    counts[result.status]++;
    if (result.status === 'pass' && result.skipped) counts.skip++;
    if (marker && result.status === 'pass' && result.output.includes(marker)) lifecycleRan = true;
    log.log(`${result.status.toUpperCase()} - ${test.name}`);
    if (result.error) log.error(`TEST_EXECUTION_ERROR:${result.error.code || 'UNKNOWN'}`);
    if (result.status === 'pass' && result.skipped) log.log(`SKIP - ${test.name} (inapplicable evidence)`);
    if (result.output) stdout.write(result.output);
    if (result.stopSuite) {
      counts['not-run'] += suite.tests.length-index-1;
      log.error(`DESCENDANT_CLEANUP:${result.cleanup}`);
      log.error('SUITE_STOPPED:execution boundary failure');
      break;
    }
  }
  if (marker && !lifecycleRan) {counts.fail++; log.error(`LIFECYCLE_NOT_RUN:${suite.requiredLifecycle}`);}
  for (const [name,count] of Object.entries(counts)) log.log(`${name}: ${count}`);
  return counts;
}
async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (!options) {
    console.error('Usage: node test/test-runner.js --manifest <path> --suite <name> [--portable-direct]');
    console.error('--portable-direct permits portable non-Windows tests with descendant cleanup UNVERIFIED; forbidden on Windows.');
    process.exitCode = 2; return;
  }
  const manifest = JSON.parse(fs.readFileSync(path.resolve(options.manifest), 'utf8'));
  if (!manifest || typeof manifest !== 'object' || !manifest.suites || typeof manifest.suites !== 'object') throw new Error('TEST_MANIFEST_INVALID');
  if (!manifest.suites[options.suite] || !Array.isArray(manifest.suites[options.suite].tests)) throw new Error('TEST_SUITE_UNKNOWN');
  let context;
  try {context = await createExecutionContext(options);} catch (error) {
    console.error(`COMMAND_BACKEND_UNAVAILABLE:${error.code || error.message}`);
    console.error('SUITE_NOT_RUN:backend preparation failed');
    console.log('pass: 0'); console.log('fail: 0'); console.log('skip: 0');
    console.log(`not-run: ${new Set(Object.values(manifest.suites).flatMap(s=>s.tests || []).map(testIdentity)).size}`);
    process.exitCode=2; return;
  }
  try {
    const counts = await runSuite(manifest, options.suite, context);
    if (counts.fail) process.exitCode=1;
  } finally {await context.dispose();}
}
if (require.main === module) main().catch(error=>{console.error(error.stack || error.message); process.exitCode=2;});
module.exports = {parseArgs, executableFor, createExecutionContext, runTest, runSuite, main};
