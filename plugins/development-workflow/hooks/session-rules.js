#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_RULE_BUDGET = 90 * 1024;
const MAX_SCAN_DEPTH = 3;
const MAX_SCAN_ENTRIES = 4000;
const MAX_RULE_DEPTH = 2;

const MANAGED_LANGUAGES = Object.freeze([
  'python', 'typescript', 'react', 'web', 'rust', 'cpp', 'golang', 'java',
  'swift', 'kotlin', 'dart', 'csharp', 'perl', 'php', 'fsharp', 'ruby',
  'angular', 'arkts', 'zh',
]);

const EXTENSION_LANGUAGES = new Map([
  ['.py', 'python'], ['.pyi', 'python'],
  ['.ts', 'typescript'], ['.tsx', 'typescript'], ['.mts', 'typescript'],
  ['.js', 'typescript'], ['.jsx', 'typescript'], ['.mjs', 'typescript'],
  ['.rs', 'rust'],
  ['.c', 'cpp'], ['.cc', 'cpp'], ['.cpp', 'cpp'], ['.cxx', 'cpp'],
  ['.h', 'cpp'], ['.hpp', 'cpp'], ['.hxx', 'cpp'],
  ['.go', 'golang'],
  ['.java', 'java'],
  ['.kt', 'kotlin'], ['.kts', 'kotlin'],
  ['.swift', 'swift'],
  ['.dart', 'dart'],
  ['.cs', 'csharp'],
  ['.pl', 'perl'], ['.pm', 'perl'],
  ['.php', 'php'],
  ['.fs', 'fsharp'], ['.fsx', 'fsharp'],
  ['.rb', 'ruby'],
  ['.ets', 'arkts'],
]);

const IGNORED_DIRECTORIES = new Set([
  '.git', '.hg', '.svn', '.idea', '.vscode',
  'node_modules', '__pycache__', '.pytest_cache', '.mypy_cache',
  'target', 'build', 'dist', 'out', 'coverage',
  'venv', '.venv', 'site-packages', '.tox',
]);

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// Check the supplied home and every existing component below it. This rejects
// junctions as well as symbolic links; it is a preflight/recheck, not an atomic
// defense against another process replacing a directory between filesystem calls.
function assertNoLinkedAncestors(root, candidate) {
  const boundary = path.resolve(root);
  const target = path.resolve(candidate);
  if (!isWithin(boundary, target)) throw new Error(`path escaped boundary: ${target}`);
  const relative = path.relative(boundary, target);
  let current = boundary;
  for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
    if (stat.isSymbolicLink()) throw new Error(`symbolic link or junction is not allowed: ${current}`);
  }
}

function readPackageLanguages(projectDir, detected) {
  const packagePath = path.join(projectDir, 'package.json');
  let packageJson;
  try {
    packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  } catch {
    return;
  }

  const dependencies = new Set([
    ...Object.keys(packageJson.dependencies || {}),
    ...Object.keys(packageJson.devDependencies || {}),
    ...Object.keys(packageJson.peerDependencies || {}),
  ]);

  if (dependencies.has('typescript') || dependencies.has('tsx')) detected.add('typescript');
  if (dependencies.has('react') || dependencies.has('react-dom')) {
    detected.add('react');
    detected.add('web');
  }
  if (dependencies.has('next') || dependencies.has('gatsby') || dependencies.has('react-scripts')) {
    detected.add('react');
    detected.add('web');
  }
  if (dependencies.has('vue') || dependencies.has('@angular/core') || dependencies.has('svelte')) {
    detected.add('web');
  }
  if ([...dependencies].some(name => name.startsWith('@angular/'))) detected.add('angular');
  if (dependencies.has('vite') || dependencies.has('webpack') || dependencies.has('astro')) detected.add('web');
}

function detectProjectLanguages(projectDir) {
  const detected = new Set(['common']);
  const root = path.resolve(projectDir);
  let visited = 0;

  function scan(directory, depth) {
    if (depth > MAX_SCAN_DEPTH || visited >= MAX_SCAN_ENTRIES) return;
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (visited >= MAX_SCAN_ENTRIES) break;
      visited += 1;
      if (entry.isSymbolicLink() || IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.')) scan(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;

      const language = EXTENSION_LANGUAGES.get(path.extname(entry.name).toLowerCase());
      if (language) detected.add(language);
      if (/\.(?:tsx|jsx)$/i.test(entry.name)) { detected.add('react'); detected.add('web'); }
      if (/\.html?$/i.test(entry.name)) detected.add('web');
      if (/^(index\.html|vite\.config\.|next\.config\.|nuxt\.config\.|astro\.config\.|svelte\.config\.)/i.test(entry.name)) {
        detected.add('web');
      }
    }
  }

  scan(root, 0);
  readPackageLanguages(root, detected);
  return { languages: [...detected], visitedEntries: visited };
}

function collectMarkdownFiles(directory, baseDirectory, depth = 0, output = []) {
  if (depth > MAX_RULE_DEPTH) return output;
  let entries;
  try {
    if (fs.lstatSync(directory).isSymbolicLink()) return output;
    entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return output;
  }

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const absolute = path.join(directory, entry.name);
    if (!isWithin(baseDirectory, absolute)) continue;
    if (entry.isDirectory()) {
      collectMarkdownFiles(absolute, baseDirectory, depth + 1, output);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      output.push(absolute);
    }
  }
  return output;
}

function selectRuleFiles(home, languages) {
  const claudeRoot = path.join(home, '.claude');
  const activeRoot = path.join(claudeRoot, 'rules');
  const storeRoot = path.join(claudeRoot, 'rules-store');
  assertNoLinkedAncestors(home, activeRoot);
  assertNoLinkedAncestors(home, storeRoot);
  const selected = [];

  for (const language of languages) {
    for (const [source, sourceRoot] of [['rules', activeRoot], ['rules-store', storeRoot]]) {
      const languageRoot = path.join(sourceRoot, language);
      if (!isWithin(sourceRoot, languageRoot) || !fs.existsSync(languageRoot)) continue;
      const files = collectMarkdownFiles(languageRoot, languageRoot);
      for (const file of files) {
        selected.push({
          language,
          source,
          autoLoaded: source === 'rules',
          file,
          relative: path.relative(languageRoot, file).replace(/\\/g, '/'),
        });
      }
      break;
    }
  }
  return selected;
}

function takeUtf8(value, maxBytes) {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}

function buildRulesContext(options) {
  const projectDir = path.resolve(options.projectDir);
  const home = path.resolve(options.home);
  const maxBytes = Math.max(4096, Number(options.maxBytes) || DEFAULT_RULE_BUDGET);
  const detection = detectProjectLanguages(projectDir);
  const candidates = selectRuleFiles(home, detection.languages);
  const loaded = [];
  const autoLoaded = [];
  const deferred = [];
  const chunks = [];

  const header = [
    '<dw-selected-rules>',
    `Languages: ${detection.languages.join(', ')}`,
    `Detection scan: ${detection.visitedEntries}/${MAX_SCAN_ENTRIES} entries`,
    'Source policy: read-only; active rules are indexed but not duplicated; rules-store content is injected; symbolic links are ignored.',
    '',
  ].join('\n');
  chunks.push(header);
  const pending = [];
  for (const candidate of candidates) {
    const label = `${candidate.language}/${candidate.relative}`;
    if (candidate.autoLoaded) {
      autoLoaded.push(label);
      continue;
    }
    let content;
    try {
      content = fs.readFileSync(candidate.file, 'utf8');
    } catch {
      deferred.push(`${candidate.language}/${candidate.relative} (unreadable)`);
      continue;
    }
    const text = `--- rule: ${label} [${candidate.source}] ---\n${content}\n\n`;
    if (Buffer.byteLength(text, 'utf8') > maxBytes) { deferred.push(`${label} (budget)`); continue; }
    pending.push({ label, text });
  }

  function footer(selected, omitted) {
    const summary = [
      `Loaded rules: ${selected.length}`,
      `Active rules already auto-loaded: ${autoLoaded.length}`,
      `Deferred rules: ${omitted.length}`,
    ];
    const details = [
      ...autoLoaded.slice(0, 20).map(item => `- active: ${item}`),
      ...(omitted.length ? ['Deferred due to budget or read safety:', ...omitted.slice(0, 20).map(item => `- ${item}`)] : []),
    ];
    const cap = Math.min(8192, Math.floor(maxBytes / 3));
    const render = () => `${[...summary, ...details, '</dw-selected-rules>'].join('\n')}\n`;
    while (details.length && Buffer.byteLength(render(), 'utf8') > cap) details.pop();
    return render();
  }

  // Plan complete files with the actual footer cost. A loaded rule is never
  // shortened merely to make room for status metadata.
  const omitted = pending.map(item => `${item.label} (budget)`);
  for (let index = 0; index < pending.length; index += 1) {
    const item = pending[index];
    const nextOmitted = [...deferred, ...omitted.filter((value, position) => value && position !== index)];
    const proposed = chunks.join('') + item.text + footer([...loaded, item.label], nextOmitted);
    if (Buffer.byteLength(proposed, 'utf8') <= maxBytes) {
      chunks.push(item.text);
      loaded.push(item.label);
      omitted[index] = null;
    }
  }
  deferred.push(...omitted.filter(Boolean));
  const context = chunks.join('') + footer(loaded, deferred);

  return {
    context,
    languages: detection.languages,
    loaded,
    autoLoaded,
    deferred,
    visitedEntries: detection.visitedEntries,
    bytes: Buffer.byteLength(context, 'utf8'),
  };
}

module.exports = {
  DEFAULT_RULE_BUDGET,
  assertNoLinkedAncestors,
  MANAGED_LANGUAGES,
  buildRulesContext,
  collectMarkdownFiles,
  detectProjectLanguages,
  isWithin,
  selectRuleFiles,
  takeUtf8,
};

if (require.main === module) {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const result = buildRulesContext({ home, projectDir });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
