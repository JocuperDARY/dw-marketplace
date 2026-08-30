#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

function usage() {
  console.error('Usage: node test/test-runner.js --manifest <path> --suite <name>');
  process.exitCode = 2;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if ((key !== '--manifest' && key !== '--suite') || !value || value.startsWith('--')) return null;
    options[key.slice(2)] = value;
    index += 1;
  }
  return options.manifest && options.suite ? options : null;
}

function readManifest(file) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || !value.suites || typeof value.suites !== 'object') {
    throw new Error('TEST_MANIFEST_INVALID');
  }
  return value;
}

function isSkipped(output) {
  return /(?:^|\r?\n)(?:SKIP_NOT_APPLICABLE:|# SKIP )/.test(output);
}

function hasLifecycleEvidence(output) {
  return /(?:^|\r?\n)LIFECYCLE_RAN:[a-z]+/.test(output);
}

function runTest(test) {
  const result = childProcess.spawnSync(test.command, test.args || [], {
    encoding: 'utf8',
    timeout: test.timeoutMs || 120000,
    windowsHide: true,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (result.error || result.status !== 0) return { status: 'fail', output, error: result.error };
  if (isSkipped(output) && !hasLifecycleEvidence(output)) return { status: 'skip', output };
  return { status: 'pass', output };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return usage();
  const manifest = readManifest(path.resolve(options.manifest));
  const selectedSuite = manifest.suites[options.suite];
  if (!selectedSuite || !Array.isArray(selectedSuite.tests)) throw new Error('TEST_SUITE_UNKNOWN');

  const allTests = Object.values(manifest.suites).flatMap((suite) => Array.isArray(suite.tests) ? suite.tests : []);
  const counts = { pass: 0, fail: 0, skip: 0, 'not-run': allTests.length - selectedSuite.tests.length };
  const lifecycleMarker = selectedSuite.requiredLifecycle ? `LIFECYCLE_RAN:${selectedSuite.requiredLifecycle}` : null;
  let lifecycleRan = false;

  for (const test of selectedSuite.tests) {
    const result = runTest(test);
    counts[result.status] += 1;
    if (lifecycleMarker && result.status === 'pass' && result.output.includes(lifecycleMarker)) lifecycleRan = true;
    console.log(`${result.status.toUpperCase()} - ${test.name}`);
    if (result.output) process.stdout.write(result.output);
  }

  if (lifecycleMarker && !lifecycleRan) {
    counts.fail += 1;
    console.error(`LIFECYCLE_NOT_RUN:${selectedSuite.requiredLifecycle}`);
  }

  for (const [name, count] of Object.entries(counts)) console.log(`${name}: ${count}`);
  if (counts.fail > 0) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 2;
}
