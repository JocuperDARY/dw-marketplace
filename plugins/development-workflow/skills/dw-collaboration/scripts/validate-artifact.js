#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { canonicalize, computeContentSha256 } = require('./lib/canonical-json');
const contracts = require('./lib/contracts');
const MAX_PLAN_ARTIFACTS = 256;
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_INPUT_BYTES = 32 * 1024 * 1024;

function metadataError(code, entryPath, message) { return { code, path: entryPath, message }; }
function parseArgs(args) {
  const options = { artifacts: [] };
  const addArtifact = (artifactPath) => {
    options.artifacts.push(artifactPath);
    return options.artifacts.length <= MAX_PLAN_ARTIFACTS;
  };
  for (let index = 0; index < args.length; index += 1) { const argument = args[index]; const next = args[index + 1]; if (argument === '--artifact') { if (!next || next.startsWith('-')) return { error: 'missing artifact path' }; if (!addArtifact(args[++index])) return { error: 'artifact count exceeds its limit', errorCode: 'CONTRACT_LIMIT_EXCEEDED' }; } else if (argument === '--now') { if (!next || next.startsWith('-')) return { error: 'missing validation time' }; options.now = args[++index]; } else if (argument === '--expected-session') { if (!next || next.startsWith('-')) return { error: 'missing expected session' }; options.expectedSessionId = args[++index]; } else if (argument === '--exact-lane-required') options.exactLaneRequired = true; else if (argument.startsWith('-')) return { error: 'unrecognized option' }; else if (!addArtifact(argument)) return { error: 'artifact count exceeds its limit', errorCode: 'CONTRACT_LIMIT_EXCEEDED' }; }
  if (options.now === undefined) return { error: 'validation time is required' };
  return options.artifacts.length ? options : { error: 'at least one artifact is required' };
}
function inputFailure(code, message, artifactIndex) {
  return Object.assign(new Error(message), { code, artifactIndex });
}
function stableIdentityValue(value) {
  if (typeof value === 'bigint' && value >= 0n) return value.toString(10);
  if (Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}
function safeStatSize(stat, artifactIndex) {
  const value = stat.size;
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw inputFailure('CONTRACT_LIMIT_EXCEEDED', 'file size is outside the supported range', artifactIndex);
    return Number(value);
  }
  if (!Number.isSafeInteger(value) || value < 0) throw inputFailure('CONTRACT_LIMIT_EXCEEDED', 'file size is outside the supported range', artifactIndex);
  return value;
}
function preflightArtifactPaths(artifactPaths, fileSystem = fs) {
  let totalBytes = 0;
  return artifactPaths.map((artifactPath, index) => {
    const resolvedPath = path.resolve(artifactPath);
    const stat = fileSystem.lstatSync(resolvedPath, { bigint: true });
    const size = safeStatSize(stat, index);
    if (!stat.isFile() || stat.isSymbolicLink() || size > MAX_INPUT_BYTES) {
      throw inputFailure('CONTRACT_LIMIT_EXCEEDED', 'unsafe or oversized input', index);
    }
    const dev = stableIdentityValue(stat.dev);
    const ino = stableIdentityValue(stat.ino);
    if (dev === null || ino === null) throw inputFailure('INPUT_IDENTITY_UNAVAILABLE', 'stable file identity is unavailable', index);
    totalBytes += size;
    if (totalBytes > MAX_TOTAL_INPUT_BYTES) {
      throw inputFailure('CONTRACT_LIMIT_EXCEEDED', 'total input bytes exceed their limit', index);
    }
    return { resolvedPath, dev, ino, size };
  });
}
function closeArtifactHandles(handles, fileSystem) {
  let firstError = null;
  for (const handle of handles) {
    try { fileSystem.closeSync(handle.fd); }
    catch (caught) { if (!firstError) firstError = caught; }
  }
  return firstError;
}
function openValidatedArtifactHandles(preflightEntries, fileSystem = fs) {
  const handles = [];
  let openedTotalBytes = 0;
  try {
    for (let index = 0; index < preflightEntries.length; index += 1) {
      const entry = preflightEntries[index];
      const fd = fileSystem.openSync(entry.resolvedPath, 'r');
      const handle = { fd, resolvedPath: entry.resolvedPath, size: 0, preflightSize: entry.size, artifactIndex: index };
      handles.push(handle);
      const descriptorStat = fileSystem.fstatSync(fd, { bigint: true });
      const pathStat = fileSystem.lstatSync(entry.resolvedPath, { bigint: true });
      if (!descriptorStat.isFile() || !pathStat.isFile() || pathStat.isSymbolicLink()) {
        throw inputFailure('INPUT_IDENTITY_CHANGED', 'input path no longer names a regular non-link file', index);
      }
      const descriptorDev = stableIdentityValue(descriptorStat.dev);
      const descriptorIno = stableIdentityValue(descriptorStat.ino);
      const pathDev = stableIdentityValue(pathStat.dev);
      const pathIno = stableIdentityValue(pathStat.ino);
      if (descriptorDev === null || descriptorIno === null || pathDev === null || pathIno === null
        || descriptorDev !== String(entry.dev) || descriptorIno !== String(entry.ino)
        || pathDev !== descriptorDev || pathIno !== descriptorIno) {
        throw inputFailure('INPUT_IDENTITY_CHANGED', 'input identity changed after metadata preflight', index);
      }
      const descriptorSize = safeStatSize(descriptorStat, index);
      const pathSize = safeStatSize(pathStat, index);
      if (descriptorSize > MAX_INPUT_BYTES || pathSize > MAX_INPUT_BYTES) {
        throw inputFailure('CONTRACT_LIMIT_EXCEEDED', 'opened input exceeds its byte limit', index);
      }
      handle.size = descriptorSize;
      handle.pathSize = pathSize;
      openedTotalBytes += descriptorSize;
      if (openedTotalBytes > MAX_TOTAL_INPUT_BYTES) {
        throw inputFailure('CONTRACT_LIMIT_EXCEEDED', 'opened input transaction exceeds its byte limit', index);
      }
    }
    for (const handle of handles) {
      if (handle.size !== handle.preflightSize || handle.pathSize !== handle.size) {
        throw inputFailure('INPUT_IDENTITY_CHANGED', 'input size changed after metadata preflight', handle.artifactIndex);
      }
      delete handle.preflightSize;
      delete handle.pathSize;
    }
    return handles;
  } catch (caught) {
    closeArtifactHandles(handles, fileSystem);
    throw caught;
  }
}
function readValidatedArtifactHandles(handles, fileSystem = fs) {
  const artifacts = [];
  let actualTotalBytes = 0;
  let primaryError = null;
  try {
    for (let index = 0; index < handles.length; index += 1) {
      const handle = handles[index];
      const buffer = Buffer.alloc(handle.size);
      let offset = 0;
      while (offset < buffer.length) {
        const bytesRead = fileSystem.readSync(handle.fd, buffer, offset, buffer.length - offset, null);
        if (!Number.isSafeInteger(bytesRead) || bytesRead < 1 || bytesRead > buffer.length - offset) {
          throw inputFailure('INPUT_IDENTITY_CHANGED', 'input size changed during handle-bound read', index);
        }
        offset += bytesRead;
        actualTotalBytes += bytesRead;
        if (actualTotalBytes > MAX_TOTAL_INPUT_BYTES) throw inputFailure('CONTRACT_LIMIT_EXCEEDED', 'actual input bytes exceed their transaction limit', index);
      }
      const extraByte = Buffer.allocUnsafe(1);
      const extraRead = fileSystem.readSync(handle.fd, extraByte, 0, 1, null);
      if (extraRead !== 0) throw inputFailure('CONTRACT_LIMIT_EXCEEDED', 'input grew beyond its approved byte length', index);
      try { artifacts.push(JSON.parse(buffer.toString('utf8'))); }
      catch (caught) { caught.artifactIndex = index; throw caught; }
    }
    return artifacts;
  } catch (caught) {
    primaryError = caught;
    throw caught;
  } finally {
    const closeError = closeArtifactHandles(handles, fileSystem);
    if (closeError && !primaryError) throw closeError;
  }
}
function serialize(result) { return { valid: result.valid, errors: result.errors.map((error) => ({ code: error.code, path: error.path, message: error.message })), warnings: result.warnings.map((warning) => ({ code: warning.code, path: warning.path, message: warning.message })) }; }
function runCli(args) {
  const options = parseArgs(args); if (options.error) { const code = options.errorCode || 'USAGE'; const stream = options.errorCode ? process.stdout : process.stderr; stream.write(`${JSON.stringify({ valid: false, errors: [metadataError(code, '$', options.error)] })}\n`); return options.errorCode ? 2 : 64; }
  let artifacts;
  try {
    const preflightEntries = preflightArtifactPaths(options.artifacts);
    const handles = openValidatedArtifactHandles(preflightEntries);
    artifacts = readValidatedArtifactHandles(handles);
  } catch (caught) {
    const code = caught && caught.code === 'CONTRACT_LIMIT_EXCEEDED' ? 'CONTRACT_LIMIT_EXCEEDED'
      : caught && ['INPUT_IDENTITY_CHANGED', 'INPUT_IDENTITY_UNAVAILABLE'].includes(caught.code) ? caught.code : 'INPUT_PARSE_ERROR';
    const index = Number.isSafeInteger(caught && caught.artifactIndex) ? caught.artifactIndex : 0;
    process.stdout.write(`${JSON.stringify({ valid: false, errors: [metadataError(code, `$[${index}]`, 'artifact input could not be parsed safely')] })}\n`);
    return 2;
  }
  let result;
  try { result = contracts.validateArtifactSet(artifacts, options); } catch (_) { result = { valid: false, errors: [metadataError('VALIDATOR_REJECTED', '$', 'validator rejected input')], warnings: [] }; }
  process.stdout.write(`${JSON.stringify(serialize(result))}\n`); return result.valid ? 0 : 2;
}
if (require.main === module) process.exitCode = runCli(process.argv.slice(2));
module.exports = { ...contracts, canonicalize, computeContentSha256, parseArgs, preflightArtifactPaths, openValidatedArtifactHandles, readValidatedArtifactHandles, runCli };
