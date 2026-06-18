#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { writeFile, unlink, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';
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

const CODEX_BIN = resolveCodexPath();

const PROFILES = {
  fast:     { model: 'gpt-5.4-mini', mode: 'strict'  },
  balanced: { model: 'gpt-5.4',      mode: 'yolo'    },
  max:      { model: 'gpt-5.5',      mode: 'yolo'    },
};

const TOOL_DEF = {
  name: 'gpt',
  description: `Delegate a task to GPT via Codex CLI. v2: session resume, profiles (fast/balanced/max), effort control, auto-context file collection. v1 params fully supported. GPT excels at: long-form text generation, code translation between languages, creative brainstorming, and independent sub-module creation. Returns the complete GPT response when done.`,
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'Task description sent to GPT. Be specific about expected output.',
      },
      sessionId: {
        type: 'string',
        description: 'Resume a previous GPT session by id. Omit to start a new session.',
      },
      model: {
        type: 'string',
        description: 'OpenAI model. Default: gpt-5.5. Mutually exclusive with profile.',
      },
      mode: {
        type: 'string',
        enum: ['yolo', 'strict'],
        description: 'Sandbox mode. yolo = full access, strict = read-only. Default: yolo. Mutually exclusive with profile.',
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
        enum: ['low', 'medium', 'high', 'xhigh'],
        description: 'Reasoning effort. Default: codex config default',
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
        description: 'Preset model+mode combo. Mutually exclusive with model/mode.',
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
  for (const relPath of filePaths) {
    try {
      const absPath = join(cwd, relPath);
      contents.push(await readFile(absPath, 'utf-8'));
    } catch {
      missing.push(relPath);
      contents.push(null);
    }
  }
  return { contents, missing };
}

async function autoCollectFiles({ patterns, cwd, maxFiles, maxSizeKB, explicitFiles }) {
  const maxF = maxFiles || 10;
  const maxSize = (maxSizeKB || 50) * 1024;
  const explicitSet = new Set(explicitFiles || []);
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
        if (explicitSet.has(relPath)) continue;
        try {
          const absPath = join(cwd, relPath);
          const { stat } = await import('fs/promises');
          const fileStat = await stat(absPath).catch(() => null);
          if (!fileStat || fileStat.size > maxSize) continue;
          const content = await readFile(absPath, 'utf-8');
          collected.push({ path: relPath, content });
        } catch { /* skip unreadable */ }
      }
    } catch { /* skip invalid glob */ }
  }
  return collected;
}

async function runCodex({ prompt, model, mode, files, images, outputSchema, outputFile, systemPrompt, cwd, timeout, effort, sessionId, autoContext }) {
  const effectiveCwd = cwd || process.cwd();
  let args;
  if (sessionId) {
    args = ['exec', 'resume', sessionId, '--ephemeral', '-p', mode || 'yolo', '--color', 'never', '--skip-git-repo-check'];
  } else {
    args = ['exec', '-p', mode || 'yolo', '--color', 'never', '--skip-git-repo-check'];
    if (model) args.push('-m', model);
  }
  if (images) for (const img of images) args.push('-i', img);

  let schemaFile = null;
  if (outputSchema) {
    schemaFile = join(tmpdir(), `gpt-bridge-schema-${randomUUID()}.json`);
    await writeFile(schemaFile, JSON.stringify(outputSchema), 'utf-8');
    args.push('--output-schema', schemaFile);
  }

  if (outputFile) args.push('-o', outputFile);
  if (effort) args.push('-c', `model_reasoning_effort=${effort}`);
  args.push('-C', effectiveCwd);
  args.push('-');

  let fileContents = [];
  if (files && files.length > 0) {
    const result = await readFiles(files, effectiveCwd);
    fileContents = result.contents;
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

  const stdin = buildStdin({ prompt, systemPrompt, files, fileContents, autoCollected });

  return new Promise((resolve) => {
    const proc = spawn(CODEX_BIN, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: effectiveCwd,
      timeout: (timeout || 300) * 1000,
      shell: process.platform === 'win32',
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (err) => {
      resolve({ success: false, error: `Failed to start codex: ${err.message}. Is Codex CLI installed?` });
    });

    proc.on('close', async (code) => {
      if (schemaFile) { try { await unlink(schemaFile); } catch {} }
      if (code === 0) {
        const output = stdout.trim();
        // session id is on stderr (codex header output)
        const sessionMatch = stderr.match(/session id:\s*([a-f0-9-]+)/i);
        // Strip codex header from stderr and prepend to result if useful
        const stderrClean = stderr
          .split('\n')
          .filter(l => l.trim() && !l.includes('---') && !l.includes('OpenAI Codex'))
          .join('\n');
        resolve({
          success: true,
          result: output,
          model: model || 'gpt-5.5',
          sessionId: sessionMatch ? sessionMatch[1] : null,
        });
      } else {
        const stderrClean = stderr
          .split('\n')
          .filter(l => !l.includes('Tracing initialized') && !l.includes('OpenAI Codex') && !l.includes('---') && !l.includes('workdir:') && !l.includes('model:') && !l.includes('provider:') && !l.includes('approval:') && !l.includes('sandbox:') && !l.includes('reasoning') && !l.includes('session id:'))
          .join('\n').trim();
        if (code === null) {
          const msg = stdout.trim() || stderrClean || 'Process terminated (possibly timeout, signal, or output size limit)';
          resolve({ success: true, result: msg, model: model || 'gpt-5.5' });
        } else {
          resolve({ success: false, error: stderrClean || `codex exited with code ${code}` });
        }
      }
    });

    proc.stdin.write(stdin);
    proc.stdin.end();
  });
}

const server = new Server(
  { name: 'gpt-bridge', version: '2.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [TOOL_DEF],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'gpt') {
    return { content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }], isError: true };
  }

  const args = request.params.arguments;

  // Profile conflicts with model/mode
  if (args.profile && (args.model || args.mode)) {
    return { content: [{ type: 'text', text: 'profile is mutually exclusive with model and mode' }], isError: true };
  }

  // Resolve profile
  let model = args.model;
  let mode = args.mode;
  if (args.profile) {
    const p = PROFILES[args.profile];
    model = p.model;
    mode = p.mode;
  }

  const result = await runCodex({
    prompt: args.prompt,
    model,
    mode,
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
  });

  if (result.success) {
    return { content: [{ type: 'text', text: result.result }] };
  } else {
    return { content: [{ type: 'text', text: result.error }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('gpt-bridge fatal:', err.message);
  process.exit(1);
});
