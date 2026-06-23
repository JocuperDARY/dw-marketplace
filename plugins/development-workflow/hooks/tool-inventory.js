#!/usr/bin/env node
// Tool-Proact Tool Inventory Scanner — SessionStart
// Scans installed plugins/skills/MCPs and generates a categorized inventory.
// Output: JSON on stdout (additionalContext for SessionStart hook)
// Cache: ~/.claude/.cache/tool-inventory.json (TTL: 60 minutes)
//
// Self-updating: no hardcoded skill names or keywords.
// All routing data is derived from actual installed artifacts.

'use strict';

const fs = require('fs');
const path = require('path');
const { outputHook, verifyHookScripts } = require('./task-utils.js');

const HOME = process.env.HOME || process.env.USERPROFILE || '';
const CACHE_DIR = path.join(HOME, '.claude', '.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'tool-inventory.json');
const TTL_MS = 60 * 60 * 1000; // 1 hour

// ── Categorization heuristics ──
// These are the ONLY hardcoded logic — generic rules that classify
// any skill by its name + description, independent of origin.
const CATEGORIES = [
  {
    id: 'design',
    label: '🎨 Design & Planning',
    rule: '在开始写代码之前，先调用 brainstorming/planning 做设计',
    priority: 100,
    patterns: [
      /brainstorm/i, /design/i, /plan/i, /architect/i, /prototype/i,
      /spec/i, /prd/i, /blueprint/i, /scaffold/i, /idea/i,
      /shape/i, /sketch/i, /concept/i, /workflow/i, /methodology/i
    ],
    specifics: []
  },
  {
    id: 'testing',
    label: '🧪 Testing',
    rule: '写代码前先写测试（TDD），确保 80%+ 覆盖率',
    priority: 95,
    patterns: [
      /test/i, /tdd/i, /coverage/i, /e2e/i, /browser-qa/i,
      /regression/i, /benchmark/i, /eval/i
    ],
    specifics: []
  },
  {
    id: 'review',
    label: '🛡️ Review & Quality',
    rule: '写完代码立即调用 code-review / review 进行审查',
    priority: 90,
    patterns: [
      /review/i, /audit/i, /quality/i, /check/i, /inspect/i,
      /lint/i, /critique/i, /simplify/i, /clean/i, /prune/i
    ],
    specifics: []
  },
  {
    id: 'security',
    label: '🔒 Security',
    rule: '涉及认证/授权/输入验证/加密时必须调用 security 相关 skill',
    priority: 85,
    patterns: [
      /secur/i, /vuln/i, /pentest/i, /exploit/i, /harden/i,
      /comply/i, /hipaa/i, /guard/i, /protect/i, /safe/i,
      /semgrep/i
    ],
    specifics: []
  },
  {
    id: 'debug',
    label: '🐛 Debugging & Diagnostics',
    rule: '遇到问题先调用 systematic-debugging / diagnose 系统排查',
    priority: 80,
    patterns: [
      /debug/i, /diagnos/i, /troubleshoot/i, /fix/i, /resolve/i,
      /triage/i, /error/i, /bug/i
    ],
    specifics: []
  },
  {
    id: 'refactor',
    label: '🧹 Refactoring',
    rule: '重构前调用 refactor-clean / simplify 确保方向正确',
    priority: 75,
    patterns: [
      /refactor/i, /clean/i, /simplify/i, /migrate/i, /extract/i,
      /normalize/i, /optimize/i, /evolve/i
    ],
    specifics: []
  },
  {
    id: 'docs',
    label: '📝 Documentation',
    rule: '模块变更后调用 gen-docs / update-docs 保持文档同步',
    priority: 70,
    patterns: [
      /doc/i, /readme/i, /codemap/i, /onboard/i, /teach/i,
      /article/i, /write/i
    ],
    specifics: []
  },
  {
    id: 'git',
    label: '📦 Git & Workflow',
    rule: 'Git 操作前调用 git-workflow / commit / pr 等 skill',
    priority: 65,
    patterns: [
      /git/i, /commit/i, /branch/i, /pr/i, /pull/i, /push/i,
      /merge/i, /rebase/i, /worktree/i, /hook/i
    ],
    specifics: []
  },
  {
    id: 'frontend',
    label: '🖼️ Frontend & UI',
    rule: '前端开发先调用 frontend-design / ui-ux-designer 确认方向',
    priority: 60,
    patterns: [
      /frontend/i, /react/i, /vue/i, /angular/i, /svelte/i,
      /ui/i, /ux/i, /css/i, /style/i, /animat/i, /motion/i,
      /color/i, /theme/i, /typography/i, /layout/i, /component/i,
      /nextjs/i, /nuxt/i, /vite/i, /flutter/i, /swift/i
    ],
    specifics: []
  },
  {
    id: 'language',
    label: '🔤 Language-Specific',
    rule: '使用语言特定的 reviewer 确保代码符合最佳实践',
    priority: 55,
    patterns: [
      /python/i, /rust/i, /golang/i, /typescript/i, /javascript/i,
      /java/i, /kotlin/i, /csharp/i, /fsharp/i, /swift/i,
      /dart/i, /cpp/i, /perl/i, /laravel/i, /django/i,
      /spring/i, /quarkus/i, /fastapi/i, /nestjs/i, /ktor/i
    ],
    specifics: []
  },
  {
    id: 'performance',
    label: '⚡ Performance',
    rule: '性能优化前调用 performance-optimizer 进行 profiling',
    priority: 50,
    patterns: [
      /perform/i, /optimiz/i, /speed/i, /fast/i, /latency/i,
      /throughput/i, /profiling/i, /memory/i, /bundle/i, /load/i
    ],
    specifics: []
  },
  {
    id: 'mcp_docs',
    label: '📚 Real-time Documentation (MCP)',
    rule: '使用任何库/框架/API前，先用 Context7 查最新文档，不要凭记忆写代码',
    priority: 200,
    patterns: [],
    specifics: ['context7', 'tavily']
  },
  {
    id: 'mcp_search',
    label: '🔍 Web Search (MCP)',
    rule: '需要最新信息、实时数据、或不确定的内容时，使用 tavily_search/web_search 搜索',
    priority: 195,
    patterns: [],
    specifics: ['tavily', 'brightdata', 'exa']
  },
  {
    id: 'mcp_browser',
    label: '🌐 Browser Automation (MCP)',
    rule: '需要验证 UI 行为、截图、E2E 测试时使用 Playwright',
    priority: 190,
    patterns: [],
    specifics: ['playwright', 'browser']
  },
  {
    id: 'mcp_memory',
    label: '🧠 Knowledge Graph (MCP)',
    rule: '需要记录项目知识、实体关系时使用 memory MCP',
    priority: 185,
    patterns: [],
    specifics: ['memory']
  },
  {
    id: 'mcp_reasoning',
    label: '💭 Deep Reasoning (MCP)',
    rule: '面对复杂多步骤问题时使用 sequential-thinking 进行深度推理',
    priority: 180,
    patterns: [],
    specifics: ['sequential-thinking']
  },
  {
    id: 'mcp_codegraph',
    label: '📊 Code Intelligence (MCP)',
    rule: '理解代码结构、查调用关系、分析变更影响时先用 CodeGraph 知识图谱，不要用 grep/read 反复扫描',
    priority: 175,
    patterns: [],
    specifics: ['codegraph']
  }
];

// ── Skill Scanning ──

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fm = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)/);
    if (kv) fm[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return fm;
}

// Extract CJK bigrams from text for Unicode-aware matching.
// JS \w = [a-zA-Z0-9_], so split(/\W+/) destroys all CJK characters.
// Bigrams bridge the gap: "理解代码结构" → ["理解","解代","代码","码结","结构"]
function extractCJKBigrams(text) {
  const cjk = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    // CJK Unified Ideographs (U+4E00–U+9FFF) + Extension A (U+3400–U+4DBF)
    if ((cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0x3400 && cp <= 0x4DBF)) {
      cjk.push(ch);
    }
  }
  const bigrams = new Set();
  for (let i = 0; i < cjk.length - 1; i++) {
    bigrams.add(cjk[i] + cjk[i + 1]);
  }
  return bigrams;
}

function extractKeywords(name, description) {
  const words = new Set();
  // English words from name hyphen/underscore parts
  for (const part of name.split(/[-_]/)) {
    if (part.length > 2) words.add(part.toLowerCase());
  }
  if (description) {
    // English stop-words to filter out noise
    const stopWords = new Set([
      'this', 'that', 'with', 'from', 'when', 'your', 'have', 'been',
      'will', 'they', 'them', 'then', 'also', 'into', 'just', 'over', 'than'
    ]);
    // Extract ASCII words via match (NOT split — avoids destroying CJK)
    const asciiWords = description.match(/[a-zA-Z0-9_]+/g) || [];
    for (const word of asciiWords) {
      const w = word.toLowerCase();
      if (w.length > 3 && !stopWords.has(w)) words.add(w);
    }
    // Extract CJK bigrams from description
    const cjkBigrams = extractCJKBigrams(description);
    for (const bg of cjkBigrams) words.add(bg);
  }
  return [...words].slice(0, 30);
}

function compareVersionsDesc(a, b) {
  const pa = String(a).split(/[.-]/).map(part => /^\d+$/.test(part) ? Number(part) : part);
  const pb = String(b).split(/[.-]/).map(part => /^\d+$/.test(part) ? Number(part) : part);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const av = pa[i] ?? 0, bv = pb[i] ?? 0;
    if (av === bv) continue;
    if (typeof av === 'number' && typeof bv === 'number') return bv - av;
    return String(bv).localeCompare(String(av), undefined, { numeric: true });
  }
  return 0;
}

function getActivePluginVersion(pluginDir) {
  const versions = safeReaddir(pluginDir)
    .filter(v => v !== 'unknown' && fs.statSync(path.join(pluginDir, v)).isDirectory());
  const marked = versions.find(v => fs.existsSync(path.join(pluginDir, v, '.in_use')));
  if (marked) return marked;
  if (!versions.length) return null;
  return versions.sort(compareVersionsDesc)[0];
}

function scanSkillsUnder(rootDir, source) {
  const skills = [];
  const seen = new Set();
  const SKIP_DIRS = new Set(['.cursor', '.kiro', 'docs', '.git', 'node_modules']);

  function walkSkills(dir) {
    for (const entry of safeReaddir(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = path.join(dir, entry);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (!stat.isDirectory()) continue;

      const skillFile = ['SKILL.md', 'skill.md', 'SKILL.MD']
        .map(f => path.join(full, f))
        .find(f => fs.existsSync(f));
      if (skillFile) {
        const skillName = entry;
        if (seen.has(skillName)) continue;
        seen.add(skillName);

        const content = fs.readFileSync(skillFile, 'utf-8');
        const fm = parseFrontmatter(content) || {};
        const displayName = fm.name || skillName;
        const description = fm.description || '';

        skills.push({
          type: 'skill',
          name: displayName,
          dirName: skillName,
          source,
          description: description.substring(0, 200),
          keywords: extractKeywords(displayName, description)
        });
      } else {
        walkSkills(full);
      }
    }
  }

  if (fs.existsSync(rootDir)) walkSkills(rootDir);
  return skills;
}

function scanCurrentPluginSkills() {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..');
  return scanSkillsUnder(path.join(pluginRoot, 'skills'), 'current-plugin');
}

function scanPluginSkills() {
  const skills = [];
  const pluginsDir = path.join(HOME, '.claude', 'plugins', 'cache');
  if (!fs.existsSync(pluginsDir)) return skills;

  // Directories to skip when walking (other platforms, translations, git)
  const SKIP_DIRS = new Set(['.cursor', '.kiro', 'docs', '.git', 'node_modules', 'temp_subdir_1779990287317_w0ytw7.clone', 'temp_subdir_1780168320212_zsj041.clone', 'temp_subdir_1780169684273_uyfj80.clone']);

  for (const marketplace of safeReaddir(pluginsDir)) {
    const mpDir = path.join(pluginsDir, marketplace);
    if (!fs.statSync(mpDir).isDirectory()) continue;

    for (const plugin of safeReaddir(mpDir)) {
      const pluginDir = path.join(mpDir, plugin);
      if (!fs.statSync(pluginDir).isDirectory()) continue;

      let activeVersion = getActivePluginVersion(pluginDir);
      if (!activeVersion) continue;

      const versionDir = path.join(pluginDir, activeVersion);
      const source = `${plugin}@${marketplace}`;
      skills.push(...scanSkillsUnder(versionDir, source));
    }
  }
  return skills;
}

function scanLocalSkills() {
  const skills = [];
  const skillsDir = path.join(HOME, '.claude', 'skills');
  if (!fs.existsSync(skillsDir)) return skills;

  function walk(dir, prefix) {
    for (const entry of safeReaddir(dir)) {
      const full = path.join(dir, entry);
      if (!fs.statSync(full).isDirectory()) continue;
      const skillFile = ['SKILL.md', 'skill.md']
        .map(f => path.join(full, f))
        .find(f => fs.existsSync(f));
      if (skillFile) {
        const content = fs.readFileSync(skillFile, 'utf-8');
        const fm = parseFrontmatter(content) || {};
        const displayName = prefix ? `${prefix}:${entry}` : entry;
        skills.push({
          type: 'skill',
          name: fm.name || displayName,
          dirName: entry,
          source: 'local',
          description: (fm.description || '').substring(0, 200),
          keywords: extractKeywords(fm.name || entry, fm.description || '')
        });
      } else {
        walk(full, prefix ? `${prefix}:${entry}` : entry);
      }
    }
  }
  walk(skillsDir, '');
  return skills;
}

function scanSlashCommands() {
  const commands = [];
  const pluginsDir = path.join(HOME, '.claude', 'plugins', 'cache');
  if (!fs.existsSync(pluginsDir)) return commands;

  for (const marketplace of safeReaddir(pluginsDir)) {
    const mpDir = path.join(pluginsDir, marketplace);
    if (!fs.statSync(mpDir).isDirectory()) continue;

    for (const plugin of safeReaddir(mpDir)) {
      const pluginDir = path.join(mpDir, plugin);
      if (!fs.statSync(pluginDir).isDirectory()) continue;

      let activeVersion = getActivePluginVersion(pluginDir);
      if (!activeVersion) continue;

      const versionDir = path.join(pluginDir, activeVersion);
      const source = `${plugin}@${marketplace}`;

      // Self-updating: check standard commands/ AND .claude/commands/
      const cmdDirs = [
        path.join(versionDir, 'commands'),
        path.join(versionDir, '.claude', 'commands')
      ];

      for (const commandsDir of cmdDirs) {
        if (!fs.existsSync(commandsDir)) continue;

        for (const cmdFile of safeReaddir(commandsDir)) {
          if (!cmdFile.endsWith('.md')) continue;
          const cmdName = cmdFile.replace(/\.md$/, '');
          const content = fs.readFileSync(path.join(commandsDir, cmdFile), 'utf-8');
          const fm = parseFrontmatter(content) || {};
          const firstLine = content.split('\n').find(l => l.startsWith('#') && l.length > 2);
          const description = fm.description || (firstLine ? firstLine.replace(/^#+\s*/, '') : '');

          commands.push({
            type: 'command',
            name: cmdName.startsWith('/') ? cmdName : `/${cmdName}`,
            source,
            description: description.substring(0, 200),
            keywords: extractKeywords(cmdName, description)
          });
        }
      }
    }
  }
  return commands;
}

function scanMcpTools() {
  const mcps = [];
  const settingsPath = path.join(HOME, '.claude', 'settings.json');

  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      const enabledPlugins = settings.enabledPlugins || {};

      // ── Self-updating: read mcpServers from each plugin's plugin.json ──
      const pluginsDir = path.join(HOME, '.claude', 'plugins', 'cache');
      const pluginMcpServers = {};
      if (fs.existsSync(pluginsDir)) {
        for (const marketplace of safeReaddir(pluginsDir)) {
          const mpDir = path.join(pluginsDir, marketplace);
          if (!fs.statSync(mpDir).isDirectory()) continue;
          for (const plugin of safeReaddir(mpDir)) {
            const pluginDir = path.join(mpDir, plugin);
            if (!fs.statSync(pluginDir).isDirectory()) continue;
            const pluginJsonPath = path.join(pluginDir, getActivePluginVersion(pluginDir) || '', '.claude-plugin', 'plugin.json');
            if (fs.existsSync(pluginJsonPath)) {
              try {
                const pj = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf-8'));
                if (pj.mcpServers && Object.keys(pj.mcpServers).length > 0) {
                  pluginMcpServers[`${plugin}@${marketplace}`] = pj.mcpServers;
                }
              } catch { /* skip */ }
            }
          }
        }
      }

      // Seed MCP map: plugin ID → tool list (can be overridden by plugin.json mcpServers)
      const PLUGIN_MCP_MAP = {
        'context7@claude-plugins-official': [
          { name: 'mcp__context7__query-docs', description: 'Query up-to-date library/framework documentation', keywords: ['docs', 'documentation', 'library', 'framework', 'api', 'sdk', 'reference'] },
          { name: 'mcp__context7__resolve-library-id', description: 'Resolve library name to Context7 ID', keywords: ['docs', 'library', 'resolve'] }
        ],
        'superpowers@claude-plugins-official': [
          { name: 'mcp__tavily__tavily_search', description: 'Web search', keywords: ['search', 'web', 'current', 'news', 'information'] },
          { name: 'mcp__tavily__tavily_research', description: 'Deep multi-source research', keywords: ['research', 'deep', 'comprehensive', 'study'] },
          { name: 'mcp__tavily__tavily_extract', description: 'Extract content from URLs', keywords: ['extract', 'content', 'url', 'webpage'] },
          { name: 'mcp__tavily__tavily_crawl', description: 'Crawl websites', keywords: ['crawl', 'website', 'site'] },
          { name: 'mcp__tavily__tavily_map', description: 'Map website structure', keywords: ['map', 'structure', 'sitemap'] }
        ]
      };

      // Check if plugin.json declared mcpServers — if so, merge them in
      // with smart keyword extraction from the server name for better categorization
      for (const [pluginId, mcpSvrs] of Object.entries(pluginMcpServers)) {
        if (!PLUGIN_MCP_MAP[pluginId]) PLUGIN_MCP_MAP[pluginId] = [];
        for (const [serverName, serverConfig] of Object.entries(mcpSvrs)) {
          // Split server name into component words for better category matching
          const parts = serverName.toLowerCase()
            .split(/[-_]/)
            .flatMap(p => p.split(/(?=[A-Z])/))
            .map(p => p.toLowerCase())
            .filter(p => p.length > 1);
          const uniqueParts = [...new Set(parts)];
          PLUGIN_MCP_MAP[pluginId].push({
            name: `mcp__${serverName}`,
            description: `MCP server: ${serverName}`,
            keywords: [serverName.toLowerCase(), ...uniqueParts, 'mcp', 'server']
          });
        }
      }

      for (const [pluginId, tools] of Object.entries(PLUGIN_MCP_MAP)) {
        if (enabledPlugins[pluginId]) {
          for (const tool of tools) {
            mcps.push({ type: 'mcp', ...tool });
          }
        }
      }

      // Comprehensive MCP tool list — covers all known connected MCP servers
      const ADDITIONAL_MCPS = [
        // BrightData
        { name: 'mcp__brightdata-mcp__discover', description: 'AI-driven web search with intent ranking', keywords: ['search', 'discover', 'web', 'ai', 'brightdata'] },
        { name: 'mcp__brightdata-mcp__scrape_as_markdown', description: 'Scrape webpage as markdown', keywords: ['scrape', 'webpage', 'markdown', 'extract', 'brightdata'] },
        { name: 'mcp__brightdata-mcp__search_engine', description: 'Search Google/Bing/Yandex SERP', keywords: ['google', 'bing', 'yandex', 'search', 'serp', 'brightdata'] },
        { name: 'mcp__brightdata-mcp__scrape_batch', description: 'Batch scrape multiple URLs', keywords: ['scrape', 'batch', 'url', 'brightdata'] },
        // Memory (local + ECC)
        { name: 'mcp__memory__search_nodes', description: 'Search knowledge graph nodes', keywords: ['memory', 'knowledge', 'graph', 'search', 'entity'] },
        { name: 'mcp__memory__create_entities', description: 'Create knowledge graph entities', keywords: ['memory', 'knowledge', 'create', 'entity'] },
        { name: 'mcp__memory__open_nodes', description: 'Open knowledge graph nodes by name', keywords: ['memory', 'knowledge', 'open', 'node'] },
        { name: 'mcp__memory__read_graph', description: 'Read entire knowledge graph', keywords: ['memory', 'knowledge', 'graph', 'read'] },
        { name: 'mcp__memory__add_observations', description: 'Add observations to entities', keywords: ['memory', 'observation', 'entity'] },
        { name: 'mcp__memory__delete_entities', description: 'Delete entities from knowledge graph', keywords: ['memory', 'delete', 'entity'] },
        { name: 'mcp__memory__delete_observations', description: 'Delete observations from entities', keywords: ['memory', 'delete', 'observation'] },
        { name: 'mcp__memory__create_relations', description: 'Create relations between entities', keywords: ['memory', 'relation', 'entity', 'link'] },
        { name: 'mcp__memory__delete_relations', description: 'Delete relations between entities', keywords: ['memory', 'delete', 'relation'] },
        // Sequential Thinking
        { name: 'mcp__sequential-thinking__sequentialthinking', description: 'Deep structured multi-step reasoning', keywords: ['think', 'reason', 'analyze', 'complex', 'step', 'logic'] },
        // ACE Tool (Augment)
        { name: 'mcp__ace-tool__search_context', description: 'Semantic codebase search (Augment)', keywords: ['codebase', 'search', 'semantic', 'context', 'augment'] },
        { name: 'mcp__ace-tool__enhance_prompt', description: 'Enhance prompts with codebase context', keywords: ['enhance', 'prompt', 'context', 'augment'] },
        // ECC-namespaced equivalents
        { name: 'mcp__plugin_ecc_exa__web_search_exa', description: 'Exa semantic web search', keywords: ['search', 'semantic', 'web', 'exa'] },
        { name: 'mcp__plugin_ecc_memory__search_nodes', description: 'ECC knowledge graph search', keywords: ['memory', 'knowledge', 'graph'] },
        { name: 'mcp__plugin_ecc_memory__create_entities', description: 'ECC knowledge graph create', keywords: ['memory', 'create', 'entity'] },
        { name: 'mcp__plugin_ecc_sequential-thinking__sequentialthinking', description: 'ECC deep reasoning', keywords: ['think', 'reason', 'complex'] },
        { name: 'mcp__plugin_ecc_playwright__browser_navigate', description: 'Browser automation — navigate', keywords: ['browser', 'playwright', 'navigate', 'e2e'] },
        { name: 'mcp__plugin_ecc_playwright__browser_snapshot', description: 'Browser automation — accessibility snapshot', keywords: ['browser', 'playwright', 'snapshot', 'accessibility'] },
        { name: 'mcp__plugin_ecc_playwright__browser_click', description: 'Browser automation — click element', keywords: ['browser', 'playwright', 'click', 'e2e'] },
        { name: 'mcp__plugin_ecc_playwright__browser_type', description: 'Browser automation — type text', keywords: ['browser', 'playwright', 'type', 'input'] },
        { name: 'mcp__plugin_ecc_playwright__browser_take_screenshot', description: 'Browser automation — screenshot', keywords: ['browser', 'playwright', 'screenshot'] },
        { name: 'mcp__plugin_ecc_github__search_code', description: 'Search GitHub code', keywords: ['github', 'code', 'search', 'repository'] },
        { name: 'mcp__plugin_ecc_github__create_pull_request', description: 'Create GitHub PR', keywords: ['github', 'pr', 'pull', 'request'] },
        { name: 'mcp__plugin_ecc_github__get_pull_request', description: 'Get PR details', keywords: ['github', 'pr', 'pull', 'request'] },
        { name: 'mcp__plugin_ecc_github__list_issues', description: 'List GitHub issues', keywords: ['github', 'issue', 'list'] },
        { name: 'mcp__plugin_ecc_github__create_issue', description: 'Create GitHub issue', keywords: ['github', 'issue', 'create'] },
        // Plugin-namespace duplicates (Context7)
        { name: 'mcp__plugin_context7_context7__query-docs', description: 'Context7 docs (plugin namespace)', keywords: ['docs', 'library', 'framework', 'context7'] },
        { name: 'mcp__plugin_ecc_context7__query-docs', description: 'ECC Context7 docs', keywords: ['docs', 'library', 'framework', 'context7'] },
        // CodeGraph — English + Chinese keywords for natural language matching
        { name: 'mcp__codegraph__codegraph_explore', description: '一次性回答代码结构/流程/架构问题，替代 grep/read 反复扫描', keywords: ['codegraph', 'explore', 'code', 'structure', 'symbol', 'call-graph', '代码', '流程', '架构', '结构', '工作', '调用', 'trace', 'where', 'how', 'flow', 'architecture'] },
        { name: 'mcp__codegraph__codegraph_search', description: '在整个代码库中按名称查找符号', keywords: ['codegraph', 'search', 'symbol', 'code', '搜索', '查找', '符号', '定位', '函数'] },
        { name: 'mcp__codegraph__codegraph_callers', description: '查找哪些地方调用了某个函数/方法', keywords: ['codegraph', 'callers', 'call-graph', 'trace', '调用者', '谁调了', '引用', '何处', '依赖'] },
        { name: 'mcp__codegraph__codegraph_callees', description: '查找某个函数/方法调用了哪些东西', keywords: ['codegraph', 'callees', 'call-graph', 'trace', '调用了', '子调用', '下游'] },
        { name: 'mcp__codegraph__codegraph_impact', description: '分析修改某个符号会破坏哪些代码', keywords: ['codegraph', 'impact', 'change', 'refactor', 'breakage', '影响', '修改', '改动', '重构', '破坏', '波及'] },
        { name: 'mcp__codegraph__codegraph_node', description: '获取单个符号的完整源码和元数据', keywords: ['codegraph', 'node', 'symbol', 'source', '源码', '符号', '定义', '声明'] },
        { name: 'mcp__codegraph__codegraph_files', description: '查看代码库文件结构，比直接扫文件系统更快', keywords: ['codegraph', 'files', 'structure', 'tree', '文件', '目录', '结构'] },
        { name: 'mcp__codegraph__codegraph_status', description: '检查 CodeGraph 索引健康状况和统计信息', keywords: ['codegraph', 'status', 'health', 'index', '状态', '健康', '索引'] },
      ];
      mcps.push(...ADDITIONAL_MCPS.map(t => ({ type: 'mcp', ...t })));

    } catch { /* silent */ }
  }
  return mcps;
}

// ── Categorization ──

function categorize(items) {
  const result = {};
  for (const cat of CATEGORIES) {
    result[cat.id] = {
      label: cat.label,
      rule: cat.rule,
      priority: cat.priority,
      items: []
    };
  }

  for (const item of items) {
    const searchText = `${item.name} ${item.description} ${(item.keywords || []).join(' ')}`.toLowerCase();

    let bestCat = null;
    let bestScore = 0;

    for (const cat of CATEGORIES) {
      if (cat.specifics && cat.specifics.length > 0) {
        for (const spec of cat.specifics) {
          // Name-boundary match: treats _, -, and word boundaries as boundaries.
          // Prevents "exa" matching inside "hexagonal", but allows "sequential-thinking"
          // to match inside "plugin_ecc_sequential-thinking".
          const escaped = spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          if (new RegExp('(?:^|[\\s_\\-])' + escaped + '(?:$|[\\s_\\-])', 'i').test(searchText)) {
            const score = cat.priority + 10;
            if (score > bestScore) { bestScore = score; bestCat = cat.id; }
            break;
          }
        }
      }
      for (const pattern of cat.patterns) {
        if (pattern.test(searchText)) {
          const score = cat.priority;
          if (score > bestScore) { bestScore = score; bestCat = cat.id; }
          break;
        }
      }
    }

    if (bestCat) {
      result[bestCat].items.push({
        name: item.name,
        type: item.type,
        description: item.description || '',
        source: item.source || '',
        keywords: (item.keywords || []).slice(0, 10)
      });
    } else if (result.docs) {
      result.docs.items.push({
        name: item.name,
        type: item.type,
        description: item.description || '',
        source: item.source || '',
        keywords: (item.keywords || []).slice(0, 10)
      });
    }
  }

  for (const key of Object.keys(result)) {
    if (result[key].items.length === 0) delete result[key];
  }

  return result;
}

// ── Output Formatting ──

// Compact format (<2KB): injected into session context to avoid truncation.
// Shows category summaries + top items only. Full list saved to file.
function formatInventoryCompact(categories) {
  const lines = ['<tool-proact-tool-inventory>'];

  lines.push('## 🔧 可用工具地图 (精简版)');
  lines.push('');
  lines.push('**完整列表**: `Read ~/.claude/.cache/tool-inventory-formatted.md`');
  lines.push('');

  // ── Top Priority: cross-category, most frequently needed tools ──
  const sorted = Object.entries(categories)
    .sort((a, b) => b[1].priority - a[1].priority);

  const seenCat = new Set();
  const topTools = [];
  const MAX_PER_CAT = 2;

  // Pass 1: take up to MAX_PER_CAT from each category in priority order
  for (const [id, cat] of sorted) {
    let catCount = 0;
    for (const item of cat.items) {
      if (topTools.length >= 12) break;
      if (catCount >= MAX_PER_CAT) break;
      const prefix = item.type === 'skill' ? 'Skill:' : '';
      topTools.push({ name: `${prefix}${item.name}`, cat: cat.label, priority: cat.priority });
      seenCat.add(id);
      catCount++;
    }
    if (topTools.length >= 12) break;
  }

  // Pass 2: ensure key workflow categories get at least 1 slot
  const KEY_IDS = ['design', 'testing', 'review', 'security'];
  for (const [id, cat] of sorted) {
    if (topTools.length >= 15) break;
    if (!KEY_IDS.includes(id)) continue;
    if (cat.items.length === 0) continue;
    const item = cat.items[0];
    const prefix = item.type === 'skill' ? 'Skill:' : '';
    topTools.push({ name: `${prefix}${item.name}`, cat: cat.label, priority: cat.priority });
  }

  lines.push('### 🔥 最常用工具 (跨类别 Top 15)');
  lines.push('');
  for (const t of topTools) {
    lines.push(`- \`${t.name}\` — ${t.cat}`);
  }
  lines.push('');

  // ── Quick reference table ──
  lines.push('### ⚡ 场景速查');
  lines.push('');
  lines.push('| 场景 | 工具 |');
  lines.push('|------|------|');
  lines.push('| 理解代码 | `mcp__codegraph__codegraph_explore` |');
  lines.push('| 查库/框架文档 | `mcp__context7__query-docs` |');
  lines.push('| 复杂推理 | `mcp__sequential-thinking__sequentialthinking` |');
  lines.push('| 搜索最新信息 | `mcp__tavily__tavily_search` |');
  lines.push('| 浏览器/UI验证 | `mcp__plugin_ecc_playwright__browser_navigate` |');
  lines.push('| 知识持久化 | `mcp__memory__create_entities` |');
  lines.push('| 代码审查 | `Skill:requesting-code-review` |');
  lines.push('');

  // Summary
  let totalItems = 0;
  for (const [id, cat] of sorted) totalItems += cat.items.length;
  lines.push(`---`);
  lines.push(`**${totalItems} tools in ${sorted.length} categories.** Full list: \`Read ~/.claude/.cache/tool-inventory-formatted.md\``);
  lines.push('</tool-proact-tool-inventory>');
  return lines.join('\n');
}

// Full format: saved to file for on-demand reading (NOT injected into context).
function formatInventoryFull(categories) {
  const lines = ['# 🔧 可用工具地图 (完整版)', ''];
  lines.push('## ⚡ 快速触发规则');
  lines.push('');
  lines.push('| 场景 | 第一时间调用 |');
  lines.push('|------|-------------|');
  lines.push('| 理解代码结构/流程/调用关系 | `mcp__codegraph__codegraph_explore` |');
  lines.push('| 使用任何库/框架/API | `mcp__context7__query-docs` |');
  lines.push('| 复杂多步骤推理 | `mcp__sequential-thinking__sequentialthinking` |');
  lines.push('| 需要最新信息/实时数据 | `mcp__tavily__tavily_search` |');
  lines.push('| 浏览器自动化/UI验证 | `mcp__plugin_ecc_playwright__browser_navigate` |');
  lines.push('| 重要发现需持久化 | `mcp__memory__create_entities` |');
  lines.push('| 写完代码后审查 | `Skill:requesting-code-review` |');
  lines.push('');

  const sorted = Object.entries(categories)
    .sort((a, b) => b[1].priority - a[1].priority);

  for (const [id, cat] of sorted) {
    lines.push(`## ${cat.label}`);
    lines.push(`> ${cat.rule}`);
    lines.push('');

    const skills = cat.items.filter(i => i.type === 'skill');
    const commands = cat.items.filter(i => i.type === 'command');
    const mcps = cat.items.filter(i => i.type === 'mcp');

    for (const item of skills) {
      const desc = item.description ? ` — ${item.description.substring(0, 80)}` : '';
      lines.push(`- \`Skill:${item.name}\`${desc}`);
    }
    for (const item of commands) {
      const desc = item.description ? ` — ${item.description.substring(0, 80)}` : '';
      lines.push(`- \`${item.name}\` (slash command)${desc}`);
    }
    for (const item of mcps) {
      const desc = item.description ? ` — ${item.description.substring(0, 80)}` : '';
      lines.push(`- \`${item.name}\` (MCP)${desc}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ── Entry Point ──

function safeReaddir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

async function main() {
  // ── Change detection: check if plugins/skills changed since last scan ──
  function getLatestPluginMtime() {
    let latest = 0;
    const dirs = [
      path.join(HOME, '.claude', 'plugins', 'cache'),
      path.join(HOME, '.claude', 'skills'),
    ];
    for (const dir of dirs) {
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            const mtime = fs.statSync(path.join(dir, entry.name)).mtimeMs;
            if (mtime > latest) latest = mtime;
          }
        }
      } catch { /* dir may not exist */ }
    }
    return latest;
  }

  // Force-refresh signal: touch this file to trigger re-scan on next message
  const FORCE_REFRESH_FILE = path.join(CACHE_DIR, 'tool-proact-force-refresh');

  // Check cache
  let forceRefresh = false;
  if (fs.existsSync(FORCE_REFRESH_FILE)) {
    try { fs.unlinkSync(FORCE_REFRESH_FILE); } catch { /* ok */ }
    forceRefresh = true;
    console.error('[tool-inventory] Force refresh triggered');
  }

  const pluginMtime = getLatestPluginMtime();

  if (!forceRefresh && fs.existsSync(CACHE_FILE)) {
    try {
      const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
      const ageOk = Date.now() - cache.generated_at < TTL_MS;
      const mtimeOk = pluginMtime <= cache.generated_at;
      if (ageOk && mtimeOk) {
        outputHook('SessionStart', formatInventoryCompact(cache.categories));
        if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(path.join(CACHE_DIR, 'tool-inventory-formatted.md'), formatInventoryFull(cache.categories), 'utf-8');
        return;
      }
      if (!mtimeOk) console.error('[tool-inventory] Plugin/skill changes detected, re-scanning...');
    } catch { /* cache invalid, re-scan */ }
  }

  const allItems = [
    ...scanCurrentPluginSkills(),
    ...scanPluginSkills(),
    ...scanLocalSkills(),
    ...scanSlashCommands(),
    ...scanMcpTools()
  ];

  const categories = categorize(allItems);

  // T4: Pre-compute embeddings for semantic search (async, non-blocking)
  let docEmbeddings = null;
  try {
    const emb = require('./embedding-utils.js');
    if (emb.isAvailable()) {
      console.error('[tool-inventory] T4: Computing document embeddings...');
      const docs = [];
      for (const [catId, cat] of Object.entries(categories)) {
        for (const item of cat.items) {
          docs.push({
            id: docs.length,
            text: `${item.name} ${item.description || ''} ${(item.keywords || []).join(' ')}`,
            name: item.name,
            type: item.type,
          });
        }
      }
      // Encode in batches of 32 to avoid memory issues
      const BATCH = 32;
      const vectors = [];
      for (let i = 0; i < docs.length; i += BATCH) {
        const batch = docs.slice(i, i + BATCH).map(d => d.text);
        const batchVecs = await emb.encodeBatch(batch);
        if (batchVecs) vectors.push(...batchVecs);
      }
      if (vectors.length === docs.length) {
        docEmbeddings = docs.map((d, i) => ({ id: d.id, name: d.name, type: d.type, embedding: vectors[i] }));
        console.error(`[tool-inventory] T4: ${docEmbeddings.length} document embeddings computed`);
      }
    }
  } catch (e) {
    console.error('[tool-inventory] T4 embedding disabled:', e.message);
  }

  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cache = {
    generated_at: Date.now(),
    generated_ts: new Date().toISOString(),
    ttl_minutes: TTL_MS / 60000,
    total_items: allItems.length,
    categories,
    docEmbeddings: docEmbeddings || [],
  };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');

  // Compact for context injection, full for file
  outputHook('SessionStart', formatInventoryCompact(categories));
  fs.writeFileSync(path.join(CACHE_DIR, 'tool-inventory-formatted.md'), formatInventoryFull(categories), 'utf-8');
}

try {
  verifyHookScripts();
  (async()=>{try{await main()}catch(e){}})().catch(()=>{});
} catch (e) {
  console.error(`[TOOL-PROACT:tool-inventory] ERROR: ${e.message}`);
  outputHook('SessionStart', `<tool-proact-tool-inventory>\n<!-- tool-inventory error: ${e.message} -->\n</tool-proact-tool-inventory>`);
  process.exit(0);
}
