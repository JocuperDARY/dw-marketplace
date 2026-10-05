#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { outputHook } = require('./task-utils.js');

const ROUTES = [
  {
    id: 'check-updates',
    pattern: /(?:检查|查看|确认)\s*(?:一下\s*)?(?:(?:全局|环境|组件|工具)\s*){0,3}(?:更新|版本)|(?:check|show)\s+(?:for\s+)?updates?|updates?\s+available/i,
    context: 'Use `development-workflow:check-updates` for a read-only environment update audit.',
  },
  {
    id: 'repair',
    pattern: /(?:请|帮我|需要|继续)?\s*(?:修复|解决|排查|诊断|定位)|(?:please\s+)?(?:debug(?:ging|ger)?|fix|repair|diagnose|troubleshoot)\b|(?:\bbug\b|buggy\b|报错|崩溃|异常|root cause|根因)/i,
    context: 'Use `development-workflow:dw-diagnosis` to establish evidence and root cause, then `development-workflow:dw-debugging` for the fix, followed by `development-workflow:dw-verification`.',
  },
  {
    id: 'planning',
    pattern: /(?:制定|编写|给出|需要|请)?\s*(?:技术方案|实现方案|迁移方案|回退方案|操作指引|架构设计|implementation plan|migration plan|rollback plan|technical design)/i,
    context: 'Use `development-workflow:dw-planning`; include acceptance criteria and rollback boundaries before implementation.',
  },
  {
    id: 'optimization',
    pattern: /(?:请|帮我|需要)?\s*(?:优化|重构|加速|降低内存|性能分析)|(?:profile|benchmark|optimi[sz]e|refactor)\b/i,
    context: 'Use `development-workflow:dw-optimization`; preserve a measured baseline and verify behavioral equivalence.',
  },
  {
    id: 'verification',
    pattern: /(?:请|帮我|需要)?\s*(?:代码审查|代码评审|安全审查|最终验证|回归验证|release verification|code review|security review|final verification)/i,
    context: 'Use `development-workflow:dw-verification`; report correctness, consistency, and completeness with current evidence.',
  },
  {
    id: 'implementation',
    pattern: /(?:请|帮我|需要)?\s*(?:实现这个|实现该|开始实现|按计划实现|write the implementation|implement this|build this feature)/i,
    context: 'Use `development-workflow:dw-implementation`; apply behavior-level TDD and the applicable quality gates.',
  },
  {
    id: 'wrapup',
    pattern: /(?:请|帮我|需要)?\s*(?:收尾|整理交付|准备提交|提交前检查|wrap up|prepare (?:the )?commit|finalize delivery)/i,
    context: 'Use `development-workflow:dw-wrapup`; do not commit, push, publish, or merge without explicit authorization.',
  },
  {
    id: 'handoff',
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

function hasRepairActionAnywhere(prompt) {
  const text = prompt.trim();
  const unquoted = text.replace(/["'“‘`][^"'”’`]*["'”’`]/g, ' ');
  return /(?:修复|解决|排查|诊断|定位|调试)/.test(unquoted)
    || /\b(?:fix|debug|repair|diagnose|troubleshoot)\b/i.test(unquoted);
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
function routePrompt(prompt) {
  if (!prompt || prompt.length > 20000) return null;
  if (!hasRepairActionAnywhere(prompt) && /(?:["'“‘`](?:fix|debug|repair|review|plan|implement|optimi[sz]e)["'”’`]|\b(?:fix|debug|review|plan|implement|optimi[sz]e)\b)\s*(?:是什么意思|的含义|means what|definition)/i.test(prompt)) return null;
  if (isDefinitionQuestion(prompt)) return null;
  if (/(?:(?:hand[\s-]?off\b|(?:交接|接手|移交)(?:文档|记录|说明|材料|清单))\s*(?:是什么意思|的含义|means what|definition)|what\s+does\s+(?:a\s+)?hand[\s-]?off\s+mean)/i.test(prompt)) return null;
  const normalized = prompt
    .replace(/(?:不要|别|无需|不需要)\s*(?:直接\s*)?(?:修复|解决|排查|诊断|定位|优化|重构|实现|审查|验证|提交)/g, '')
    .replace(/(?:不要|别|无需|不需要)\s*(?:直接\s*)?(?:写|生成|创建|整理|准备|输出)\s*(?:一份|一个)?\s*(?:交接|接手|移交)(?:文档|记录|说明|材料|清单)/g, '')
    .replace(/(?:do\s+not|don't|dont|without)\s+(?:write|generate|create|organize|prepare|output)\s+(?:(?:a|an)\s+)?hand[\s-]?off(?:\s+(?:note|document|record|summary|materials?|checklist))?\b/gi, '')
    .replace(/(?:do\s+not|don't|dont|without)\s+(?:fix|debug|repair|diagnose|optimi[sz]e|refactor|implement|review|verify|commit)\b/gi, '');
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

module.exports = { ROUTES, readPrompt, routePrompt };
