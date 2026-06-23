#!/usr/bin/env node
// Development Workflow Skill Router - UserPromptSubmit hook.
// Routes prompts through DW skills, domain knowledge, documentation lookup, and fallback tool protocol.

'use strict';
const fs = require('fs');
const path = require('path');

function hasCjk(text) {
  return /[\u3400-\u4DBF\u4E00-\u9FFF]/u.test(text);
}

function tokenize(text) {
  const tokens = [];
  const words = text.toLowerCase().match(/[a-zA-Z0-9_]{2,}/g) || [];
  tokens.push(...words);

  const alpha = text.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (let i = 0; i < alpha.length - 2; i++) tokens.push(alpha.substring(i, i + 3));

  const cjk = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if ((cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0x3400 && cp <= 0x4DBF)) cjk.push(ch);
  }
  for (let i = 0; i < cjk.length - 1; i++) tokens.push(cjk[i] + cjk[i + 1]);

  return tokens;
}

function buildTfidfIndex(documents) {
  const n = documents.length;
  const df = {};
  const tf = {};

  for (const doc of documents) {
    const counts = {};
    for (const token of tokenize(doc.text)) counts[token] = (counts[token] || 0) + 1;
    tf[doc.id] = counts;
    for (const token of Object.keys(counts)) df[token] = (df[token] || 0) + 1;
  }

  const vectors = {};
  for (const doc of documents) {
    const vector = {};
    const docTf = tf[doc.id] || {};
    const maxTf = Math.max(1, ...Object.values(docTf));
    for (const [term, count] of Object.entries(docTf)) {
      vector[term] = (count / maxTf) * Math.log((n + 1) / ((df[term] || 0) + 1));
    }
    vectors[doc.id] = vector;
  }

  return { df, n, vectors };
}

function cosineSimilarity(queryVector, docVector) {
  let dot = 0;
  let queryNorm = 0;
  let docNorm = 0;

  for (const [term, weight] of Object.entries(queryVector)) {
    queryNorm += weight * weight;
    if (docVector[term]) dot += weight * docVector[term];
  }
  for (const weight of Object.values(docVector)) docNorm += weight * weight;

  return dot / (Math.sqrt(queryNorm) * Math.sqrt(docNorm) + 1e-9);
}

function semanticSearch(query, index, topN, minScore) {
  const tokens = tokenize(query);
  if (!tokens.length) return [];

  const termFreq = {};
  for (const token of tokens) termFreq[token] = (termFreq[token] || 0) + 1;

  const maxTf = Math.max(1, ...Object.values(termFreq));
  const queryVector = {};
  for (const [term, count] of Object.entries(termFreq)) {
    queryVector[term] = (count / maxTf) * Math.log((index.n + 1) / ((index.df[term] || 0) + 1));
  }

  const results = [];
  for (const [id, docVector] of Object.entries(index.vectors)) {
    const score = cosineSimilarity(queryVector, docVector);
    if (score >= minScore) results.push({ id, score });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, topN);
}

function keywordMatch(route, msgLower) {
  return route.groups.flat().some((keyword) => msgLower.includes(String(keyword).toLowerCase()));
}

const INTENT_ROUTES = [
  { id: 'diagnosis', skill: 'development-workflow:dw-diagnosis', name: '诊断与根因定位',
    groups: [['诊断','根因','修复','bug','出错','报错','异常','不工作','有问题','故障','崩溃','全零','空','排查','原因','症状','证据','假设','归因','输出','数据','结果','为零','空值','缺数据','无输出','不输出','没结果','没数据','返回空','全为空','debug','diagnose','troubleshoot','root cause','defect','broken','failing','wrong','incorrect','malfunction','error','crash','issue','fix']] },
  { id: 'planning', skill: 'development-workflow:dw-planning', name: '方案设计与操作指引',
    groups: [['方案','设计','操作指引','计划','技术方案','设计文档','回退','如何设计','架构','选型','模板','示例','策略','需求文档','详细设计','plan','design','architecture','solution','guideline','blueprint']] },
  { id: 'implementation', skill: 'development-workflow:dw-implementation', name: 'TDD实现',
    groups: [['tdd','单元测试','测试驱动','写代码','编码','实现','哨兵','数据完整性','测试闸门','覆盖率','sentinel','red-green','refactor','implement','code','develop']] },
  { id: 'verification', skill: 'development-workflow:dw-verification', name: '三C验证',
    groups: [['验证','三c','三C','偏差','正确性','一致性','完整性','回归','功能等价','verification','correctness','consistency','completeness','regression','validate','P0','P1','P2','P3','L1','L2','L3']] },
  { id: 'wrapup', skill: 'development-workflow:dw-wrapup', name: '收尾与知识持久化',
    groups: [['收尾','提交','知识','文档','基线','对比','持久化','同步','commit','push','finalize','wrap up','merge','baseline','memory']] },
  { id: 'optimization', skill: 'development-workflow:dw-optimization', name: '优化方法论',
    groups: [['优化','性能','加速','向量化','并行','并发','太慢','卡','决策树','算法优化','库优化','io优化','profiling','cprofile','numba','jit','gpu','optimize','performance','speed','faster','benchmark']] },
  { id: 'debugging', skill: 'development-workflow:dw-debugging', name: '深度调试',
    groups: [['调试','信号','中间态','闭环','生命周期','管道','逐级','反向验证','未激活','插桩','排查','pipeline','dead code','debugging','signal','lifecycle','trace','log']] },
  { id: 'tooling', skill: 'development-workflow:dw-tooling', name: '工具普查与编排',
    groups: [['工具','mcp','skill','agent','编排','并行','普查','插件','orchestration','parallel','tool','plugin','codegraph','context7']] },
  { id: 'reference', skill: 'development-workflow:dw-reference', name: '检查清单与快速参考',
    groups: [['检查清单','反模式','快速参考','附录','场景','清单','部署前','发布前','上线前','审查表','评审表','cheatsheet','appendix','checklist','anti-pattern','reference']] },
  { id: 'hub', skill: 'development-workflow:development-workflow', name: '开发工作流总纲',
    groups: [['工作流','流程','规范','准则','铁律','开发方法','方法论','全流程','阶段','门控','workflow','methodology','process','standard','iron rule','best practice']] },
];

const TASK_TYPE_ROUTES = [
  { id: 'implement', skill: 'development-workflow:dw-planning', fallback: 'development-workflow:dw-implementation', name: '实现/创建',
    groups: [['create','build','make','develop','implement','add','write','generate','scaffold','init','setup'], ['构建','创建','实现','开发','添加','生成','搭建','写一个','做一个','帮我写','新建']],
    chain: '`Skill:brainstorming` -> `dw-planning` -> TDD -> `dw-verification`' },
  { id: 'debug', skill: 'development-workflow:dw-diagnosis', fallback: 'development-workflow:dw-debugging', name: '调试/修复',
    groups: [['fix','debug','repair','solve','resolve','troubleshoot','diagnose','bug','error','crash','broken','failing','issue','defect','wrong','incorrect','malfunction','exception','not work','zero','empty'], ['修复','调试','解决','排查','修bug','故障','报错','崩溃','不对','有问题','出错了','异常','不工作','全零','为空']],
    chain: '`dw-diagnosis` -> root cause -> fix -> `dw-verification`' },
  { id: 'optimize', skill: 'development-workflow:dw-optimization', fallback: null, name: '优化/重构',
    groups: [['refactor','clean','improve','optimize','restructure','simplify','enhance','tune','performance','slow','faster','speed','profiling','benchmark'], ['重构','清理','优化','整理','改进','提升','加速','性能','太慢','很慢','卡顿']],
    chain: '`dw-optimization` -> implementation -> equivalence verification -> `dw-verification`' },
  { id: 'review', skill: 'development-workflow:dw-verification', fallback: 'development-workflow:dw-reference', name: '审查/检查',
    groups: [['review','audit','inspect','examine','check','verify','validate','assess'], ['审查','审计','检查','验证','确认','评审','复查']],
    chain: '`dw-verification` -> `dw-reference`' },
  { id: 'explore', skill: 'development-workflow:dw-tooling', fallback: null, name: '理解/探索',
    groups: [['understand','code','structure','trace','flow','architecture','explore','find','locate','search','how does','what does','where is','symbol'], ['理解','代码','结构','调用','流程','架构','探索','查找','定位','追踪']],
    chain: '`mcp__codegraph__codegraph_explore` -> `dw-tooling`' },
  { id: 'deploy', skill: 'development-workflow:dw-wrapup', fallback: null, name: '部署/运维',
    groups: [['deploy','ci/cd','ci','cd','pipeline','docker','kubernetes','infrastructure','release','ship','publish'], ['部署','上线','发布','运维','容器','流水线','基础设施','环境','生产']],
    chain: '`dw-wrapup` -> commit preparation -> release' },
];

function loadDomainKnowledge() {
  try {
    const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..');
    const domainsPath = path.join(pluginRoot, 'skills', 'dw-domains', 'domains.json');
    if (fs.existsSync(domainsPath)) {
      return JSON.parse(fs.readFileSync(domainsPath, 'utf-8')).domains || [];
    }
  } catch {
    // Keep the router useful even if a plugin package misses domains.json.
  }

  return [
    { keywords: ['渗透','红队','pentest','exploit','c2','lateral','提权','bypass','evasion','red team','后渗透'],
      text: '## L3 Domain: security/red-team\nApply least privilege, audit logging, isolated testing, and explicit authorization before sensitive operations.' },
    { keywords: ['蓝队','告警','ioc','应急','取证','siem','edr','blue team','incident','containment','防御','检测'],
      text: '## L3 Domain: incident response\nPrefer observable evidence, containment plan, log retention, and reversible remediation.' },
    { keywords: ['sqli','xss','ssrf','rce','injection','owasp','web渗透','api安全','sql注入','csrf','xxe','idor','安全漏洞'],
      text: '## L3 Domain: web security\nValidate input, use parameterized queries, avoid leaking error details, and check OWASP Top 10 risks.' },
    { keywords: ['api设计','rest','graphql','grpc','endpoint','versioning','api design','接口设计','openapi'],
      text: '## L3 Domain: API design\nUse stable versioning, consistent errors, pagination, authentication, rate limits, and OpenAPI contracts.' },
    { keywords: ['缓存','redis','memcached','cache','cdn','invalidation','cache aside'],
      text: '## L3 Domain: caching\nDefine invalidation, TTLs, stampede protection, and cache-aside behavior before implementation.' },
    { keywords: ['kubernetes','k8s','docker','container','微服务','microservice','service mesh','云原生','cloud native','部署'],
      text: '## L3 Domain: cloud native\nPrefer stateless services, health/readiness checks, declarative configuration, and graceful shutdown.' },
    { keywords: ['kafka','rabbitmq','消息队列','event driven','pub/sub','message queue','事件驱动','异步','streaming'],
      text: '## L3 Domain: messaging\nDesign idempotent consumers, retries, dead letters, ordering guarantees, and backpressure.' },
    { keywords: ['rag','retrieval','向量','embedding','chunking','vector','知识库','语义搜索','检索增强'],
      text: '## L3 Domain: RAG\nSpecify chunking, retrieval, reranking, citations, freshness, and evaluation metrics.' },
    { keywords: ['ai agent','tool use','function calling','agent框架','orchestration','multi agent','agentic','智能体'],
      text: '## L3 Domain: agent tooling\nDefine tool schemas, failure handling, context limits, sandboxing, and confirmation for high-risk actions.' },
    { keywords: ['prompt injection','jailbreak','guardrail','llm安全','提示词注入','模型安全','ai safety'],
      text: '## L3 Domain: LLM safety\nTreat retrieved/user content as untrusted, isolate instructions, and add confirmation for sensitive actions.' },
  ];
}

const DOMAIN_KNOWLEDGE = loadDomainKnowledge();

const LIB_PATTERNS = [
  /(?:use|using|with|install|import)\s+([a-zA-Z][\w.-]{2,30})/g,
  /\b(react|vue|angular|svelte|next\.js|nuxt|express|fastapi|django|flask|spring|laravel|prisma|tailwind|pytorch|tensorflow|pandas|numpy|scipy|plotly|docker|kubernetes|redis|postgres|mongodb|graphql|grpc|kafka|rabbitmq|nginx)\b/gi,
];

function readPrompt(inputData) {
  try {
    const payload = JSON.parse(inputData);
    return payload.prompt || payload.userMessage || payload.message || payload.content || '';
  } catch {
    return inputData;
  }
}

function addSkillRouting(userMessage, msgLower, injections) {
  const intentDocs = INTENT_ROUTES.map((route) => ({ id: route.id, text: route.groups.flat().join(' ') }));
  const intentIndex = buildTfidfIndex(intentDocs);
  const intentResults = semanticSearch(userMessage, intentIndex, 3, 0.04);

  const exactIntent = INTENT_ROUTES.find((route) => keywordMatch(route, msgLower));
  const semanticIntent = intentResults.length ? INTENT_ROUTES.find((route) => route.id === intentResults[0].id) : null;
  const topIntent = exactIntent || semanticIntent;

  if (topIntent) {
    const score = exactIntent ? Math.max(0.11, intentResults[0]?.score || 0) : intentResults[0].score;
    if (score >= 0.10) {
      injections.push(`## L1 direct skill route (${(score * 100).toFixed(0)}%)\nUse first: \`${topIntent.skill}\` (${topIntent.name})`);
    } else if (score >= 0.04) {
      injections.push(`## L2 weak skill route (${(score * 100).toFixed(0)}%)\nIf relevant, use: \`${topIntent.skill}\` (${topIntent.name})`);
    }
  }

  const taskDocs = TASK_TYPE_ROUTES.map((task, index) => ({ id: String(index), text: task.groups.flat().join(' ') }));
  const taskIndex = buildTfidfIndex(taskDocs);
  const taskResults = semanticSearch(userMessage, taskIndex, 1, 0);
  const exactTaskIndex = TASK_TYPE_ROUTES.findIndex((task) => keywordMatch(task, msgLower));
  const taskIndexValue = exactTaskIndex >= 0 ? exactTaskIndex : (taskResults.length ? Number(taskResults[0].id) : -1);

  if (taskIndexValue >= 0) {
    const task = TASK_TYPE_ROUTES[taskIndexValue];
    const score = exactTaskIndex >= 0 ? Math.max(0.09, taskResults[0]?.score || 0) : taskResults[0].score;
    if (score >= 0.08) {
      injections.push(`## L2 task route: ${task.name} (${(score * 100).toFixed(0)}%)\nChain: ${task.chain}\nSuggested skill: \`${task.skill}\`${task.fallback ? ` or \`${task.fallback}\`` : ''}`);
    } else if (score >= 0.04 && !topIntent) {
      injections.push(`## L2 possible task route: ${task.name}\nSuggested skill: \`${task.skill}\``);
    }
  }
}

function addDomainRouting(msgLower, injections) {
  for (const domain of DOMAIN_KNOWLEDGE) {
    const keywords = domain.keywords || [];
    if (keywords.some((keyword) => msgLower.includes(String(keyword).toLowerCase()))) {
      injections.push(domain.text || `## L3 domain route\nDomain: ${domain.name || 'matched'}`);
      break;
    }
  }
}

function addLibraryAndSearchRouting(userMessage, injections) {
  const detectedLibs = new Set();
  for (const pattern of LIB_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(userMessage)) !== null) {
      const lib = (match[1] || match[0]).toLowerCase();
      if (lib.length > 2 && !['the','and','for','with','this','that'].includes(lib)) detectedLibs.add(lib);
    }
  }

  if (detectedLibs.size > 0) {
    const libList = [...detectedLibs].slice(0, 5).join(', ');
    injections.push(`## L3 library/docs route: ${libList}\nBefore coding against these APIs, use \`mcp__context7__resolve-library-id\` and \`mcp__context7__query-docs\`.`);
  }

  if (/(?:搜索|查一下|查找|最新|今天|现在|新闻|资料|recent|current|news|search|find out|look up|what is|how to|who is|when did)/i.test(userMessage)) {
    injections.push('## L3 search route\nFor current facts, use `mcp__tavily__tavily_search` or `mcp__tavily__tavily_research`.');
  }
}

function addReviewReminder(injections) {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) return;

  const reviewMarker = path.join(home, '.claude', '.cache', 'dw-review-needed.json');
  try {
    if (!fs.existsSync(reviewMarker)) return;
    const marker = JSON.parse(fs.readFileSync(reviewMarker, 'utf-8'));
    if (Date.now() - marker.ts >= 300000) return;

    const files = Array.isArray(marker.files) ? marker.files.join(', ') : '';
    injections.push(`## L2 review reminder\n${marker.count || 1} modified file(s) need review.\nFiles: ${files}\nCall Skill:requesting-code-review or /code-review before claiming completion.`);
    try { fs.unlinkSync(reviewMarker); } catch {}
  } catch {
    // Review reminder must never block the router.
  }
}

(async () => {
  try {
    let inputData = '';
    if (!process.stdin.isTTY) inputData = fs.readFileSync(0, 'utf-8');

    const userMessage = readPrompt(inputData).trim();
    const promptHasCjk = hasCjk(userMessage);
    if (!userMessage) process.exit(0);
    if (!promptHasCjk && userMessage.length < 3) process.exit(0);

    const msgLower = userMessage.toLowerCase();
    const injections = [];

    if (promptHasCjk || userMessage.length >= 8) {
      addSkillRouting(userMessage, msgLower, injections);
      addDomainRouting(msgLower, injections);
      addLibraryAndSearchRouting(userMessage, injections);
      addReviewReminder(injections);
    }

    if (injections.length === 0) {
      const minLen = promptHasCjk ? 2 : 8;
      if (userMessage.length >= minLen) {
        injections.push('## L4 主动工具协议 fallback / active tool protocol fallback\n- Code understanding: `mcp__codegraph__codegraph_explore`\n- Library/API docs: `mcp__context7__resolve-library-id` + `mcp__context7__query-docs`\n- Complex reasoning: `mcp__sequential-thinking__sequentialthinking`\n- Current information: `mcp__tavily__tavily_search`\n- Durable findings: `mcp__memory__create_entities`');
      }
    }

    if (injections.length > 0) {
      const context = `<dw-skill-router>\n${injections.join('\n\n---\n\n')}\n</dw-skill-router>`;
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }));
    }

    process.exit(0);
  } catch {
    process.exit(0);
  }
})();
