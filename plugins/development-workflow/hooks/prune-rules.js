#!/usr/bin/env node
// Tool-Proact Rules Pruner — SessionStart
// Prunes ~/.claude/rules/ to only keep rules relevant to the current project.
// Unused language rules are backed up to ~/.claude/rules-store/ for on-demand access.
// A lazy-rules.md is maintained in the active rules dir with read-on-demand instructions.
//
// Self-updating: detects project tech stack each run, adapts kept rules accordingly.
// Safe to run multiple times — idempotent.

'use strict';

const fs = require('fs');
const path = require('path');

const HOME = process.env.HOME || process.env.USERPROFILE || '';
const RULES_DIR = path.join(HOME, '.claude', 'rules');
const STORE_DIR = path.join(HOME, '.claude', 'rules-store');
const STATE_FILE = path.join(STORE_DIR, '.state.json');

// All language-specific rule directories that can be pruned
const LANG_DIRS = new Set([
  'python', 'typescript', 'react', 'web',
  'rust', 'cpp', 'golang', 'java',
  'swift', 'kotlin', 'dart', 'csharp',
  'perl', 'php', 'fsharp', 'ruby',
  'angular', 'arkts', 'zh',
]);

// These are always kept in the active rules directory
const ALWAYS_KEEP = new Set(['common']);

// File extension to language mapping for auto-detection
const EXT_LANG_MAP = {
  '.py': 'python', '.pyi': 'python',
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript',
  '.js': 'typescript', '.jsx': 'typescript', '.mjs': 'typescript',
  '.rs': 'rust',
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.c++': 'cpp',
  '.h': 'cpp', '.hpp': 'cpp', '.hxx': 'cpp',
  '.go': 'golang',
  '.java': 'java',
  '.kt': 'kotlin', '.kts': 'kotlin',
  '.swift': 'swift',
  '.dart': 'dart',
  '.cs': 'csharp',
  '.pl': 'perl', '.pm': 'perl',
  '.php': 'php',
  '.fs': 'fsharp', '.fsx': 'fsharp',
  '.rb': 'ruby',
};

// ── Helpers ──

function readFileSafe(filePath) {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
}

function writeFileSafe(filePath, content) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    return true;
  } catch (e) {
    console.error(`[prune-rules] Failed to write ${filePath}: ${e.message}`);
    return false;
  }
}

function rmDirSafe(dirPath) {
  try {
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  } catch (e) {
    console.error(`[prune-rules] Failed to remove ${dirPath}: ${e.message}`);
  }
}

function copyDirSync(src, dest) {
  try {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        copyDirSync(srcPath, destPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        if (!fs.existsSync(destPath)) {
          fs.copyFileSync(srcPath, destPath);
        }
      }
    }
  } catch (e) {
    console.error(`[prune-rules] Copy failed ${src} -> ${dest}: ${e.message}`);
  }
}

// ── Language Detection ──

function detectProjectLanguages(projectDir) {
  const detected = new Set(ALWAYS_KEEP);
  let hasPackageJson = false;
  let packageJson = null;

  function scanDir(dir, depth) {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (['node_modules', '__pycache__', 'target', 'build', 'dist',
           '.git', 'venv', '.venv', '.egg-info', 'site-packages'].includes(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        scanDir(fullPath, depth + 1);
      } else {
        const ext = path.extname(entry.name);
        if (EXT_LANG_MAP[ext]) detected.add(EXT_LANG_MAP[ext]);
        if (entry.name === 'package.json') {
          hasPackageJson = true;
          try { packageJson = JSON.parse(fs.readFileSync(fullPath, 'utf-8')); } catch {}
        }
        if (['index.html', 'next.config.js', 'next.config.ts', 'nuxt.config.ts', 'vite.config.ts',
             'astro.config.mjs', 'svelte.config.js'].includes(entry.name)) {
          detected.add('web');
        }
      }
    }
  }

  try { scanDir(projectDir, 0); } catch {}

  // Enrich from package.json
  if (hasPackageJson && packageJson && packageJson.dependencies) {
    const deps = Object.keys(packageJson.dependencies);
    const devDeps = packageJson.devDependencies ? Object.keys(packageJson.devDependencies) : [];
    const allDeps = new Set([...deps, ...devDeps]);
    if (allDeps.has('react') || allDeps.has('react-dom')) detected.add('react');
    if (allDeps.has('next') || allDeps.has('gatsby') || allDeps.has('react-scripts')) {
      detected.add('react');
      detected.add('web');
    }
    if (allDeps.has('vue') || allDeps.has('@angular/core') || allDeps.has('svelte')) {
      detected.add('web');
    }
    if ((deps.length > 0 || devDeps.length > 0) &&
        (detected.has('typescript') || detected.has('react'))) {
      detected.add('web');
    }
  }

  // Default safe set if nothing specific detected
  if (detected.size <= 1) {
    detected.add('python');
    detected.add('typescript');
  }

  return detected;
}

// ── Rules Management ──

function ensureStoreExists() {
  if (!fs.existsSync(STORE_DIR)) {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    console.error('[prune-rules] Created rules-store at', STORE_DIR);
  }
}

function backupToStore() {
  ensureStoreExists();
  let backedUp = false;

  // First pass: copy from existing rules dir
  for (const langDir of LANG_DIRS) {
    const src = path.join(RULES_DIR, langDir);
    const dest = path.join(STORE_DIR, langDir);
    if (fs.existsSync(src) && !fs.existsSync(dest)) {
      try {
        const files = fs.readdirSync(src);
        if (files.some(f => f.endsWith('.md'))) {
          copyDirSync(src, dest);
          backedUp = true;
          console.error(`[prune-rules] Backed up ${langDir}/ to rules-store`);
        }
      } catch {}
    }
  }

  // Second pass: copy from ECC plugin cache for missing entries
  if (!backedUp) {
    const pluginDir = path.join(HOME, '.claude', 'plugins', 'cache');
    if (fs.existsSync(pluginDir)) {
      try {
        const eccCandidates = [];
        function findEccRules(dir, depth) {
          if (depth > 4) return;
          try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const e of entries) {
              if (e.isDirectory()) {
                const sub = path.join(dir, e.name);
                if (e.name === 'rules' && fs.existsSync(path.join(sub, 'common'))) {
                  eccCandidates.push(sub);
                } else {
                  findEccRules(sub, depth + 1);
                }
              }
            }
          } catch {}
        }
        findEccRules(pluginDir, 0);

        for (const rulesSrc of eccCandidates) {
          for (const langDir of LANG_DIRS) {
            const src = path.join(rulesSrc, langDir);
            const dest = path.join(STORE_DIR, langDir);
            if (fs.existsSync(src) && !fs.existsSync(dest)) {
              copyDirSync(src, dest);
              console.error(`[prune-rules] Restored ${langDir}/ from plugin cache`);
            }
          }
        }
      } catch {}
    }
  }
}

function pruneUnusedRules(keepLangs) {
  const toRemove = [];
  const toKeep = new Set([...ALWAYS_KEEP, ...keepLangs]);

  let entries;
  try { entries = fs.readdirSync(RULES_DIR, { withFileTypes: true }); }
  catch {
    console.error('[prune-rules] Cannot read rules directory');
    return [];
  }

  for (const entry of entries) {
    if (entry.isDirectory() && LANG_DIRS.has(entry.name) && !toKeep.has(entry.name)) {
      toRemove.push(entry.name);
    }
  }

  for (const dirName of toRemove) {
    const dirPath = path.join(RULES_DIR, dirName);
    const storePath = path.join(STORE_DIR, dirName);
    if (!fs.existsSync(storePath)) {
      copyDirSync(dirPath, storePath);
    }
    rmDirSafe(dirPath);
    console.error(`[prune-rules] Pruned ${dirName}/ (backed up to rules-store)`);
  }

  return toRemove;
}

// Restore kept language rules from rules-store back to active rules directory.
// pruneUnusedRules only removes — it does not restore. This function fills the gap:
// if a language is in keepLangs but missing from the active rules dir, copy it
// back from rules-store so lazy-rules.md's list is accurate.
function restoreKeptRules(keepLangs) {
  const restored = [];
  for (const lang of keepLangs) {
    if (lang === 'common') continue;
    const activePath = path.join(RULES_DIR, lang);
    const storePath = path.join(STORE_DIR, lang);
    if (fs.existsSync(activePath)) continue;
    if (!fs.existsSync(storePath)) {
      console.error(`[prune-rules] Cannot restore ${lang}/ — not found in rules-store`);
      continue;
    }
    copyDirSync(storePath, activePath);
    restored.push(lang);
    console.error(`[prune-rules] Restored ${lang}/ from rules-store`);
  }
  return restored;
}

function ensureLazyRulesMd(keepLangs) {
  const lazyRulesPath = path.join(RULES_DIR, 'lazy-rules.md');

  // Compute which stored languages have actual content
  const langLinks = [];
  const allDirs = [...LANG_DIRS].sort();
  for (const lang of allDirs) {
    if (keepLangs.has(lang)) continue;
    const storePath = path.join(STORE_DIR, lang);
    if (fs.existsSync(storePath)) {
      try {
        const files = fs.readdirSync(storePath).filter(f => f.endsWith('.md'));
        if (files.length > 0) {
          const label = lang.charAt(0).toUpperCase() + lang.slice(1);
          langLinks.push(
            `| ${label} | \`~/.claude/rules-store/${lang}/\` | ${files.join(', ')} |`
          );
        }
      } catch {}
    }
  }

  const preloaded = [...keepLangs].filter(l => l !== 'common')
    .map(l => `- ${l.charAt(0).toUpperCase() + l.slice(1)}`).join('\n')
    || '- 无（仅保留通用规则）';

  // Load template from DW plugin file, fall back to inline
  let template = null;
  try {
    const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || '';
    if (pluginRoot) {
      const tplPath = path.join(pluginRoot, 'rules', 'rules-lazy-load.md');
      if (fs.existsSync(tplPath)) template = fs.readFileSync(tplPath, 'utf-8');
    }
  } catch {}

  if (!template) {
    template = `# 按需加载规则库

## 概述

为了降低每次会话的初始上下文占用，语言/框架特定的规则文件已从活跃规则目录中移除，
并存放在 \`~/.claude/rules-store/\` 中。这些规则不会自动加载，但在需要时应当主动读取。

## 触发规则

当你遇到以下场景时，请**先读取对应的规则文件**，再继续回答：

1. **检测到特定语言的文件**（如 .tsx, .rs, .go, .java 等）— 读取对应语言规则
2. **用户提及特定框架**（如 React, Next.js, Spring Boot）— 读取对应规则
3. **生成新项目/模块** — 读取目标语言的规则以遵循项目编码规范

## 规则索引

| 语言/框架 | 存储位置 | 包含文件 |
|-----------|----------|----------|
{{LANG_LINKS}}

## 使用方法

当上述触发条件满足时，使用 \`Read\` 工具读取对应规则文件。例如：

- \`Read ~/.claude/rules-store/typescript/coding-style.md\`
- \`Read ~/.claude/rules-store/web/patterns.md\`

读取后，规则中的指令优先级与活跃规则相同。

## 已预加载的语言

以下语言的规则已直接加载，无需手动读取：
{{PRELOADED_LANGS}}
`;
  }

  const content = template
    .replace('{{LANG_LINKS}}', langLinks.join('\n'))
    .replace('{{PRELOADED_LANGS}}', preloaded);

  writeFileSafe(lazyRulesPath, content);
  console.error('[prune-rules] Updated lazy-rules.md');
}

// Deploy DW plugin's own rules to ~/.claude/rules/dw/
function deployDwRules() {
  try {
    const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || '';
    if (!pluginRoot) return;
    const srcRulesDir = path.join(pluginRoot, 'rules');
    if (!fs.existsSync(srcRulesDir)) return;
    const dwRulesDir = path.join(RULES_DIR, 'dw');
    if (!fs.existsSync(dwRulesDir)) fs.mkdirSync(dwRulesDir, { recursive: true });

    const srcFiles = fs.readdirSync(srcRulesDir).filter(f => f.endsWith('.md'));
    for (const f of srcFiles) {
      const src = path.join(srcRulesDir, f);
      const dst = path.join(dwRulesDir, f);
      try {
        const srcStat = fs.statSync(src);
        const dstExists = fs.existsSync(dst);
        if (!dstExists || srcStat.mtimeMs > fs.statSync(dst).mtimeMs) {
          fs.copyFileSync(src, dst);
        }
      } catch { try { fs.copyFileSync(src, dst); } catch {} }
    }
    if (srcFiles.length > 0) console.error(`[prune-rules] Deployed ${srcFiles.length} DW rules to rules/dw/`);
  } catch {}
}

function saveState(keepLangs, pruned, restored) {
  const state = {
    updatedAt: new Date().toISOString(),
    projectDir: process.cwd(),
    keepLangs: [...keepLangs],
    pruned,
    restored: restored || [],
  };
  writeFileSafe(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Main ──

function main() {
  const startTime = Date.now();

  // Step 1: Ensure store exists and has all language rules backed up
  ensureStoreExists();
  backupToStore();

  // Step 2: Detect project languages
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const keepLangs = detectProjectLanguages(projectDir);
  console.error(`[prune-rules] Detected languages: ${[...keepLangs].join(', ')}`);

  // Step 3: Prune unused rules
  const pruned = pruneUnusedRules(keepLangs);
  if (pruned.length > 0) {
    console.error(`[prune-rules] Removed ${pruned.length} unused rule dirs: ${pruned.join(', ')}`);
  }

  // Step 3.5: Restore kept language rules from store (gap: prune only removes, never restores)
  const restored = restoreKeptRules(keepLangs);
  if (restored.length > 0) {
    console.error(`[prune-rules] Restored ${restored.length} rule dirs from store: ${restored.join(', ')}`);
  }

  // Step 4: Deploy DW plugin rules + ensure lazy-rules.md exists
  deployDwRules();
  ensureLazyRulesMd(keepLangs);

  // Step 5: Save state
  saveState(keepLangs, pruned, restored);

  const elapsed = Date.now() - startTime;
  // NOTE: do NOT write to stdout — it breaks the hook output JSON parser
  // for subsequent SessionStart hooks (session-start.js, tool-inventory.js).
  // All diagnostic info already goes to stderr via console.error above.
  if (pruned.length > 0) {
    console.error(`[prune-rules] elapsed=${elapsed}ms, kept=[${[...keepLangs].join(',')}], removed=[${pruned.join(',')}]`);
  }
}

main();
