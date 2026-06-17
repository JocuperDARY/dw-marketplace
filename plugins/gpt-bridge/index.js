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

// Resolve codex binary: prefer CODEX_PATH env, then PATH, then common locations
function resolveCodexPath() {
  if (process.env.CODEX_PATH && existsSync(process.env.CODEX_PATH)) {
    return process.env.CODEX_PATH;
  }
  const npmGlobalBin = process.platform === 'win32'
    ? join(process.env.APPDATA || join(process.env.HOME, 'AppData', 'Roaming'), 'npm', 'codex')
    : join(process.env.HOME || '/', '.npm-global', 'bin', 'codex');
  if (existsSync(npmGlobalBin)) {
    return npmGlobalBin;
  }
  const localBin = join(process.env.HOME || '/', '.local', 'bin', 'codex');
  if (existsSync(localBin)) {
    return localBin;
  }
  return 'codex'; // fallback to PATH
}

const CODEX_BIN = resolveCodexPath();

const TOOL_DEF = {
  name: 'gpt',
  description: `Delegate a task to GPT via Codex CLI. GPT excels at: long-form text generation, code translation between languages, creative brainstorming, and independent sub-module creation. Returns the complete GPT response when done.`,
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'Task description sent to GPT. Be specific about expected output.',
      },
      model: {
        type: 'string',
        description: 'OpenAI model. Default: gpt-5.4',
      },
      mode: {
        type: 'string',
        enum: ['yolo', 'strict'],
        description: 'Sandbox mode. yolo = full access, strict = read-only. Default: yolo',
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
    },
    required: ['prompt'],
  },
};

function buildStdin({ prompt, systemPrompt, files, fileContents }) {
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

async function runCodex({ prompt, model, mode, files, images, outputSchema, outputFile, systemPrompt, cwd, timeout }) {
  const effectiveCwd = cwd || process.cwd();
  const args = ['exec', '-p', mode || 'yolo', '--color', 'never'];

  if (model) args.push('-m', model);
  if (images) for (const img of images) args.push('-i', img);

  let schemaFile = null;
  if (outputSchema) {
    schemaFile = join(tmpdir(), `gpt-bridge-schema-${randomUUID()}.json`);
    await writeFile(schemaFile, JSON.stringify(outputSchema), 'utf-8');
    args.push('--output-schema', schemaFile);
  }

  if (outputFile) args.push('-o', outputFile);
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

  const stdin = buildStdin({ prompt, systemPrompt, files, fileContents });

  return new Promise((resolve) => {
    const proc = spawn(CODEX_BIN, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: effectiveCwd,
      timeout: (timeout || 300) * 1000,
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
        resolve({ success: true, result: stdout.trim(), model: model || 'gpt-5.4' });
      } else {
        const stderrClean = stderr
          .split('\n')
          .filter(l => !l.includes('Tracing initialized'))
          .join('\n').trim();
        resolve({ success: false, error: `codex exited ${code}${stderrClean ? ': ' + stderrClean : ''}` });
      }
    });

    proc.stdin.write(stdin);
    proc.stdin.end();
  });
}

const server = new Server(
  { name: 'gpt-bridge', version: '1.0.0' },
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
  const result = await runCodex({
    prompt: args.prompt,
    model: args.model,
    mode: args.mode,
    files: args.files,
    images: args.images,
    outputSchema: args.outputSchema,
    outputFile: args.outputFile,
    systemPrompt: args.systemPrompt,
    cwd: args.cwd,
    timeout: args.timeout,
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
