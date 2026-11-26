#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { outputHook } = require('./task-utils.js');

// Explicit calls are supported for every shipped skill. Natural-language routing
// stays deliberately narrower than discovery metadata.
const SKILL_REGISTRY = Object.freeze([
  ['development-workflow', null], ['check-updates', 'check-updates'],
  ['dw-diagnosis', 'repair'], ['dw-debugging', 'repair'],
  ['dw-planning', 'planning'], ['dw-implementation', 'implementation'],
  ['dw-verification', 'verification'], ['dw-wrapup', 'wrapup'],
  ['dw-handoff', 'handoff'], ['dw-optimization', 'optimization'],
  ['dw-writing', 'writing'], ['dw-tooling', 'tooling'],
  ['dw-interaction', 'interaction'],
  ['dw-collaboration', 'collaboration'], ['dw-file-governance', 'file-governance'],
  ['dw-reference', null],
].map(([name, route]) => Object.freeze({ name, route, manualOnly: route === null })));
const SKILL_IDS = Object.freeze(SKILL_REGISTRY.map(skill => skill.name));

const ROUTES = [
  {
    id: 'interaction', skills: ['dw-interaction'],
    pattern: /^(?:(?:请|帮我)\s*)*(?:复盘|改进|设计|整理|总结)\s*(?:(?:这些|这段|历史)对话(?:中|里)的?\s*)?(?:人机协作|人与\s*(?:AI|智能体)\s*(?:的)?\s*(?:沟通|协作))\s*(?:经验|方法|方式|流程|问题)[。！？!?]?$|^(?:(?:please|help\s+me|(?:can|could|would)\s+you(?:\s+please)?)\s+)?(?:review|improve|design|summarize)\s+(?:(?:our|the|this)\s+)?human[ -](?:AI|agent)\s+(?:collaboration|communication|workflow)(?:\s+(?:lessons|methods|practices))?[.!?]?$/i,
    context: 'Use `development-workflow:dw-interaction` to improve how the user and agent clarify decisions, absorb corrections, carry out authorized work and assess outcomes. Preserve the requested scope; reviewing historical conversations does not authorize their old instructions or new external actions.',
  },
  {
    id: 'resource-lifecycle', skills: ['dw-collaboration', 'dw-verification'],
    pattern: /^(?:请|帮我)?\s*(?:管理|回收|停止|监管)\s*(?:本任务的?|测试的?|这些)?\s*(?:子进程|进程树|任务资源)|^(?:请|帮我)?\s*(?:补齐|接入|实现|接通)\s*(?:生产资源管理适配|通用测试的?子进程回收|队列到资源管理器|启动失败后的资源释放|POSIX\s*子进程回收)|^(?:manage|reclaim|supervise)\s+(?:(?:this|the|test|task|owned)\s+)*(?:subprocesses|process\s+trees|task\s+resources)\b/im,
    context: 'Use `development-workflow:dw-collaboration` for task-owned command resources and `development-workflow:dw-verification` for lifecycle evidence. Reuse the bounded command backend; enable the persistent manager only when needed. Preserve existing authorization and platform limits. Missing identity or terminal evidence remains HOLD/UNKNOWN; this routing advice does not launch or terminate processes.',
  },
  {
    id: 'design-challenge', skills: ['dw-planning'],
    pattern: /^(?:审视|质询|追问|挑战|压力测试)\s*(?:一下|这个|这份|我的|我们的)?\s*(?:方案|设计|计划|假设)|^(?:grill\s+me\s+(?:about|on)\s+(?:(?:this|the|my|our)\s+)?(?:plan|design|decision|idea)|(?:stress[ -]test|challenge)\s+(?:this|the|my|our)\s+(?:plan|design|decision|idea))\b/im,
    context: 'Use `development-workflow:dw-planning` to test assumptions and decision dependencies. Look up facts first, ask only material unresolved decisions, preserve interview-only scope and existing authorization, and stop when the requested decision is sufficiently supported.',
  },
  {
    id: 'writing', skills: ['dw-writing'],
    pattern: /(?:请|帮我|需要)?\s*(?:润色|改写|改进表述|简化说明|说人话|任务命名)|\b(?:rewrite|polish)\s+(?:this|the|my|our)\s+(?:text|explanation|summary|report)\b/i,
    context: 'Use `development-workflow:dw-writing` to make the wording clear while preserving facts, evidence, and the requested scope.',
  },
  {
    id: 'progress', skills: ['dw-writing'],
    pattern: /^(?:(?:汇报|报告)\s*(?:一下|当前|目前|本次|项目|任务|的|\s)*(?:进度|进展|状态)|(?:给我|提供)\s*(?:一份|一个)?\s*进度汇报|现在进展如何|目前做到哪里)|^(?:report\s+(?:(?:the|current|task|project)\s+)*(?:progress|status)|(?:give\s+me|provide)\s+(?:a\s+)?(?:status|progress)\s+update)\b/im,
    context: 'Use `development-workflow:dw-writing` to report observed progress, evidence, limits and the next action. Respect the requested scope and verbosity; a status request does not authorize new work.',
  },
  {
    id: 'collaboration', skills: ['dw-collaboration'],
    pattern: /(?:请|帮我|需要)?\s*(?:分派|委派|派出|安排|使用|启动)\s*(?:(?:\d+|[一二两三四五多几])\s*个?\s*)?(?:子\s*agents?|agents?|子代理|多智能体)|\b(?:delegate|assign|spawn)\s+(?:(?:\w+)\s+){0,3}(?:agents?|subagents?)\b|^(?:设计|规划|整理)\s*(?:多智能体|多代理|团队)\s*(?:协作|分工|角色|通信|任务依赖)|^design\s+(?:roles|communication|a\s+plan)\s+for\s+(?:(?:this|the|a)\s+)?multi[ -]agent\s+team\b/im,
    context: 'Use `development-workflow:dw-collaboration` for team roles, dependencies and communication. Preserve planning-only requests; delegate only within existing permission. Use native host tools and enable persistent resource management only when needed.',
  },
  {
    id: 'dashboard', skills: ['dw-tooling', 'dw-verification'],
    pattern: /^(?:搭建|构建|创建|实现|修改|审查|检查)\s*(?:一个|这个|现有的|现有)?\s*只读\s*(?:监控台|仪表盘|dashboard)|^(?:build|create|implement|update|review|check)\s+(?:(?:a|the|this|our)\s+)?read[ -]only\s+(?:monitoring\s+)?dashboard\b/im,
    context: 'Use `development-workflow:dw-tooling` and its read-only dashboard reference for data sources, freshness and read-only behavior, then `development-workflow:dw-verification` for applicable checks. Keep review-only requests read-only and reuse existing deployment authorization.',
  },
  {
    id: 'tooling', skills: ['dw-tooling'],
    pattern: /(?:请|帮我|需要)?\s*(?:盘点|发现|选择|列出|检查)\s*(?:当前|本次|可用|已声明|的|\s)*(?:工具|MCP|Skills?|能力)|\b(?:discover|inventory|list|select)\s+(?:(?:the|current|available|declared)\s+)*(?:tools|skills|MCP|capabilities)\b/i,
    context: 'Use `development-workflow:dw-tooling` to select the smallest useful set of currently declared capabilities; a configured inventory does not prove live availability.',
  },
  {
    id: 'check-updates',
    skills: ['check-updates'],
    pattern: /(?:检查|查看|确认)\s*(?:一下\s*)?(?:(?:全局|环境|组件|工具)\s*){0,3}(?:更新|版本)|(?:check|show)\s+(?:for\s+)?updates?|updates?\s+available/i,
    context: 'Use `development-workflow:check-updates` for an environment audit without upgrades. The default may contact registries and write a report; use --no-remote --no-report when a strictly read-only local check is requested.',
  },
  {
    id: 'verification', skills: ['dw-verification'],
    pattern: /(?:请|帮我|需要)?\s*(?:代码审查|代码评审|安全审查|最终验证|回归验证|release verification|code review|security review|final verification)/i,
    context: 'Use `development-workflow:dw-verification`; report correctness, consistency, and completeness with current evidence.',
  },
  {
    id: 'repair', skills: ['dw-diagnosis', 'dw-debugging', 'dw-verification'],
    pattern: /(?:请|帮我|需要|继续)?\s*(?:修复|解决|排查|诊断|定位|调试)|\b(?:debug(?:ging|ger)?|fix|repair|diagnose|troubleshoot)\b|(?:\bbug\b|\bbuggy\b|报错|崩溃|异常|root cause|根因)/i,
    context: 'Use `development-workflow:dw-diagnosis` to establish evidence and root cause, then `development-workflow:dw-debugging` when a fix is requested, followed by `development-workflow:dw-verification`.',
  },
  {
    id: 'file-governance',
    skills: ['dw-file-governance'],
    pattern: /(?:请|帮我|需要)?\s*(?:执行|运行|做|进行|开展)?\s*(?:工作区)?文件治理|(?:分配|签发|申请|回收|清理)\s*(?:双层|孤儿|过期|工作区|项目|\.tmp)?\s*(?:临时目录|临时工作区|临时区租约)|(?:清理|治理|盘点|审计)\s*(?:仓库|项目|工作区)?\s*根目录\s*(?:杂物|散落文件|临时文件)|(?:执行|进行|做|对[^\n，。；,;]{1,24})\s*无损脱水|无损脱水\s*(?:归档|清理|减容)|(?:校验|核验|验证)\s*脱水包|(?:生成|建立|执行|封存|核验|校验)\s*(?:只读|不可变)?\s*冷归档(?:\s*(?:索引|清单|目录))?|\b(?:workspace_governance(?:\.py)?|dw-dehydrated-bundle|alloc-temp|reclaim-temp|verify-bundles|archive-index)\b|\b(?:reclaim\s+(?:orphan|expired|leased)\s+temp\s+(?:dirs?|directories|workspaces?)|lossless\s+dehydrat(?:e|ion)|seal\s+(?:an?\s+)?immutable\s+cold\s+archive)\b/i,
    context: 'Use `development-workflow:dw-file-governance` for workspace path boundaries, directory taxonomy, lightweight temporary directory leases (`TempLease1`), 6-gate lossless dehydration (`DehydratedBundle1`) and immutable cold archival (`ArchiveManifest1`). Preview with dry-run and verify manifests before destructive actions; managed background process lifecycles stay in `dw-collaboration`.',
  },
  {
    id: 'planning',
    skills: ['dw-planning'],
    pattern: /(?:制定|编写|给出|需要|请)?\s*(?:技术方案|实现方案|迁移方案|回退方案|操作指引|架构设计|implementation plan|migration plan|rollback plan|technical design)/i,
    context: 'Use `development-workflow:dw-planning`; include acceptance criteria and rollback boundaries before implementation.',
  },
  {
    id: 'optimization',
    skills: ['dw-optimization'],
    pattern: /(?:请|帮我|需要)?\s*(?:优化|重构|加速|降低内存|性能分析)|\b(?:benchmark|optimi[sz]e|refactor)\b|(?:^|\n)\s*(?:please\s+)?profile\b/i,
    context: 'Use `development-workflow:dw-optimization`; preserve a measured baseline and verify behavioral equivalence.',
  },
  {
    id: 'implementation',
    skills: ['dw-implementation'],
    pattern: /(?:请|帮我|需要)?\s*(?:实现这个|实现该|开始实现|按计划实现|write the implementation|implement this|build this feature)/i,
    context: 'Use `development-workflow:dw-implementation`; apply behavior-level TDD and the applicable quality gates.',
  },
  {
    id: 'wrapup',
    skills: ['dw-wrapup'],
    pattern: /(?:请|帮我|需要)?\s*(?:收尾|整理交付|准备提交|提交前检查|wrap up|prepare (?:the )?commit|finalize delivery)/i,
    context: 'Use `development-workflow:dw-wrapup`; do not commit, push, publish, or merge without explicit authorization.',
  },
  {
    id: 'handoff',
    skills: ['dw-handoff'],
    pattern: /(?:交接|接手|移交)(?:文档|记录|说明|材料|清单)|hand[\s-]?off\b/i,
    context: 'Use development-workflow:dw-handoff to re-examine the whole task and write a handoff with a TODO reconciliation; it does not authorize commits, pushes, or scope expansion.',
  },
];

function readPrompt(raw) {
  try {
    const payload = JSON.parse(raw);
    return typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
  } catch {
    return '';
  }
}

const DEFINITION_TERM = String.raw`(?:fix|debug|debugger|repair|diagnose|troubleshoot|review|plan|implement|implementation|implementation\s+plan|optimi[sz]e|optimization|refactor|debugging|\bbug\b|buggy|updates?|check(?:[\s-]?updates?)?|handoff|code\s+review|security\s+review|final\s+verification|technical\s+design|migration\s+plan|rollback\s+plan|performance\s+analysis|file\s+governance|lossless\s+dehydration|cold\s+archive|技术方案|实现方案|迁移方案|回退方案|操作指引|架构设计|修复|解决|排查|诊断|定位|调试|优化|重构|加速|降低内存|性能分析|代码审查|代码评审|安全审查|最终验证|回归验证|收尾|整理交付|交接|工作区文件治理|文件治理|无损脱水|冷归档|临时目录租约|临时区租约|脱水包)`;
const DEFINITION_TRAILING = String.raw`[\s!?！？。！,，:：]*`;

function hasExplicitRepairIntent(prompt) {
  const text = prompt.trim();
  return /^(?:请|帮我|需要|继续)?\s*(?:修复|解决|排查|诊断|定位|调试)(?!\s*(?:是什么|是什么意思|的含义|定义|definition|means\s+what))(?=$|[\s\S])/i.test(text)
    || /^(?:please|can you|could you|help me|i need to|need to)\s+(?:fix|debug|repair|diagnose|troubleshoot)\b/i.test(text)
    || /^(?:fix|debug|repair|diagnose|troubleshoot)\s+(?:this|that|the|my|our|an?|问题|报错|故障|bug|issue|problem)(?=$|[\s!?！？。！,，:：])/i.test(text)
    || /^(?:fix|debug|repair|diagnose|troubleshoot)\s+(?:fix|debug|repair|diagnose|troubleshoot)\b/i.test(text);
}

function isDefinitionQuestion(prompt) {
  const text = prompt.trim();
  if (hasExplicitRepairIntent(text)) return false;
  const term = DEFINITION_TERM;
  const trailing = DEFINITION_TRAILING;
  const patterns = [
    String.raw`(?:请\s*)?(?:解释|说明)(?:一下\s*)?(?:什么\s*是|什么叫)\s*${term}(?:吗)?${trailing}`,
    String.raw`(?:能(?:够)?\s*)?(?:解释|说明)(?:一下\s*)?什么\s*是\s*${term}(?:吗)?${trailing}`,
    String.raw`(?:请问\s*)?什么\s*是\s*${term}(?:吗)?${trailing}`,
    String.raw`(?:请问\s*)?什么叫\s*${term}(?:吗)?${trailing}`,
    String.raw`(?:请\s*)?(?:解释|说明)(?:一下\s*)?\s*${term}\s*(?:是什么|是什么意思|的含义|定义)${trailing}`,
    String.raw`(?:请问|请)?\s*${term}\s*(?:是什么|是什么意思|的含义|定义|definition|means\s+what)${trailing}`,
    String.raw`(?:(?:please|can\s+you|could\s+you)\s+)?(?:explain|describe)\s+(?:what\s+is\s+)?(?:(?:a|an|the)\s+)?${term}${trailing}`,
    String.raw`(?:what\s+is|what\s+does)\s+(?:(?:a|an|the)\s+)?${term}(?:\s+mean)?${trailing}`,
    String.raw`${term}\s+(?:definition|means\s+what|meaning)${trailing}`,
  ];
  return new RegExp(`^(?:${patterns.join('|')})$`, 'i').test(text);
}
const POLITENESS_PREFIX_RE = /^(?:(?:please|can\s+you|could\s+you|would\s+you|help\s+me)\s+|(?:请(?!问)|帮我)\s*)+/i;
const DISCOURSE_PREFIX_RE = /^(?:所以|因此|而且|并且|另外|同时|此外|否则|不然|要不然|那么|那(?=\s*(?:我们|咱们|我|你|您|大家|先|暂|不|别|无|切|没|既|如果|若|要是)))\s*/;
const LEAD_CONSEQUENT_RE = /^(?:就|则|便|那么)\s*/;
const LEAD_NEGATION_TOKEN_RE = /^(?:请(?!问)|麻烦|我们|咱们|我|你们|你|您|大家|双方|助手|AI|智能体|模型|这里|此处|这儿|(?:今天|现在|当前|目前|眼下|现阶段|本阶段|我们|咱们|我|你|您)(?:的)?|暂且|暂时|先|本来|原本|根本|压根|既|(?:这|本|此|该)(?:一)?(?:轮|次|步|阶段|回|任务|会话|对话|项目|分支|版本)(?:的|里|中)?|还|也|就|都|只)\s*/i;
const TRAIL_NEGATION_TOKEN_RE = /\s*(?:我们|咱们|我|你们|你|您|大家|(?:这|本|此|该)(?:一)?(?:轮|次|步|阶段|回|任务|会话)|暂且|暂时|目前|当前|今天|现在|眼下|现阶段|本阶段|这里|此处|先|还|也|就|都|只)+$/;
const CN_ACTION_VERB_SOURCE = '(?:写|做|修|改|查|看|跑|建|整理|生成|输出|提交|合并|发布|使用|调用|处理|推进|开展|启动|进行|执行|继续|修复|解决|排查|诊断|定位|调试|润色|改写|改进|优化|重构|加速|实现|搭建|构建|创建|修改|审查|评审|检查|验证|盘点|发现|选择|列出|查看|确认|汇报|报告|提供|复盘|总结|设计|规划|制定|编写|给出|分派|委派|派出|安排|管理|回收|停止|监管|补齐|接入|接通|收尾|接手|移交|交接|清理|治理|脱水|封存|签发|审计|核验|校验|分配|申请|管|(?<!启)动|碰|搭理|理会|弄|搞)';
const CN_NEGATION_RE = new RegExp(
  `(?:不要(?!忘)|(?<![识级类特个区判鉴甄性错派国版告道离分永诀惜阔])别(?![名称号样致字扭针墅离的处人忘])(?:\\s*(?:再|先|去|把|用|对|替|帮|乱|瞎))?\\s*(?:${CN_ACTION_VERB_SOURCE}|[a-z]{2,})|无需|无须|不需要|不必|不用|切?勿|暂不|并非|(?<!是)不是(?!不)|不想(?!不)|不打算|不准备|不考虑|不再|不能(?!不)|(?<!不[得能可会是])不(?!得不|能不|可不|会不|是不|仅|但|只|光|单|止)\\s*${CN_ACTION_VERB_SOURCE})`,
  'i'
);
const EN_NEGATION_RE = /^(?:please\s+)?(?:let'?s\s+not\b|no\s+need\s+(?:to|for)\b|(?:(?:we|you|i)\s+)?(?:should\s+not|shouldn't|must\s+not|need\s+not|would\s+rather\s+not)\b|(?:(?:we|you|i)\s+)?(?:do\s+not|don't|dont)\s+(?:need(?:\s+to)?|want\s+to)\b|(?:(?:we|you|i)\s+)?(?:do\s+not|don't|dont)\s+(?:write|create|generate|make|prepare|produce|do|run|use|call|invoke|fix|debug|repair|diagnose|troubleshoot|review|plan|implement|optimi[sz]e|refactor|build|manage|reclaim|supervise|report|summarize|check|dehydrate|seal|archive|clean|wrap\s+up)\b|do\s+not\b|don't\b|dont\b|without\b)/i;
const LEADING_REQUEST_VERB_RE = /^(?:修复|解决|排查|诊断|定位|调试|制定|编写|给出|设计|规划|整理|总结|复盘|改进|优化|重构|加速|实现|搭建|构建|创建|修改|审查|评审|检查|验证|盘点|发现|选择|列出|查看|确认|汇报|报告|提供|给我|润色|改写|简化|准备|分派|委派|派出|安排|使用|调用|启动|管理|回收|停止|监管|补齐|接入|接通|清理|治理|脱水|封存|签发|审计|核验|校验|分配|申请|写|生成|输出|\b(?:fix|debug|repair|diagnose|troubleshoot|write|create|give|implement|build|review|check|optimi[sz]e|refactor|report|explain|describe|translate|use|spawn|delegate|manage|reclaim|supervise|dehydrate|seal|archive|clean)\b)/i;
const BARE_DETERMINER_OBJECT_RE = /^(?:(?:一(?:个|份|套|版|项|条)|这(?:个|份|段|套|项|条)|那(?:个|份|段)|该|此)\s*)?$/;
const TOPIC_NOUN_PHRASE_RE = /^(?:实现方案|技术方案|迁移方案|回退方案|架构设计|整理交付|检查更新|代码审查|代码评审|安全审查|最终验证|回归验证|性能分析|进度汇报)$/;
const CONDITIONAL_PREFIX_RE = /^(?:如果|若|要是|假如|倘若|只要|除非|当|万一)\s*|^if\s+/i;
const CONSEQUENT_SPLIT_RE = /(?<![本来原本一直向来根本压根])(?:就|则|便|那么)|(?<!不)请(?!问)|\bthen\b/gi;
const ALTERNATIVE_SPLIT_RE = /而不是|而非(?![凡常])|\brather\s+than\b|\binstead\s+of\b/i;
const CONTRAST_SPLIT_RE = /\bbut\b|(?<![不非])但是?(?![愿凡])|(?<![通看忙打信说再好只熬躲瞒喘改绕逃比争斗])不过(?![来去])/gi;
const FAILURE_SYMPTOM_RE = /(?:\bbug\b|\bbuggy\b|报错|崩溃|异常|故障|挂了|failed|crashed|broke|root\s+cause|根因)/i;
const REPAIR_OR_META_VERB_RE = /(?:修|改|查|管|(?<!启)动|碰|看|处理|解决|排查|诊断|定位|调试|做|搞|弄|推进|进行|执行|继续|检查|审查|验证|搭理|理会)/;
const PRENOMINAL_PREDICATE_RE = /^(?!(?:管|关心|在意|理会|搭理))([^，,;；\n。的]{0,16}?)的\s*(\S{1,12}?\s*(?:报错|崩溃|异常|挂了|失败|(?:有|存在|出现|触发|发生|遇到)\s*(?:一个\s*|个\s*|些\s*)?(?:\bbug\b|问题|故障|异常|报错)|\bis\s+buggy\b|\bhas\s+(?:a\s+|an\s+)?bug\b|\bfailed\b|\bcrashed\b|\bbroke\b|(?:需要|请|得|要)\s*(?:修复|排查|解决|诊断|调试|优化|重构|检查|审查))(?!\s*的\S))/i;

function stripRepeatedPrefix(value, prefixRe) {
  let rest = value.trim();
  for (let index = 0; index < 8 && rest; index++) {
    const next = rest.replace(prefixRe, '').trim();
    if (next === rest) break;
    rest = next;
  }
  return rest;
}

function stripNegatedPrenominalModifier(clause) {
  const body = stripRepeatedPrefix(clause, DISCOURSE_PREFIX_RE).replace(POLITENESS_PREFIX_RE, '').trim();
  const cnMatch = CN_NEGATION_RE.exec(body);
  if (!cnMatch) return body;
  const prefix = body.slice(0, cnMatch.index).trim();
  const suffix = body.slice(cnMatch.index + cnMatch[0].length);
  if (LEADING_REQUEST_VERB_RE.test(prefix) && !TOPIC_NOUN_PHRASE_RE.test(prefix)) {
    const afterVerb = prefix.replace(LEADING_REQUEST_VERB_RE, '').trim();
    const relEnd = suffix.indexOf('的');
    if (BARE_DETERMINER_OBJECT_RE.test(afterVerb) && relEnd !== -1 && relEnd <= 20) {
      const headAfterDe = suffix.slice(relEnd + 1).trim();
      if (headAfterDe) return `${prefix} ${headAfterDe}`.trim();
    }
  }
  if (!/^(?:不要|别|切?勿)/.test(cnMatch[0]) && prefix.length <= 12 && !/[：:]/.test(prefix) && !LEADING_REQUEST_VERB_RE.test(prefix)) {
    const predMatch = PRENOMINAL_PREDICATE_RE.exec(suffix);
    if (predMatch) return `${prefix} ${predMatch[2]}`.trim();
  }
  return body;
}

function isNegatedClause(text) {
  const body = stripNegatedPrenominalModifier(text);
  if (!body) return false;
  if (EN_NEGATION_RE.test(body)) return true;
  const cnMatch = CN_NEGATION_RE.exec(body);
  if (!cnMatch) return false;
  const prefix = body.slice(0, cnMatch.index).trim();
  const suffix = body.slice(cnMatch.index + cnMatch[0].length);
  if (CONDITIONAL_PREFIX_RE.test(prefix)) return false;
  if (/^不(?!要|想|需|必|用|再|打算|准备|考虑|能|是)/.test(cnMatch[0])
    && !REPAIR_OR_META_VERB_RE.test(cnMatch[0])
    && FAILURE_SYMPTOM_RE.test(suffix)) {
    return false;
  }
  const remainingPrefix = stripRepeatedPrefix(prefix, LEAD_NEGATION_TOKEN_RE);
  const topic = remainingPrefix.replace(TRAIL_NEGATION_TOKEN_RE, '').trim();
  const hadTrailingToken = topic.length !== remainingPrefix.length;
  if (topic === '') return true;
  if (topic.length > 24 || /[：:]/.test(topic) || CONDITIONAL_PREFIX_RE.test(topic)) return false;
  if (FAILURE_SYMPTOM_RE.test(topic) && !REPAIR_OR_META_VERB_RE.test(cnMatch[0] + suffix) && suffix.trim() !== '' && suffix.trim() !== '了') {
    return false;
  }
  if (LEADING_REQUEST_VERB_RE.test(topic) && !TOPIC_NOUN_PHRASE_RE.test(topic)) {
    const afterVerb = topic.replace(LEADING_REQUEST_VERB_RE, '').trim();
    const proVerbSuffix = /^(?:做|写|跑|搞|弄|处理|推进|进行|执行|启动|管|动)?\s*了?[。！？!?]*$/.test(suffix.trim());
    if (afterVerb && !BARE_DETERMINER_OBJECT_RE.test(afterVerb) && (!hadTrailingToken || !proVerbSuffix)) return false;
  }
  return true;
}

function splitConditionalClause(clause) {
  const clean = stripRepeatedPrefix(clause, DISCOURSE_PREFIX_RE).replace(POLITENESS_PREFIX_RE, '').trim();
  const condMatch = CONDITIONAL_PREFIX_RE.exec(clean);
  if (!condMatch) return [clause];
  const afterCond = clean.slice(condMatch[0].length).trim();
  if (!afterCond) return [];
  for (const match of afterCond.matchAll(CONSEQUENT_SPLIT_RE)) {
    const antecedent = afterCond.slice(0, match.index).trim();
    const consequent = afterCond.slice(match.index + match[0].length).trim();
    if (!antecedent || !consequent) continue;
    if (isNegatedClause(antecedent)) return [consequent];
    return [antecedent, consequent];
  }
  if (isNegatedClause(afterCond)) return [];
  return [clause];
}

function splitAlternativeClause(clause) {
  const trimmed = clause.trim();
  if (!trimmed) return [];
  const altMatch = ALTERNATIVE_SPLIT_RE.exec(trimmed);
  if (!altMatch) return [trimmed];
  const left = stripRepeatedPrefix(trimmed.slice(0, altMatch.index), DISCOURSE_PREFIX_RE).trim();
  return left ? [left] : [];
}

function splitContrastClause(clause, depth = 0) {
  const trimmed = clause.trim();
  if (!trimmed || depth >= 3) return trimmed ? [trimmed] : [];
  for (const match of trimmed.matchAll(CONTRAST_SPLIT_RE)) {
    const left = trimmed.slice(0, match.index).trim();
    const right = trimmed.slice(match.index + match[0].length).trim();
    const cleanLeft = left.replace(POLITENESS_PREFIX_RE, '').trim();
    const cleanRight = right.replace(POLITENESS_PREFIX_RE, '').trim();
    if (cleanLeft && isNegatedClause(cleanLeft)) return right ? splitContrastClause(right, depth + 1) : [];
    if (cleanRight && (isNegatedClause(cleanRight) || /^(?:not\b|不(?!得不|能不|可不|会不|是不))/i.test(cleanRight))) return left ? splitContrastClause(left, depth + 1) : [];
  }
  const clean = trimmed.replace(POLITENESS_PREFIX_RE, '').trim();
  const negMatch = CN_NEGATION_RE.exec(clean);
  if (negMatch && negMatch.index > 0) {
    const left = clean.slice(0, negMatch.index).trim();
    const right = clean.slice(negMatch.index).trim();
    if (LEADING_REQUEST_VERB_RE.test(left) && !TOPIC_NOUN_PHRASE_RE.test(left)) {
      const afterVerb = left.replace(LEADING_REQUEST_VERB_RE, '').trim();
      const afterNeg = right.slice(negMatch[0].length).trim();
      const proVerbSuffix = /^(?:做|写|跑|搞|弄|处理|推进|进行|执行|启动|管|动)?\s*了?[。！？!?]*$/.test(afterNeg);
      if (afterVerb && !BARE_DETERMINER_OBJECT_RE.test(afterVerb) && !TRAIL_NEGATION_TOKEN_RE.test(left) && !proVerbSuffix) {
        return [left];
      }
    }
  }
  return [trimmed];
}

function actionableText(prompt) {
  const unquoted = prompt.replace(/^\s*>[^\n]*$/gm, '').replace(/```[\s\S]*?```|`[^`]*`|"[^"\n]*"|“[^”]*”|‘[^’]*’|(?<!\w)'[^'\n]*'(?!\w)/g, quoted => {
    // Inline code commonly marks the skill name in an actual invocation. Keep
    // only a known identifier; quoted commands and fenced examples remain inert.
    if (!quoted.startsWith('`') || quoted.startsWith('```')) return ' ';
    const identifier = quoted.slice(1, -1).trim();
    const name = identifier.replace(/^(?:\$|development-workflow:)/i, '');
    return SKILL_IDS.includes(name) ? identifier : ' ';
  });
  // Normalize request politeness before distinguishing explanations from
  // invocations. The same prefix must not change either intent's meaning.
  return unquoted.split(/[，,;；\n。!！?？]|\bthen\b|然后|而是(?!不)/i)
    .flatMap(clause => splitConditionalClause(clause))
    .flatMap(clause => splitAlternativeClause(clause))
    .flatMap(clause => splitContrastClause(clause))
    .map(clause => stripNegatedPrenominalModifier(clause.trim().replace(POLITENESS_PREFIX_RE, '').replace(LEAD_CONSEQUENT_RE, '')))
    .filter(clause => {
      const text = clause.trim();
      if (!text || isNegatedClause(text)) return false;
      if (isDefinitionQuestion(text)) return false;
      if (!hasExplicitRepairIntent(text) && /^(?:请\s*|please\s+)?(?:(?:先|暂时|只)\s*)*(?:解释|说明|翻译|描述|理解|介绍|explain\b|describe\b|translate\b|what\s+(?:is|does)\b|下面是待翻译)/i.test(text)) return false;
      if (!hasExplicitRepairIntent(text) && /(?:是什么意思|的含义|什么区别|means\s+what|definition)\s*[?？]?$/i.test(text)) return false;
      return true;
    }).join('\n');
}

function explicitSkills(text, interactionText = text) {
  return SKILL_REGISTRY.filter(({ name }) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:\\$|\\bdevelopment-workflow:)${escaped}(?![\\w-])|^(?:(?:请)?(?:使用|调用)\\s*|use\\s+)?${escaped}(?=$|\\s)`, 'im')
      .test(name === 'dw-interaction' ? interactionText : text);
  }).map(({ name }) => name);
}

// The new interaction entry must not treat a literal example's skill name as
// an invocation. Keep this conservative payload handling local to that entry.
function interactionExplicitText(prompt) {
  const lines = prompt.split(/\r?\n/);
  const kept = [];
  const fenceStart = line => /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line || '');
  const literalIntro = /^(?:(?:(?:please|can\s+you|could\s+you|would\s+you|help\s+me)\s+)*translate\b.*|(?:do\s+not|don't)\s+execute\b.*|(?:quoted\s+)?example|(?:(?:请|帮我)\s*)*(?:只)?翻译.*|(?:以下|下面)(?:仅为|是)?(?:示例|引用).*)[:：]\s*$/i;
  let fence = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (fence) {
      const closing = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (closing && closing[1][0] === fence[0] && closing[1].length >= fence.length) fence = null;
      continue;
    }
    const opening = fenceStart(line);
    if (opening) { fence = opening[1]; continue; }
    if (literalIntro.test(line.trim())) {
      let next = index + 1;
      while (next < lines.length && !lines[next].trim()) next++;
      const quotedBlock = fenceStart(lines[next]);
      // An unfenced literal tail has no reliable end marker. Resuming on a
      // command-looking line would also route text submitted for translation.
      if (!quotedBlock) break;
      fence = quotedBlock[1];
      index = next;
      continue;
    }
    kept.push(line);
  }
  return actionableText(kept.join('\n'));
}

function routePrompt(prompt) {
  if (typeof prompt !== 'string' || !prompt || prompt.length > 20000) return null;
  const normalized = actionableText(prompt);
  const requested = explicitSkills(normalized,
    /dw-interaction/i.test(prompt) ? interactionExplicitText(prompt) : '');
  if (requested.length) return { id: 'explicit', skills: requested, context: `Use the explicitly requested skill${requested.length > 1 ? 's' : ''}: ${requested.map(name => `\`development-workflow:${name}\``).join(', ')}. Preserve the user's requested scope.` };
  if (!normalized) return null;
  for (const route of ROUTES) {
    // Interaction discovery deliberately accepts only a standalone request.
    // A matching line inside a quoted example or a mixed artifact task is not
    // enough; those tasks can still name the skill explicitly.
    const text = route.id === 'interaction' ? prompt.trim() : normalized;
    if (route.pattern.test(text)) return route;
  }
  return null;
}

function main() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch {
    return;
  }
  const route = routePrompt(readPrompt(raw));
  if (!route) return;
  outputHook('UserPromptSubmit', `<dw-route id="${route.id}">\n${route.context}\n</dw-route>`);
}

if (require.main === module) main();

module.exports = { ROUTES, SKILL_IDS, SKILL_REGISTRY, actionableText, explicitSkills, isNegatedClause, readPrompt, routePrompt };
