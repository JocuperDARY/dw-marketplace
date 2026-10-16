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
  ['dw-collaboration', 'collaboration'], ['dw-reference', null],
].map(([name, route]) => Object.freeze({ name, route, manualOnly: route === null })));
const SKILL_IDS = Object.freeze(SKILL_REGISTRY.map(skill => skill.name));

const ROUTES = [
  {
    id: 'writing', skills: ['dw-writing'],
    pattern: /(?:请|帮我|需要)?\s*(?:润色|改写|改进表述|简化说明|说人话|任务命名)|\b(?:rewrite|polish)\s+(?:this|the|my|our)\s+(?:text|explanation|summary|report)\b/i,
    context: 'Use `development-workflow:dw-writing` to make the wording clear while preserving facts, evidence, and the requested scope.',
  },
  {
    id: 'collaboration', skills: ['dw-collaboration'],
    pattern: /(?:请|帮我|需要)?\s*(?:分派|委派|派出|安排|使用|启动)\s*(?:(?:\d+|[一二两三四五多几])\s*个?\s*)?(?:子\s*agents?|agents?|子代理|多智能体)|\b(?:delegate|assign|spawn)\s+(?:(?:\w+)\s+){0,3}(?:agents?|subagents?)\b/i,
    context: 'Use `development-workflow:dw-collaboration` for the authorized delegation; use the host tools for ordinary assignments and enable persistent resource management only when needed.',
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

const DEFINITION_TERM = String.raw`(?:fix|debug|debugger|repair|diagnose|troubleshoot|review|plan|implement|implementation|implementation\s+plan|optimi[sz]e|optimization|refactor|debugging|\bbug\b|buggy|updates?|check(?:[\s-]?updates?)?|handoff|code\s+review|security\s+review|final\s+verification|technical\s+design|migration\s+plan|rollback\s+plan|performance\s+analysis|技术方案|实现方案|迁移方案|回退方案|操作指引|架构设计|修复|解决|排查|诊断|定位|调试|优化|重构|加速|降低内存|性能分析|代码审查|代码评审|安全审查|最终验证|回归验证|收尾|整理交付|交接)`;
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
function actionableText(prompt) {
  const unquoted = prompt.replace(/```[\s\S]*?```|`[^`]*`|"[^"\n]*"|“[^”]*”|‘[^’]*’|(?<!\w)'[^'\n]*'(?!\w)/g, quoted => {
    // Inline code commonly marks the skill name in an actual invocation. Keep
    // only a known identifier; quoted commands and fenced examples remain inert.
    if (!quoted.startsWith('`') || quoted.startsWith('```')) return ' ';
    const identifier = quoted.slice(1, -1).trim();
    const name = identifier.replace(/^(?:\$|development-workflow:)/i, '');
    return SKILL_IDS.includes(name) ? identifier : ' ';
  });
  // Normalize request politeness before distinguishing explanations from
  // invocations. The same prefix must not change either intent's meaning.
  return unquoted.split(/[，,;；\n。]|\bthen\b|然后/i)
    .map(clause => clause.trim().replace(/^(?:(?:please|can\s+you|could\s+you|would\s+you|help\s+me)\s+|(?:请(?!问)|帮我)\s*)+/i, ''))
    .filter(clause => {
      const text = clause.trim();
      if (!text || /^(?:请\s*|please\s+)?(?:先|暂时|现在|这次|本次)?\s*(?:不要|别|无需|不需要|do\s+not\b|don't\b|dont\b|without\b)/i.test(text)) return false;
      if (isDefinitionQuestion(text)) return false;
      if (!hasExplicitRepairIntent(text) && /^(?:请\s*|please\s+)?(?:只?解释|说明|翻译|描述|理解|介绍|explain\b|describe\b|translate\b|what\s+(?:is|does)\b|下面是待翻译)/i.test(text)) return false;
      if (!hasExplicitRepairIntent(text) && /(?:是什么意思|的含义|什么区别|means\s+what|definition)\s*[?？]?$/i.test(text)) return false;
      return true;
    }).join('\n');
}

function explicitSkills(text) {
  return SKILL_REGISTRY.filter(({ name }) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:\\$|\\bdevelopment-workflow:)${escaped}(?![\\w-])|^(?:(?:请)?(?:使用|调用)\\s*|use\\s+)?${escaped}(?=$|\\s)`, 'im').test(text);
  }).map(({ name }) => name);
}

function routePrompt(prompt) {
  if (typeof prompt !== 'string' || !prompt || prompt.length > 20000) return null;
  const normalized = actionableText(prompt);
  const requested = explicitSkills(normalized);
  if (requested.length) return { id: 'explicit', skills: requested, context: `Use the explicitly requested skill${requested.length > 1 ? 's' : ''}: ${requested.map(name => `\`development-workflow:${name}\``).join(', ')}. Preserve the user's requested scope.` };
  for (const route of ROUTES) {
    if (route.pattern.test(normalized)) return route;
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

module.exports = { ROUTES, SKILL_IDS, SKILL_REGISTRY, actionableText, explicitSkills, readPrompt, routePrompt };
