#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import spawn from 'cross-spawn';
import { randomUUID } from 'crypto';
import { mkdir, writeFile, unlink, readFile, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { pathToFileURL } from 'url';
import { existsSync, createWriteStream } from 'fs';
import { glob } from 'glob';

// Resolve codex binary: prefer CODEX_PATH env, then PATH, then common locations
function resolveCodexPath() {
  if (process.env.CODEX_PATH && existsSync(process.env.CODEX_PATH)) {
    return process.env.CODEX_PATH;
  }
  const npmGlobalBin = process.platform === 'win32'
    ? join(process.env.APPDATA || join(process.env.HOME, 'AppData', 'Roaming'), 'npm', 'codex.cmd')
    : join(process.env.HOME || '/', '.npm-global', 'bin', 'codex');
  if (existsSync(npmGlobalBin)) {
    return npmGlobalBin;
  }
  const localBin = join(process.env.HOME || '/', '.local', 'bin', 'codex');
  if (existsSync(localBin)) {
    return localBin;
  }
  return process.platform === 'win32' ? 'codex.cmd' : 'codex';
}

function normalizeProjectPath(filePath) {
  return String(filePath || '').replace(/\\/g, '/');
}

const PROFILES = {
  fast:     { model: 'gpt-6.1-terra', mode: 'strict',    effort: 'low' },
  balanced: { model: 'gpt-6.1-sol',   mode: 'workspace', effort: 'medium' },
  max:      { model: 'gpt-6-astra',   mode: 'full',      effort: 'high' },
};

const DEFAULT_MODEL = 'gpt-6.1-sol';
const DEFAULT_EFFORT = 'medium';
const EFFORTS = new Set(['low', 'medium', 'high']);

const SANDBOX_BY_MODE = {
  strict: 'read-only',
  readOnly: 'read-only',
  readonly: 'read-only',
  workspace: 'workspace-write',
  workspaceWrite: 'workspace-write',
  yolo: 'danger-full-access',
  full: 'danger-full-access',
  danger: 'danger-full-access',
};

const TOOL_DEF = {
  name: 'gpt',
  description: `Delegate a task to GPT via Codex CLI. v2: persistent session resume, profiles (fast/balanced/max), effort control, auto-context file collection. v1 params fully supported. GPT excels at: long-form text generation, code translation between languages, creative brainstorming, and independent sub-module creation. Returns the complete GPT response and exposes Codex session data as MCP metadata when available. Codex sessions cannot be imported as native Claude Code conversation turns; the tool result is the synchronization boundary.`,
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'Task description sent to GPT. Be specific about expected output.',
      },
      sessionId: {
        type: 'string',
        description: 'Resume a previous Codex/GPT session by id. Omit to start a new session. Successful tool output includes the session id when Codex exposes one.',
      },
      model: {
        type: 'string',
        description: 'Explicit model ID. Default: gpt-6.1-sol, also on resume. The caller must verify that an explicit ID is permitted and supported by its Codex provider. Mutually exclusive with profile.',
      },
      mode: {
        type: 'string',
        enum: ['strict', 'workspace', 'yolo', 'full'],
        description: 'Sandbox mode. strict = read-only, workspace = workspace-write, yolo/full = danger-full-access. Default: workspace. Mutually exclusive with profile.',
      },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Project-relative file paths to inject as context',
      },
      images: {
        type: 'array',
        items: { type: 'string' },
        description: 'Image file paths to attach (via codex -i)',
      },
      outputSchema: {
        type: 'object',
        description: 'JSON Schema to constrain GPT output as structured JSON',
      },
      outputFile: {
        type: 'string',
        description: 'File path to write GPT output (also returned inline)',
      },
      systemPrompt: {
        type: 'string',
        description: 'Override the default system prompt',
      },
      cwd: {
        type: 'string',
        description: 'Working directory. Defaults to the current project root.',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in seconds. Default: 300',
      },
      effort: {
        type: 'string',
        enum: ['low', 'medium', 'high'],
        description: 'Reasoning effort. Default: medium, or the selected profile effort. An explicit effort overrides the profile effort. Provider support must be checked by the caller.',
      },
      ephemeral: {
        type: 'boolean',
        description: 'Run without persisting Codex session updates. Default: false so later calls can resume the same Codex thread.',
      },
      autoContext: {
        type: 'object',
        properties: {
          patterns: {
            type: 'array',
            items: { type: 'string' },
            description: 'Glob patterns to auto-collect files (e.g. ["src/**/*.ts"])',
          },
          maxFiles: {
            type: 'number',
            description: 'Max files to collect. Default: 10',
          },
          maxSizeKB: {
            type: 'number',
            description: 'Max size per file in KB. Default: 50',
          },
        },
        required: ['patterns'],
        description: 'Auto-collect matching files as GPT context (Layer 2)',
      },
      profile: {
        type: 'string',
        enum: ['fast', 'balanced', 'max'],
        description: 'Preset model, effort and sandbox: fast = gpt-6.1-terra/low/read-only; balanced = gpt-6.1-sol/medium/workspace-write; max = gpt-6-astra/high/danger-full-access (bypasses approvals and sandbox). Use max only with authorization for that permission mode. Mutually exclusive with model/mode.',
      },
    },
    required: ['prompt'],
  },
};

function buildStdin({ prompt, systemPrompt, files, fileContents, autoCollected }) {
  const parts = [];
  if (systemPrompt) {
    parts.push(systemPrompt);
    parts.push('\n---\n');
  }
  parts.push('## Task\n\n');
  parts.push(prompt);
  if (files && files.length > 0) {
    parts.push('\n\n## Context Files\n');
    for (let i = 0; i < files.length; i++) {
      const path = files[i];
      const content = fileContents[i] || '(file not readable)';
      parts.push(`\n### File: ${path}\n\`\`\`\n${content}\n\`\`\`\n`);
    }
  }
  if (autoCollected && autoCollected.length > 0) {
    parts.push('\n\n## Auto-Collected Context\n');
    for (const file of autoCollected) {
      parts.push(`\n### File: ${file.path} (matched)\n\`\`\`\n${file.content}\n\`\`\`\n`);
    }
  }
  return parts.join('');
}

async function readFiles(filePaths, cwd) {
  const contents = [];
  const missing = [];
  const invalid = [];
  for (const relPath of filePaths) {
    let absPath;
    try {
      absPath = resolveProjectFilePath(relPath, cwd);
    } catch (error) {
      invalid.push(error.message);
      contents.push(null);
      continue;
    }
    try {
      contents.push(await readFile(absPath, 'utf-8'));
    } catch {
      missing.push(relPath);
      contents.push(null);
    }
  }
  return { contents, missing, invalid };
}

async function autoCollectFiles({ patterns, cwd, maxFiles, maxSizeKB, explicitFiles }) {
  const maxF = maxFiles || 10;
  const maxSize = (maxSizeKB || 50) * 1024;
  const explicitSet = new Set((explicitFiles || []).map(normalizeProjectPath));
  const collected = [];

  for (const pattern of patterns) {
    if (collected.length >= maxF) break;
    try {
      const matches = await glob(pattern, {
        cwd, nodir: true, absolute: false,
        windowsPathsNoEscape: process.platform === 'win32',
      });
      for (const relPath of matches) {
        if (collected.length >= maxF) break;
        const normalizedRelPath = normalizeProjectPath(relPath);
        if (explicitSet.has(normalizedRelPath)) continue;
        try {
          const absPath = resolveUserPath(relPath, cwd);
          const fileStat = await stat(absPath).catch(() => null);
          if (!fileStat || fileStat.size > maxSize) continue;
          const content = await readFile(absPath, 'utf-8');
          collected.push({ path: normalizedRelPath, content });
        } catch { /* skip unreadable */ }
      }
    } catch { /* skip invalid glob */ }
  }
  return collected;
}

function resolveUserPath(filePath, cwd) {
  if (!filePath) return filePath;
  return isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
}

function resolveProjectFilePath(filePath, cwd) {
  if (!filePath) throw new Error('File path is required');
  if (isAbsolute(filePath)) {
    throw new Error(`Absolute file paths are not allowed: ${filePath}`);
  }
  const root = resolve(cwd);
  const absPath = resolve(root, filePath);
  const relPath = relative(root, absPath);
  if (relPath === '..' || relPath.startsWith(`..${sep}`) || isAbsolute(relPath)) {
    throw new Error(`File path escapes project root: ${filePath}`);
  }
  return absPath;
}

function codexSandboxArgs(mode) {
  const selectedMode = mode === undefined ? 'workspace' : mode;
  if (typeof selectedMode !== 'string' || !Object.hasOwn(SANDBOX_BY_MODE, selectedMode)) {
    throw new Error(`Invalid mode: ${mode}`);
  }
  const sandbox = SANDBOX_BY_MODE[selectedMode];
  if (sandbox === 'danger-full-access') return ['--dangerously-bypass-approvals-and-sandbox'];
  return ['--sandbox', sandbox];
}

function selectInvocation({ model, mode, effort, profile }) {
  if (profile !== undefined) {
    if (typeof profile !== 'string' || !Object.hasOwn(PROFILES, profile)) {
      throw new Error(`Invalid profile: ${profile}`);
    }
    if (model !== undefined || mode !== undefined) {
      throw new Error('profile is mutually exclusive with model and mode');
    }
  }
  if (model !== undefined && (typeof model !== 'string' || !model.trim())) {
    throw new Error('model must be a non-empty string');
  }
  if (effort !== undefined && !EFFORTS.has(effort)) {
    throw new Error(`Invalid effort: ${effort}`);
  }
  const preset = profile === undefined ? undefined : PROFILES[profile];
  const selectedMode = preset?.mode ?? (mode === undefined ? 'workspace' : mode);
  codexSandboxArgs(selectedMode);
  return {
    model: model === undefined ? (preset?.model ?? DEFAULT_MODEL) : model.trim(),
    mode: selectedMode,
    effort: effort ?? preset?.effort ?? DEFAULT_EFFORT,
    modelSelection: preset ? 'profile' : model === undefined ? 'bridge_default' : 'explicit_request',
  };
}

function extractSessionId(stderr, stdout) {
  // 1) Try JSONL stdout (codex --json mode): thread.started event carries thread_id
  const jsonLines = (stdout || '').split('\n').filter(Boolean);
  for (const line of jsonLines) {
    try {
      const evt = JSON.parse(line);
      if (evt.type === 'thread.started' && evt.thread_id) {
        return evt.thread_id;
      }
    } catch { /* skip non-JSON lines */ }
  }

  // 2) Fallback text patterns (codex without --json, or stderr preamble)
  const combined = `${stderr || ''}\n${stdout || ''}`;
  const patterns = [
    /session id:\s*([^\s]+)/i,
    /"session_id"\s*:\s*"([^"]+)"/i,
    /"sessionId"\s*:\s*"([^"]+)"/i,
  ];
  for (const pattern of patterns) {
    const match = combined.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function formatToolResult(result) {
  if (!result.sessionId) return result.result || '';
  return [
    '<gpt-bridge-session>',
    `sessionId: ${result.sessionId}`,
    `continueWith: ${JSON.stringify({ sessionId: result.sessionId })}`,
    'note: This preserves Codex-side continuity. Claude Code does not import Codex sessions as native Claude conversation turns; this tool result is the sync boundary.',
    '</gpt-bridge-session>',
    '',
    result.result || '',
  ].join('\n').trim();
}

function parseStructuredContent(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return { value: parsed };
  } catch {
    return undefined;
  }
}

function parseJsonlEvents(text) {
  return (text || '')
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

function extractJsonlErrors(events) {
  const messages = [];
  for (const event of events) {
    if (event.type === 'error' && event.message) {
      messages.push(event.message);
    } else if (event.type === 'turn.failed' && event.error?.message) {
      messages.push(event.error.message);
    }
  }
  return messages;
}

function buildToolResponse(result, { preserveRawText = false } = {}) {
  const response = {
    content: [{
      type: 'text',
      text: preserveRawText ? (result.result || '') : formatToolResult(result),
    }],
  };
  if (result.structuredContent) {
    response.structuredContent = result.structuredContent;
  }
  for (const field of ['modelSelection', 'requestedModel', 'requestedEffort', 'actualModel', 'actualEffort']) {
    if (result[field] !== undefined) {
      response._meta ??= {};
      response._meta[`gpt-bridge/${field}`] = result[field];
    }
  }
  if (result.sessionId) {
    response._meta = {
      ...response._meta,
      'gpt-bridge/sessionId': result.sessionId,
      'gpt-bridge/continueWith': { sessionId: result.sessionId },
    };
  }
  return response;
}

async function runCodex({ prompt, model, mode, files, images, outputSchema, outputFile, systemPrompt, cwd, timeout, effort, sessionId, autoContext, ephemeral, profile }) {
  let selection;
  try {
    selection = selectInvocation({ model, mode, effort, profile });
  } catch (error) {
    return { success: false, error: error.message };
  }
  ({ model, mode, effort } = selection);
  // CLI arguments identify the request, not the model actually used by a provider.
  const modelMetadata = {
    model: 'unknown',
    modelSelection: selection.modelSelection,
    requestedModel: model,
    requestedEffort: effort,
    actualModel: 'unknown',
    actualEffort: 'unknown',
  };
  const effectiveCwd = cwd || process.cwd();
  const sandboxArgs = codexSandboxArgs(mode);

  let fileContents = [];
  if (files && files.length > 0) {
    const result = await readFiles(files, effectiveCwd);
    fileContents = result.contents;
    if (result.invalid.length > 0) {
      return { success: false, error: result.invalid.join('; ') };
    }
    if (result.missing.length > 0) {
      return { success: false, error: `Files not found: ${result.missing.join(', ')}` };
    }
  }

  // Auto-context collection
  let autoCollected = [];
  if (autoContext && autoContext.patterns && autoContext.patterns.length > 0) {
    autoCollected = await autoCollectFiles({
      patterns: autoContext.patterns,
      cwd: effectiveCwd,
      maxFiles: autoContext.maxFiles,
      maxSizeKB: autoContext.maxSizeKB,
      explicitFiles: files || [],
    });
  }

  let schemaFile = null;
  if (outputSchema) {
    schemaFile = join(tmpdir(), `gpt-bridge-schema-${randomUUID()}.json`);
    // OpenAI API requires additionalProperties: false at the root level.
    const safeSchema = { ...outputSchema, additionalProperties: false };
    await writeFile(schemaFile, JSON.stringify(safeSchema), 'utf-8');
  }

  // Always route final output through a file (-o) to avoid stdout buffer truncation
  const finalOutputFile = outputFile ? resolveUserPath(outputFile, effectiveCwd) : join(tmpdir(), `gpt-bridge-out-${randomUUID()}.txt`);
  await mkdir(dirname(finalOutputFile), { recursive: true });

  // Progress file for real-time tailing (JSONL events written as they arrive)
  const progressFile = join(tmpdir(), `gpt-bridge-progress-${randomUUID()}.log`);

  const resolvedImages = (images || []).map((img) => resolveUserPath(img, effectiveCwd));
  const args = ['exec', ...sandboxArgs];
  if (sessionId) {
    // `codex exec resume` only accepts sandbox and cwd-related options before the
    // `resume` subcommand. Resume-specific options must precede SESSION_ID.
    args.push('resume', '--skip-git-repo-check');
    if (model) args.push('-m', model);
    if (schemaFile) args.push('--output-schema', schemaFile);
    args.push('--json', '-o', finalOutputFile);
    if (effort) args.push('-c', `model_reasoning_effort=${effort}`);
    for (const img of resolvedImages) args.push('-i', img);
    if (ephemeral) args.push('--ephemeral');
    args.push(sessionId, '-');
  } else {
    args.push('--color', 'never', '--skip-git-repo-check');
    if (model) args.push('-m', model);
    for (const img of resolvedImages) args.push('-i', img);
    if (schemaFile) args.push('--output-schema', schemaFile);
    // --json: stream JSONL events to stdout for real-time progress + work log
    args.push('--json', '-o', finalOutputFile);
    if (effort) args.push('-c', `model_reasoning_effort=${effort}`);
    if (ephemeral) args.push('--ephemeral');
    args.push('-C', effectiveCwd, '-');
  }

  const stdin = buildStdin({ prompt, systemPrompt, files, fileContents, autoCollected });

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const proc = spawn(resolveCodexPath(), args, {
      stdio: ['pipe', 'pipe', 'pipe'],  // stdin + stdout (JSONL) + stderr
      cwd: effectiveCwd,
      shell: false,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGTERM'); } catch {}
    }, (timeout || 300) * 1000);

    let stderr = '';
    let stdout = '';
    const progressStream = createWriteStream(progressFile);

    // Stream JSONL events to progress file in real-time for `tail -f`
    proc.stdout.on('data', (d) => {
      const chunk = d.toString();
      if (stdout.length < 65536) stdout += chunk;
      progressStream.write(d);
    });
    proc.stderr.on('data', (d) => {
      if (stderr.length < 8192) stderr += d.toString();
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      progressStream.end();
      resolve({ success: false, error: `Failed to start codex: ${err.message}. Is Codex CLI installed?` });
    });

    proc.on('close', async (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      progressStream.end();
      if (schemaFile) { try { await unlink(schemaFile); } catch {} }

      // Read final answer from -o file (bypasses stdout buffer truncation)
      let output = '';
      try {
        output = await readFile(finalOutputFile, 'utf-8');
      } catch {
        // File may not exist on crash/timeout
      }

      // Clean up temp output file (only if we created it, not caller-provided)
      if (!outputFile) {
        try { await unlink(finalOutputFile); } catch {}
      }

      // Parse JSONL progress file for detailed work log
      // codex --json events: item.started, item.completed, assistant.message, error
      let workLog = '';
      let progressEvents = [];
      try {
        const raw = await readFile(progressFile, 'utf-8');
        progressEvents = parseJsonlEvents(raw);

        const turns = progressEvents.filter(e => e.type === 'turn.started');
        const items = progressEvents.filter(e => e.type === 'item.started' || e.type === 'item.completed');
        const errors = progressEvents.filter(e => e.type === 'error');
        const msgs = progressEvents.filter(e => e.type === 'assistant.message');

        const parts = [`### GPT Work Log · ${turns.length} turns · ${items.length} events`];
        parts.push('');

        // Show each completed item with its command and output
        for (const e of items) {
          if (e.type === 'item.started') {
            const it = e.item || {};
            const cmd = (it.command || '').trim();
            if (cmd) {
              const shortCmd = cmd.length > 120 ? cmd.slice(0, 117) + '...' : cmd;
              parts.push(`  RUN  ${shortCmd}`);
            }
          } else if (e.type === 'item.completed') {
            const it = e.item || {};
            const status = it.status || '?';
            const output = (it.aggregated_output || '').trim();
            if (output) {
              const shortOut = output.length > 200 ? output.slice(0, 197) + '...' : output;
              parts.push(`  OK   ${shortOut.split('\n')[0]}`);
            } else if (status !== 'completed') {
              parts.push(`  ${status.toUpperCase()}`);
            }
          }
        }

        // Show thinking messages (concise)
        for (const m of msgs) {
          const text = (m.message || m.text || '').trim();
          if (text && text.length < 200) {
            parts.push(`  💭 ${text}`);
          } else if (text) {
            parts.push(`  💭 ${text.slice(0, 197)}...`);
          }
        }

        if (errors.length) {
          parts.push('');
          parts.push(`Errors: ${errors.length}`);
          for (const e of errors) parts.push(`  ❌ ${(e.message || JSON.stringify(e)).slice(0, 120)}`);
        }

        workLog = parts.join('\n');
      } catch {
        workLog = '(work log unavailable)';
      }

      // Clean up progress file
      try { await unlink(progressFile); } catch {}

      // Parse session id from stderr
      const detectedSessionId = extractSessionId(stderr, stdout);

      if (code === 0) {
        const outputText = output.trim();
        const structuredContent = outputSchema ? parseStructuredContent(outputText) : undefined;
        const resultText = outputSchema ? outputText : outputText + (workLog ? '\n\n' + workLog : '');
        resolve({
          success: true,
          result: resultText,
          ...modelMetadata,
          sessionId: detectedSessionId,
          structuredContent,
        });
      } else {
        const jsonErrors = extractJsonlErrors(progressEvents);
        const stderrClean = stderr
          .split('\n')
          .filter(l => !l.includes('Tracing initialized') && !l.includes('OpenAI Codex') && !l.includes('---') && !l.includes('workdir:') && !l.includes('model:') && !l.includes('provider:') && !l.includes('approval:') && !l.includes('sandbox:') && !l.includes('reasoning') && !l.includes('session id:'))
          .join('\n').trim();
        const combinedError = [stderrClean, ...jsonErrors].filter(Boolean).join('; ');
        if (timedOut) {
          resolve({ success: false, error: `codex timed out after ${timeout || 300}s${combinedError ? `: ${combinedError}` : ''}` });
        } else if (code === null) {
          const msg = combinedError || output.trim() || 'Process terminated by signal';
          resolve({ success: false, error: msg });
        } else {
          resolve({ success: false, error: combinedError || `codex exited with code ${code}` });
        }
      }
    });

    proc.stdin.write(stdin);
    proc.stdin.end();
  });
}

const server = new Server(
  { name: 'gpt-bridge', version: '2.0.1' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [TOOL_DEF],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'gpt') {
    return { content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }], isError: true };
  }

  const args = request.params.arguments || {};
  if (!args.prompt || typeof args.prompt !== 'string') {
    return { content: [{ type: 'text', text: 'prompt is required' }], isError: true };
  }
  const result = await runCodex({
    prompt: args.prompt,
    model: args.model,
    mode: args.mode,
    profile: args.profile,
    files: args.files,
    images: args.images,
    outputSchema: args.outputSchema,
    outputFile: args.outputFile,
    systemPrompt: args.systemPrompt,
    cwd: args.cwd,
    timeout: args.timeout,
    effort: args.effort,
    sessionId: args.sessionId,
    autoContext: args.autoContext,
    ephemeral: args.ephemeral,
  });

  if (result.success) {
    return buildToolResponse(result, { preserveRawText: Boolean(args.outputSchema) });
  } else {
    return { content: [{ type: 'text', text: result.error }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export {
  TOOL_DEF,
  PROFILES,
  SANDBOX_BY_MODE,
  buildStdin,
  readFiles,
  autoCollectFiles,
  normalizeProjectPath,
  resolveUserPath,
  resolveProjectFilePath,
  codexSandboxArgs,
  extractSessionId,
  formatToolResult,
  buildToolResponse,
  runCodex,
  main,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('gpt-bridge fatal:', err.message);
    process.exit(1);
  });
}
