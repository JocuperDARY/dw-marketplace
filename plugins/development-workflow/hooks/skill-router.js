#!/usr/bin/env node
// Development Workflow Skill Router — UserPromptSubmit Hook (v2.0)
// Integrated from tool-proact: TF-IDF semantic matching + task-type detection +
// domain knowledge injection + library detection + code-review reminder.
//
// Layers:
//   1. DW intent → sub-skill routing (10 intent routes)
//   2. Task-type detection → mapped to DW sub-skills (6 types from tool-proact)
//   3. Domain knowledge inline injection (16 domains from tool-proact)
//   4. Library/API detection → Context7 suggestion
//   5. Code-review pending reminder
//   T1(≥0.10) direct, T2(≥0.05) suggest, T3(else) fallback

'use strict';
const fs = require('fs');
const path = require('path');

// ═══ TF-IDF Engine (shared with tool-proact) ═══
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
  const N = documents.length, df = {}, tf = {};
  for (const doc of documents) {
    const tokens = tokenize(doc.text), counts = {};
    for (const t of tokens) counts[t] = (counts[t] || 0) + 1;
    tf[doc.id] = counts;
    for (const t of Object.keys(counts)) df[t] = (df[t] || 0) + 1;
  }
  const vectors = {};
  for (const doc of documents) {
    const vec = {}, docTf = tf[doc.id] || {};
    const maxTf = Math.max(1, ...Object.values(docTf));
    for (const [term, count] of Object.entries(docTf))
      vec[term] = (count / maxTf) * Math.log((N + 1) / ((df[term] || 0) + 1));
    vectors[doc.id] = vec;
  }
  return { df, N, vectors };
}

function cosineSimilarity(qv, dv) {
  let dot = 0, nq = 0, nd = 0;
  for (const [t, w] of Object.entries(qv)) { nq += w * w; if (dv[t]) dot += w * dv[t]; }
  for (const w of Object.values(dv)) nd += w * w;
  return dot / (Math.sqrt(nq) * Math.sqrt(nd) + 1e-9);
}

function semanticSearch(query, index, topN, minScore) {
  topN = topN || 3; minScore = minScore || 0.04;
  const tokens = tokenize(query);
  if (!tokens.length) return [];
  const tf = {};
  for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
  const maxTf = Math.max(1, ...Object.values(tf)), qv = {};
  for (const [t, c] of Object.entries(tf))
    qv[t] = (c / maxTf) * Math.log((index.N + 1) / ((index.df[t] || 0) + 1));
  const results = [];
  for (const [id, dv] of Object.entries(index.vectors)) {
    const sim = cosineSimilarity(qv, dv);
    if (sim >= minScore) results.push({ id, sim });
  }
  return results.sort((a, b) => b.sim - a.sim).slice(0, topN);
}

// ═══ Layer 1: DW Intent Routes ═══
const INTENT_ROUTES = [
  { id:'diagnosis',skill:'development-workflow:dw-diagnosis',name:'诊断与根因定位',
    groups:[['诊断','根因','bug','出错','报错','异常','不工作','有问题','故障','崩溃','全零','空','排查','原因','debug','diagnose','troubleshoot','root cause','defect','broken','failing','wrong','incorrect','malfunction','error','crash','issue','症状','证据','假设','归因','输出','数据','结果','为零','空值','缺数据','无输出','不输出','没结果','没数据','返回空','全为空']]},
  { id:'planning',skill:'development-workflow:dw-planning',name:'方案设计与操作指引',
    groups:[['方案','设计','操作指引','计划','技术方案','设计文档','回退','实现','如何设计','架构','选型','plan','design','architecture','solution','guideline','blueprint','模板','示例','策略','编写','编写方案','需求文档','详细设计']]},
  { id:'implementation',skill:'development-workflow:dw-implementation',name:'TDD实现',
    groups:[['tdd','单元测试','测试驱动','写代码','编码','哨兵','数据完整性','sentinel','red-green','refactor','implement','code','develop','测试闸门','覆盖率']]},
  { id:'verification',skill:'development-workflow:dw-verification',name:'三C验证',
    groups:[['验证','三c','三C','偏差','正确性','一致性','完整性','回归','功能等价','verification','correctness','consistency','completeness','regression','validate','P0','P1','P2','P3','L1','L2','L3']]},
  { id:'wrapup',skill:'development-workflow:dw-wrapup',name:'收尾与知识持久化',
    groups:[['收尾','提交','commit','push','知识','文档','基线','对比','finalize','wrap up','merge','baseline','memory','持久化','同步']]},
  { id:'optimization',skill:'development-workflow:dw-optimization',name:'优化方法论',
    groups:[['优化','性能','加速','profiling','cprofile','numba','jit','向量化','并行','并发','gpu','太慢','卡','optimize','performance','speed','faster','benchmark','决策树','算法优化','库优化','io优化']]},
  { id:'debugging',skill:'development-workflow:dw-debugging',name:'深度调试',
    groups:[['调试','信号','中间态','闭环','生命周期','管道','pipeline','逐级','反向验证','未激活','dead code','debugging','signal','lifecycle','trace','log','插桩','排查']]},
  { id:'tooling',skill:'development-workflow:dw-tooling',name:'工具普查与编排',
    groups:[['工具','mcp','skill','agent','编排','并行','普查','选型','插件','orchestration','parallel','tool','plugin','codegraph','context7']]},
  { id:'reference',skill:'development-workflow:dw-reference',name:'检查清单与快速参考',
    groups:[['检查清单','反模式','快速参考','cheatsheet','附录','appendix','checklist','anti-pattern','reference','场景','清单','部署前','发布前','上线前','审查表','评审表']]},
  { id:'hub',skill:'development-workflow:development-workflow',name:'开发工作流总纲',
    groups:[['工作流','流程','规范','准则','铁律','开发方法','方法论','全流程','阶段','门控','workflow','methodology','process','standard','iron rule','best practice']]},
];

// ═══ Layer 2: Task-Type Detection → DW Skill Mapping ═══
// Source: tool-proact TASK_PATTERNS with synonym groups
const TASK_TYPE_ROUTES = [
  { id:'implement', skill:'development-workflow:dw-planning', fallback:'development-workflow:dw-implementation', name:'实现/创建',
    groups:[['create','build','make','develop','implement','add','write','generate','scaffold','init','setup'],
            ['构建','创建','实现','开发','添加','生成','搭建','写一个','做一个','帮我写','新建']],
    chain:'`Skill:brainstorming` → `dw-planning` (操作指引) → TDD → `dw-verification` (验证)' },
  { id:'debug', skill:'development-workflow:dw-diagnosis', fallback:'development-workflow:dw-debugging', name:'调试/修复',
    groups:[['fix','debug','repair','solve','resolve','troubleshoot','diagnose','bug','error','crash','broken','failing','issue','defect','wrong','incorrect','malfunction','exception','not work','zero','empty'],
            ['修复','调试','解决','排查','修bug','故障','报错','崩溃','不对','有问题','出错了','异常','不工作','全零','为空']],
    chain:'`dw-diagnosis` (诊断) → 根因 → 修复 → `dw-verification` (验证)' },
  { id:'optimize', skill:'development-workflow:dw-optimization', fallback:null, name:'优化/重构',
    groups:[['refactor','clean','improve','optimize','restructure','simplify','enhance','tune','performance','slow','faster','speed','profiling','benchmark'],
            ['重构','清理','优化','整理','改进','提升','加速','性能','太慢','很慢','卡顿','profiling','cProfile','benchmark']],
    chain:'`dw-optimization` (优化决策树) → 实现 → 功能等价验证 → `dw-verification`' },
  { id:'review', skill:'development-workflow:dw-verification', fallback:'development-workflow:dw-reference', name:'审查/检查',
    groups:[['review','audit','inspect','examine','check','verify','validate','assess'],
            ['审查','审计','检查','验证','确认','评审','复查']],
    chain:'`dw-verification` (三C验证) → `dw-reference` (检查清单)' },
  { id:'explore', skill:'development-workflow:dw-tooling', fallback:null, name:'理解/探索',
    groups:[['understand','code','structure','trace','flow','architecture','explore','find','locate','search','how does','what does','where is','symbol'],
            ['理解','代码','结构','调用','流程','架构','探索','查找','定位','追踪','codegraph']],
    chain:'`mcp__codegraph__codegraph_explore` → `dw-tooling` (工具普查)' },
  { id:'deploy', skill:'development-workflow:dw-wrapup', fallback:null, name:'部署/运维',
    groups:[['deploy','ci/cd','ci','cd','pipeline','docker','kubernetes','infrastructure','release','ship','publish'],
            ['部署','上线','发布','运维','容器','流水线','基础设施','环境','生产']],
    chain:'`dw-wrapup` (收尾) → commit → push' },
];

// ═══ Layer 3: Domain Knowledge (loaded from domains.json, inline fallback) ═══
function loadDomainKnowledge() {
  try {
    const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..');
    const domainsPath = path.join(pluginRoot, 'skills', 'dw-domains', 'domains.json');
    if (fs.existsSync(domainsPath)) {
      return JSON.parse(fs.readFileSync(domainsPath, 'utf-8')).domains || [];
    }
  } catch (e) { /* fall through to inline */ }
  return [];
}
const loadedDomains = loadDomainKnowledge();
const DOMAIN_KNOWLEDGE = loadedDomains.length > 0 ? loadedDomains : [
  { keywords:['渗透','红队','pentest','exploit','c2','lateral','提权','bypass','evasion','red team','后渗透'],
    name:'红队渗透', text: '## 红队安全\n原则: 最小权限、纵深防御、假定被入侵。敏感操作需审计日志。参考: `Skill:ecc:security-review`' },
  { keywords:['蓝队','告警','ioc','应急','取证','siem','edr','blue team','incident','containment','防御','检测'],
    name:'蓝队防御', text: '## 蓝队防御\n原则: 监控先行、告警可操作、应急有预案。日志集中管理，IOC自动阻断。' },
  { keywords:['sqli','xss','ssrf','rce','injection','owasp','web渗透','api安全','sql注入','csrf','xxe','idor','安全漏洞'],
    name:'Web渗透', text: '## Web渗透\n核心原则: 所有用户输入验证清理、参数化查询防SQL注入、CSRF保护、错误信息不泄露。参考: OWASP Top 10' },
  { keywords:['代码审计','污点分析','sink','source','危险函数','code audit','静态分析','eval(','exec(','innerhtml','dangerous function','恶意输入','taint'],
    name:'代码审计', text: '## 代码安全审计\n追踪数据流: source→sink; 标记不可信数据。危险函数: eval/exec/innerHTML。参考: `Skill:ecc:security-review`' },
  { keywords:['逆向','pwn','fuzzing','栈溢出','堆溢出','rop','binary','reversing','缓冲区'],
    name:'漏洞研究', text: '## 漏洞研究\n原则: 隔离环境测试、记录完整利用链、负责任披露。' },
  { keywords:['osint','威胁情报','威胁建模','threat model','att&ck','threat hunting','情报收集'],
    name:'威胁情报', text: '## 威胁情报\n原则: 来源交叉验证、时效性评估、可操作告警。' },
  { keywords:['api设计','rest','graphql','grpc','endpoint','versioning','api design','接口设计','openapi'],
    name:'API设计', text: '## API设计\n原则: RESTful命名、版本化(/v1/)、一致错误格式、分页支持、限流保护。' },
  { keywords:['缓存','redis','memcached','cache','cdn','invalidation','cache aside'],
    name:'缓存架构', text: '## 缓存架构\n原则: 读多写少用Cache-Aside、注意缓存穿透/击穿/雪崩、设置合理TTL。' },
  { keywords:['kubernetes','k8s','docker','container','微服务','microservice','service mesh','云原生','cloud native','部署'],
    name:'云原生', text: '## 云原生\n原则: 无状态容器、声明式配置、健康检查+就绪探针、优雅关闭。' },
  { keywords:['kafka','rabbitmq','消息队列','event driven','pub/sub','message queue','事件驱动','异步','streaming'],
    name:'消息队列', text: '## 消息队列\n原则: 幂等消费、死信队列、消息持久化、消费者组负载均衡。' },
  { keywords:['rag','retrieval','向量','embedding','chunking','vector','知识库','语义搜索','检索增强'],
    name:'RAG系统', text: '## RAG系统\n原则: 文档分块策略、向量数据库选型(<1M pgvector/Chroma，>1M Pinecone/Weaviate)、检索+重排序、引用溯源。' },
  { keywords:['ai agent','tool use','function calling','agent框架','orchestration','multi agent','agentic','智能体'],
    name:'Agent开发', text: '## Agent开发\n原则: 工具定义清晰(name+description+schema)、错误处理完善、上下文窗口管理、安全沙箱。' },
  { keywords:['prompt injection','jailbreak','guardrail','llm安全','提示词注入','模型安全','ai safety'],
    name:'LLM安全', text: '## LLM安全\n原则: 防prompt注入、输出过滤、敏感数据脱敏、用户确认高危操作。' },
];

// ═══ Library Detection Patterns ═══
const LIB_PATTERNS = [
  /(?:use|using|with|install|import)\s+([a-zA-Z][\w.-]{2,30})/g,
  /\b(react|vue|angular|svelte|next\.js|nuxt|express|fastapi|django|flask|spring|laravel|prisma|tailwind|pytorch|tensorflow|pandas|numpy|scipy|plotly|docker|kubernetes|redis|postgres|mongodb|graphql|grpc|kafka|rabbitmq|nginx)\b/gi,
];

// ═══ Main ═══
(async () => {
  try {
    let inputData = '';
    if (!process.stdin.isTTY) inputData = fs.readFileSync(0, 'utf-8');
    let userMessage = '';
    try { const p = JSON.parse(inputData); userMessage = p.userMessage || p.message || p.content || p.prompt || ''; } catch { userMessage = inputData; }
    if (!userMessage || userMessage.length < 3) process.exit(0);

    const msgLower = userMessage.toLowerCase();
    var hasCJK = /[4E00-9FFF3400-4DBF]/.test(userMessage);
    const injections = [];

    var isShortEnglish = !hasCJK && userMessage.length < 8;
    if (!isShortEnglish) {
    // ── Layer 1: DW Intent Routing ──
    const docs = INTENT_ROUTES.map(r => ({ id: r.id, text: r.groups.flat().join(' ') }));
    const index = buildTfidfIndex(docs);
    const results = semanticSearch(userMessage, index, 3, 0.04);
    let matched = results.map(r => INTENT_ROUTES.find(ir => ir.id === r.id)).filter(Boolean);
    if (!matched.length && userMessage.length < 15) {
      for (const route of INTENT_ROUTES) {
        if (route.groups.flat().some(w => msgLower.includes(w.toLowerCase()))) { matched.push(route); break; }
      }
    }
    if (matched.length) {
      const top = matched[0], score = results.length ? results[0].sim : 0.05;
      if (score >= 0.10) injections.push(`## 💡 DW路由 (${(score*100).toFixed(0)}%) → **${top.name}**: \`${top.skill}\``);
      else if (score >= 0.04) injections.push(`## 💡 DW路由 (${(score*100).toFixed(0)}%) → 疑似 **${top.name}**: \`${top.skill}\``);
    }

    // ── Layer 2: Task-Type Detection → DW skill mapping ──
    const taskDocs = TASK_TYPE_ROUTES.map((t, i) => ({ id: String(i), text: t.groups.flat().join(' ') }));
    const taskIndex = buildTfidfIndex(taskDocs);
    const taskResults = semanticSearch(userMessage, taskIndex, 1, 0);
    if (taskResults.length > 0) {
      const score = taskResults[0].sim;
      const task = TASK_TYPE_ROUTES[parseInt(taskResults[0].id)];
      if (score >= 0.08) {
        injections.push(`## 🎯 任务类型: **${task.name}** (${(score*100).toFixed(0)}%)
执行链: ${task.chain}
建议调用: \`${task.skill}\`${task.fallback ? ' 或 \`'+task.fallback+'\`' : ''}`);
      } else if (score >= 0.04 && matched.length === 0) {
        injections.push(`## 🎯 疑似任务: **${task.name}** → \`${task.skill}\``);
      }
    }

    // ── Layer 3: Domain Knowledge Injection ──
    for (const domain of DOMAIN_KNOWLEDGE) {
      if (domain.keywords.some(kw => msgLower.includes(kw.toLowerCase()))) {
        injections.push(domain.text);
        break; // Inject at most 1 domain per message
      }
    }

    // ── Layer 4: Library Detection → Context7 ──
    const detectedLibs = new Set();
    for (const pattern of LIB_PATTERNS) {
      let match;
      while ((match = pattern.exec(userMessage)) !== null) {
        const lib = (match[1] || match[0]).toLowerCase();
        if (lib.length > 2 && !['the','and','for','with','this','that'].includes(lib)) detectedLibs.add(lib);
      }
    }
    if (detectedLibs.size > 0) {
      const libList = [...detectedLibs].slice(0, 5).join(', ');
      injections.push(`## 📚 检测到库/框架: ${libList}\n写代码前先查询最新文档: \`mcp__context7__resolve-library-id\` + \`mcp__context7__query-docs\``);
    }
    if (/(?:搜索|查一下|查找|最新|recent|current|news|search|find out|look up|what is|how to|who is|when did)/i.test(userMessage)) {
      injections.push('## 🔍 检测到搜索/查询意图\n需要最新信息时使用: \`mcp__tavily__tavily_search\` (普通搜索) / \`mcp__tavily__tavily_research\` (深度研究)');
    }

    // ── Layer 2.5: Review Reminder (from post-code-check marker) ──
    const HOME=process.env.HOME||process.env.USERPROFILE||'';
    const reviewMarker=path.join(HOME,'.claude','.cache','dw-review-needed.json');
    try{if(fs.existsSync(reviewMarker)){const rm=JSON.parse(fs.readFileSync(reviewMarker,'utf-8'));if(Date.now()-rm.ts<3e5){injections.push(`## ⛔ 代码审查待办 — ${rm.count} 个文件已修改未审查\n文件: ${rm.files.join(', ')} (${rm.lastLines} 行)\n**请立即调用** Skill:requesting-code-review 或 /code-review`);try{fs.unlinkSync(reviewMarker)}catch{}}}}catch{}

    } // close isShortEnglish guard
    // ── Standing orders fallback ──
    if (injections.length === 0) {
      const hasCJK=/[一-鿿]/.test(userMessage);const minLen=hasCJK?2:3;
      if(userMessage.length>=minLen)injections.push('## ⚡ 主动工具协议\n- 代码理解 → mcp__codegraph__codegraph_explore\n- 库/API → mcp__context7__resolve-library-id + mcp__context7__query-docs\n- 复杂推理 → mcp__sequential-thinking__sequentialthinking\n- 最新信息 → mcp__tavily__tavily_search');
    }

    if (injections.length > 0) {
      const context = `<dw-skill-router>\n${injections.join('\n\n---\n\n')}\n</dw-skill-router>`;
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }));
    }
    process.exit(0);
  } catch (e) { process.exit(0); }
})();
