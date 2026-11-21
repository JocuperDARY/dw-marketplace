'use strict';

const STATUS_META = Object.freeze({
  completed: Object.freeze({ symbol: '✓', label: '已完成', badge: '[✓ 已完成]' }),
  in_progress: Object.freeze({ symbol: '▶', label: '进行中', badge: '[▶ 进行中]' }),
  pending: Object.freeze({ symbol: '○', label: '未完成', badge: '[○ 未完成]' }),
  impossible: Object.freeze({ symbol: '⊘', label: '无法完成', badge: '[⊘ 无法完成]' }),
  error: Object.freeze({ symbol: '✗', label: '出错', badge: '[✗ 出错]' }),
  empty: Object.freeze({ symbol: '◌', label: '空阶段', badge: '[◌ 空阶段]' }),
});

const ANSI_CODES = Object.freeze({
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  completed: '\x1b[32m',
  in_progress: '\x1b[36;1m',
  pending: '\x1b[37m',
  impossible: '\x1b[35m',
  error: '\x1b[31;1m',
  empty: '\x1b[90m',
  warn: '\x1b[33;1m',
  header: '\x1b[1;34m',
});

function getStatusMeta(status) {
  if (Object.prototype.hasOwnProperty.call(STATUS_META, status)) {
    return STATUS_META[status];
  }
  const safe = String(status || 'pending');
  return { symbol: '?', label: safe, badge: `[? ${safe}]` };
}

function escapeHtml(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeJsonForScript(value) {
  const json = JSON.stringify(value === undefined ? null : value);
  return json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function derivePhaseStatusFallback(phase) {
  const tasks = Array.isArray(phase && phase.tasks) ? phase.tasks : [];
  if (tasks.length === 0) return 'empty';
  let completed = 0;
  let pending = 0;
  let inProgress = 0;
  let impossible = 0;
  let error = 0;
  for (const task of tasks) {
    if (task.status === 'completed') completed += 1;
    else if (task.status === 'in_progress') inProgress += 1;
    else if (task.status === 'impossible') impossible += 1;
    else if (task.status === 'error') error += 1;
    else pending += 1;
  }
  if (completed === tasks.length) return 'completed';
  if (error > 0) return 'error';
  if (impossible > 0) return 'impossible';
  if (inProgress > 0 || (completed > 0 && pending > 0)) return 'in_progress';
  return 'pending';
}

function normalizeSummary(plan, summary) {
  const safePlan = plan && typeof plan === 'object' ? plan : {};
  const phases = Array.isArray(safePlan.phases) ? safePlan.phases : [];
  if (summary && typeof summary === 'object' && summary.counts) {
    const c = summary.counts;
    const totalTasks = Number(c.totalTasks || 0);
    const completed = Number(c.completed || 0);
    const pending = Number(c.pending || 0);
    const inProgress = Number(c.inProgress || 0);
    const unfinished = c.unfinished !== undefined ? Number(c.unfinished) : pending + inProgress;
    const impossible = Number(c.impossible || 0);
    const error = Number(c.error || 0);
    const archived = Number(c.archived !== undefined ? c.archived : (Array.isArray(safePlan.archived) ? safePlan.archived.length : 0));
    const phaseCount = Number(c.phases !== undefined ? c.phases : phases.length);
    const emptyPhasesCount = Number(c.emptyPhases || 0);
    const pct = totalTasks > 0 ? Math.round((completed / totalTasks) * 100) : 0;
    return {
      planId: summary.planId || safePlan.planId || '',
      title: summary.title || safePlan.title || '',
      goal: summary.goal !== undefined ? summary.goal : (safePlan.goal || ''),
      revision: summary.revision !== undefined ? summary.revision : (safePlan.revision || 0),
      updatedAt: summary.updatedAt || safePlan.updatedAt || '',
      counts: {
        phases: phaseCount,
        emptyPhases: emptyPhasesCount,
        totalTasks,
        completed,
        unfinished,
        pending,
        inProgress,
        impossible,
        error,
        archived,
        completionRate: pct,
      },
      isComplete: Boolean(summary.isComplete),
      completeGateCode: summary.completeGateCode || null,
      inProgressTasks: Array.isArray(summary.inProgressTasks) ? summary.inProgressTasks : [],
      readyTasks: Array.isArray(summary.readyTasks) ? summary.readyTasks : [],
      upstreamBlocked: Array.isArray(summary.upstreamBlocked) ? summary.upstreamBlocked : [],
      issues: Array.isArray(summary.issues) ? summary.issues : [],
      emptyPhases: Array.isArray(summary.emptyPhases) ? summary.emptyPhases : [],
      dependencyWarnings: Array.isArray(summary.dependencyWarnings) ? summary.dependencyWarnings : [],
      phases: Array.isArray(summary.phases) ? summary.phases : [],
    };
  }

  let totalTasks = 0;
  let completed = 0;
  let pending = 0;
  let inProgress = 0;
  let impossible = 0;
  let error = 0;
  let emptyPhasesCount = 0;
  const inProgressTasks = [];
  const issues = [];
  const emptyPhases = [];
  const phaseSummaries = [];

  for (const phase of phases) {
    const tasks = Array.isArray(phase.tasks) ? phase.tasks : [];
    const status = phase.status || derivePhaseStatusFallback(phase);
    let pDone = 0;
    if (tasks.length === 0) {
      emptyPhasesCount += 1;
      emptyPhases.push(phase.id);
    }
    for (const task of tasks) {
      totalTasks += 1;
      if (task.status === 'completed') {
        completed += 1;
        pDone += 1;
      } else if (task.status === 'in_progress') {
        inProgress += 1;
        inProgressTasks.push({ id: task.id, phaseId: phase.id, title: task.title, owner: task.owner || null });
      } else if (task.status === 'impossible') {
        impossible += 1;
        issues.push({ id: task.id, phaseId: phase.id, status: task.status, title: task.title, statusReason: task.statusReason || null });
      } else if (task.status === 'error') {
        error += 1;
        issues.push({ id: task.id, phaseId: phase.id, status: task.status, title: task.title, statusReason: task.statusReason || null });
      } else {
        pending += 1;
      }
    }
    phaseSummaries.push({
      id: phase.id,
      title: phase.title,
      status,
      totalTasks: tasks.length,
      completed: pDone,
    });
  }

  const archived = Array.isArray(safePlan.archived) ? safePlan.archived.length : 0;
  const pct = totalTasks > 0 ? Math.round((completed / totalTasks) * 100) : 0;
  const isComplete = totalTasks >= 1 && emptyPhasesCount === 0 && completed === totalTasks;
  return {
    planId: safePlan.planId || '',
    title: safePlan.title || '',
    goal: safePlan.goal || '',
    revision: safePlan.revision || 0,
    updatedAt: safePlan.updatedAt || '',
    counts: {
      phases: phases.length,
      emptyPhases: emptyPhasesCount,
      totalTasks,
      completed,
      unfinished: pending + inProgress,
      pending,
      inProgress,
      impossible,
      error,
      archived,
      completionRate: pct,
    },
    isComplete,
    completeGateCode: totalTasks === 0 || emptyPhasesCount > 0 ? 'PLAN_EMPTY' : (isComplete ? 'PLAN_COMPLETE' : 'PLAN_INCOMPLETE'),
    inProgressTasks,
    readyTasks: [],
    upstreamBlocked: [],
    issues,
    emptyPhases,
    dependencyWarnings: [],
    phases: phaseSummaries,
  };
}

function buildBlockedMap(summary) {
  const map = new Map();
  for (const item of summary.upstreamBlocked || []) {
    if (item && item.id) {
      map.set(item.id, Array.isArray(item.blockedBy) ? item.blockedBy : []);
    }
  }
  return map;
}

function formatBlockedBy(blockedBy) {
  if (!Array.isArray(blockedBy) || blockedBy.length === 0) return '';
  return blockedBy
    .map((b) => {
      const meta = getStatusMeta(b.status);
      const kindPrefix = b.kind === 'phase' ? '阶段 ' : '';
      const reasonPart = b.statusReason ? `: ${b.statusReason}` : '';
      return `${kindPrefix}${b.id}(${meta.label}${reasonPart})`;
    })
    .join('; ');
}

function buildProgressBar(pct, width = 20) {
  const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
  const filled = Math.round((clamped / 100) * width);
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}]`;
}

function formatHistoryLine(entry) {
  if (!entry || typeof entry !== 'object') {
    return String(entry || '');
  }
  const time = entry.at || entry.timestamp || entry.createdAt || '';
  const action = entry.action || entry.type || entry.event || 'change';
  const target = entry.targetId || entry.taskId || entry.phaseId || '';
  const actor = entry.actor ? ` by ${entry.actor}` : '';
  const rev = entry.revision !== undefined && entry.revision !== null ? ` #${entry.revision}` : '';
  const detailParts = [];
  const fromStatus = entry.prevStatus ?? entry.fromStatus;
  const toStatus = entry.nextStatus ?? entry.toStatus;
  if (fromStatus && toStatus) {
    detailParts.push(`${fromStatus} -> ${toStatus}`);
  }
  if (entry.reason) detailParts.push(`原因: ${entry.reason}`);
  const prevReason = entry.previousStatusReason ?? entry.previousReason;
  if (prevReason) detailParts.push(`原原因: ${prevReason}`);
  if (entry.note) detailParts.push(`备注: ${entry.note}`);
  const summaryText = entry.summary ?? entry.message;
  if (summaryText) detailParts.push(summaryText);
  const head = [time, `${action}${rev}`, target, actor.trim()].filter(Boolean).join(' ');
  return detailParts.length > 0 ? `${head} — ${detailParts.join(' | ')}` : head;
}

function formatArchivedLine(entry) {
  if (!entry || typeof entry !== 'object') {
    return String(entry || '');
  }
  const kind = entry.kind || (entry.tasks ? 'phase' : 'task');
  const id = entry.id || (entry.item && entry.item.id) || '(unknown)';
  const title = entry.title || (entry.item && entry.item.title) || '';
  const action = entry.action || 'archived';
  const at = entry.archivedAt || entry.at || '';
  const reason = entry.reason ? ` 原因: ${entry.reason}` : '';
  const split = Array.isArray(entry.splitInto) && entry.splitInto.length > 0
    ? ` -> [${entry.splitInto.join(', ')}]`
    : '';
  return `[${kind}] ${id}${title ? ` ${title}` : ''} (${action}${at ? `, ${at}` : ''})${split}${reason}`;
}

function shouldDisableColor(options) {
  if (options && options.noColor) return true;
  if (process.env && process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return true;
  return false;
}

function renderTerminal(plan, summary, options = {}) {
  const safePlan = plan && typeof plan === 'object' ? plan : {};
  const sum = normalizeSummary(safePlan, summary);
  const counts = sum.counts;
  const noColor = shouldDisableColor(options);
  const maxHistory = typeof options.maxHistory === 'number' && options.maxHistory >= 0 ? options.maxHistory : 8;
  const paint = (colorKey, text) => (noColor || !ANSI_CODES[colorKey] ? text : `${ANSI_CODES[colorKey]}${text}${ANSI_CODES.reset}`);
  const blockedMap = buildBlockedMap(sum);

  const lines = [];
  lines.push(paint('header', `=== ${safePlan.title || sum.title || '未命名计划'} ===`));
  lines.push(`Plan ID: ${safePlan.planId || sum.planId} | Revision: #${safePlan.revision ?? sum.revision} | Updated: ${safePlan.updatedAt || sum.updatedAt || '-'}`);
  if (safePlan.goal) {
    lines.push(`目标: ${safePlan.goal}`);
  }
  lines.push(`进度: ${buildProgressBar(counts.completionRate)} ${counts.completionRate}% (${counts.completed}/${counts.totalTasks})`);
  lines.push(
    `统计: 已完成 ${counts.completed} | 未完成 ${counts.unfinished} (进行中 ${counts.inProgress}, 待办 ${counts.pending}) | 无法完成 ${counts.impossible} | 出错 ${counts.error} | 已归档 ${counts.archived} | 阶段 ${counts.phases}`
  );

  if (sum.dependencyWarnings.length > 0) {
    lines.push('');
    lines.push(paint('warn', `[! 依赖告警 (${sum.dependencyWarnings.length})]`));
    for (const warn of sum.dependencyWarnings) {
      const msg = warn.message || `${warn.phaseId} 依赖的 ${warn.upstreamPhaseId} 当前状态为 ${warn.upstreamStatus}`;
      lines.push(paint('warn', `  - [${warn.code || 'DEPENDENCY_WARNING'}] ${msg}`));
    }
  }

  const phases = Array.isArray(safePlan.phases) ? safePlan.phases : [];
  for (const phase of phases) {
    const phaseStatus = phase.status || derivePhaseStatusFallback(phase);
    const phaseMeta = getStatusMeta(phaseStatus);
    const phaseDeps = Array.isArray(phase.dependsOn) && phase.dependsOn.length > 0
      ? ` (依赖阶段: ${phase.dependsOn.join(', ')})`
      : '';
    lines.push('');
    lines.push(`${paint(phaseStatus, phaseMeta.badge)} ${paint('bold', `${phase.id}: ${phase.title}`)}${phaseDeps}`);
    if (phase.goal) {
      lines.push(`  目标: ${phase.goal}`);
    }
    const tasks = Array.isArray(phase.tasks) ? phase.tasks : [];
    if (tasks.length === 0) {
      lines.push(paint('dim', '  (空阶段，暂无任务)'));
      continue;
    }
    for (const task of tasks) {
      const taskMeta = getStatusMeta(task.status);
      const marker = task.status === 'in_progress' ? '>>' : '  ';
      const tags = [];
      if (task.owner) tags.push(`@${task.owner}`);
      if (task.origin && task.origin !== 'initial') tags.push(task.origin);
      if (Array.isArray(task.dependsOn) && task.dependsOn.length > 0) {
        tags.push(`依赖: ${task.dependsOn.join(', ')}`);
      }
      const tagSuffix = tags.length > 0 ? ` [${tags.join(' | ')}]` : '';
      const taskLine = `${marker} ${paint(task.status, taskMeta.badge)} ${task.id} ${task.title}${tagSuffix}`;
      lines.push(task.status === 'in_progress' ? paint('bold', taskLine) : taskLine);

      if (task.statusReason) {
        lines.push(`     原因: ${task.statusReason}`);
      }
      if (task.note) {
        lines.push(`     备注: ${task.note}`);
      }
      const blockers = blockedMap.get(task.id);
      if (blockers && blockers.length > 0) {
        lines.push(paint('warn', `     受阻于: ${formatBlockedBy(blockers)}`));
      }
      if (Array.isArray(task.evidence) && task.evidence.length > 0) {
        lines.push(`     证据: ${task.evidence.join(' ; ')}`);
      }
    }
  }

  const history = Array.isArray(safePlan.history) ? safePlan.history : [];
  if (maxHistory > 0 && history.length > 0) {
    const shown = history.slice(-maxHistory);
    const trunc = safePlan.truncatedHistoryCount ? `，已截断 ${safePlan.truncatedHistoryCount} 条` : '';
    lines.push('');
    lines.push(`最近变更 (${shown.length}/${history.length}${trunc}):`);
    for (const entry of shown) {
      lines.push(`  - ${formatHistoryLine(entry)}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function renderBrief(plan, summary) {
  const safePlan = plan && typeof plan === 'object' ? plan : {};
  const sum = normalizeSummary(safePlan, summary);
  const counts = sum.counts;
  const phases = Array.isArray(safePlan.phases) ? safePlan.phases : [];

  const inProgressItems = [];
  const issueItems = [];
  for (const phase of phases) {
    for (const task of Array.isArray(phase.tasks) ? phase.tasks : []) {
      if (task.status === 'in_progress') {
        inProgressItems.push(`${task.id} ${task.title}${task.owner ? ` (@${task.owner})` : ''}`);
      } else if (task.status === 'error' || task.status === 'impossible') {
        const meta = getStatusMeta(task.status);
        issueItems.push(`${meta.badge} ${task.id}${task.statusReason ? `(${task.statusReason})` : ''}`);
      }
    }
  }

  for (const blocked of sum.upstreamBlocked) {
    const ids = (blocked.blockedBy || []).map((b) => b.id).join(',');
    issueItems.push(`[受阻] ${blocked.id}<-${ids}`);
  }
  for (const warn of sum.dependencyWarnings) {
    issueItems.push(`[告警] ${warn.phaseId}<-${warn.upstreamPhaseId}(${warn.upstreamStatus})`);
  }

  const readyItems = (sum.readyTasks || []).map((t) => `${t.id} ${t.title}`);
  const phaseProgress = phases.map((phase) => {
    const tasks = Array.isArray(phase.tasks) ? phase.tasks : [];
    const done = tasks.filter((t) => t.status === 'completed').length;
    const status = phase.status || derivePhaseStatusFallback(phase);
    return `${phase.id}[${getStatusMeta(status).label} ${done}/${tasks.length}]`;
  });

  const lines = [
    `计划: ${safePlan.title || sum.title} (${safePlan.planId || sum.planId}, rev #${safePlan.revision ?? sum.revision}, ${counts.completionRate}% ${counts.completed}/${counts.totalTasks})`,
    `计数: 已完成=${counts.completed} 未完成=${counts.unfinished}(进行中=${counts.inProgress}, 待办=${counts.pending}) 无法完成=${counts.impossible} 出错=${counts.error} 已归档=${counts.archived}`,
    `当前进行中 (in_progress): ${inProgressItems.length > 0 ? inProgressItems.join(' ; ') : '无'}`,
    `异常与受阻: ${issueItems.length > 0 ? issueItems.join(' ; ') : '无'}`,
    `下一批可执行 (readyTasks): ${readyItems.length > 0 ? readyItems.join(' ; ') : '无'}`,
    `阶段进度: ${phaseProgress.length > 0 ? phaseProgress.join(' | ') : '无阶段'}`,
  ];

  return `${lines.join('\n')}\n`;
}

function escapeMdInline(value) {
  return String(value === null || value === undefined ? '' : value).replace(/\r?\n/g, ' ');
}

function renderMarkdown(plan, summary, options = {}) {
  const safePlan = plan && typeof plan === 'object' ? plan : {};
  const sum = normalizeSummary(safePlan, summary);
  const counts = sum.counts;
  const renderedAt = options.renderedAt || new Date().toISOString();
  const blockedMap = buildBlockedMap(sum);

  const lines = [];
  lines.push(`# ${escapeMdInline(safePlan.title || sum.title || '未命名计划')}`);
  lines.push('');
  lines.push(`- **planId**: \`${escapeMdInline(safePlan.planId || sum.planId)}\``);
  lines.push(`- **revision**: \`${safePlan.revision ?? sum.revision}\``);
  lines.push(`- **updatedAt**: \`${escapeMdInline(safePlan.updatedAt || sum.updatedAt || '-')}\``);
  lines.push(`- **renderedAt**: \`${escapeMdInline(renderedAt)}\``);
  lines.push(`- **goal**: ${escapeMdInline(safePlan.goal || '（无）')}`);
  lines.push('');
  lines.push('| 已完成 | 未完成 | 进行中 | 无法完成 | 出错 | 已归档 | 总任务 | 完成率 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  lines.push(`| ${counts.completed} | ${counts.unfinished} | ${counts.inProgress} | ${counts.impossible} | ${counts.error} | ${counts.archived} | ${counts.totalTasks} | ${counts.completionRate}% |`);

  if (sum.dependencyWarnings.length > 0) {
    lines.push('');
    lines.push('> **依赖告警**');
    for (const warn of sum.dependencyWarnings) {
      const msg = warn.message || `${warn.phaseId} 依赖 ${warn.upstreamPhaseId} (${warn.upstreamStatus})`;
      lines.push(`> - \`${escapeMdInline(warn.code || 'DEPENDENCY_WARNING')}\`: ${escapeMdInline(msg)}`);
    }
  }

  const phases = Array.isArray(safePlan.phases) ? safePlan.phases : [];
  for (const phase of phases) {
    const phaseStatus = phase.status || derivePhaseStatusFallback(phase);
    const phaseMeta = getStatusMeta(phaseStatus);
    lines.push('');
    lines.push(`### ${escapeMdInline(phase.id)}: ${escapeMdInline(phase.title)} [${phaseMeta.label}]`);
    if (phase.goal) {
      lines.push(`- **goal**: ${escapeMdInline(phase.goal)}`);
    }
    if (Array.isArray(phase.dependsOn) && phase.dependsOn.length > 0) {
      lines.push(`- **dependsOn**: ${phase.dependsOn.map((d) => `\`${escapeMdInline(d)}\``).join(', ')}`);
    }
    lines.push('');
    const tasks = Array.isArray(phase.tasks) ? phase.tasks : [];
    if (tasks.length === 0) {
      lines.push('_（空阶段，暂无任务）_');
      continue;
    }
    for (const task of tasks) {
      const taskMeta = getStatusMeta(task.status);
      const box = task.status === 'completed' ? 'x' : ' ';
      lines.push(`- [${box}] **${taskMeta.badge}** \`${escapeMdInline(task.id)}\` ${escapeMdInline(task.title)}`);
      if (task.owner) {
        lines.push(`  - **owner**: \`${escapeMdInline(task.owner)}\``);
      }
      if (task.acceptance) {
        lines.push(`  - **acceptance**: ${escapeMdInline(task.acceptance)}`);
      }
      if (Array.isArray(task.dependsOn) && task.dependsOn.length > 0) {
        lines.push(`  - **dependsOn**: ${task.dependsOn.map((d) => `\`${escapeMdInline(d)}\``).join(', ')}`);
      }
      if (task.statusReason) {
        lines.push(`  - **statusReason**: ${escapeMdInline(task.statusReason)}`);
      }
      const blockers = blockedMap.get(task.id);
      if (blockers && blockers.length > 0) {
        lines.push(`  - **upstreamBlocked**: ${escapeMdInline(formatBlockedBy(blockers))}`);
      }
      if (task.note) {
        lines.push(`  - **note**: ${escapeMdInline(task.note)}`);
      }
      if (Array.isArray(task.evidence) && task.evidence.length > 0) {
        lines.push(`  - **evidence**: ${task.evidence.map((e) => escapeMdInline(e)).join(' ; ')}`);
      }
      if (task.origin && task.origin !== 'initial') {
        lines.push(`  - **origin**: \`${escapeMdInline(task.origin)}\``);
      }
    }
  }

  const history = Array.isArray(safePlan.history) ? safePlan.history : [];
  const truncatedNote = safePlan.truncatedHistoryCount ? `，已截断 ${safePlan.truncatedHistoryCount} 条` : '';
  lines.push('');
  lines.push('<details>');
  lines.push(`<summary>变更历史 (${history.length} 条${truncatedNote})</summary>`);
  lines.push('');
  if (history.length === 0) {
    lines.push('_暂无变更记录_');
  } else {
    for (const entry of history) {
      lines.push(`- ${escapeMdInline(formatHistoryLine(entry))}`);
    }
  }
  lines.push('');
  lines.push('</details>');

  const archived = Array.isArray(safePlan.archived) ? safePlan.archived : [];
  lines.push('');
  lines.push('<details>');
  lines.push(`<summary>已归档项 (${archived.length} 项)</summary>`);
  lines.push('');
  if (archived.length === 0) {
    lines.push('_暂无已归档项_');
  } else {
    for (const entry of archived) {
      lines.push(`- ${escapeMdInline(formatArchivedLine(entry))}`);
    }
  }
  lines.push('');
  lines.push('</details>');

  return `${lines.join('\n')}\n`;
}

function renderHtml(plan, summary, options = {}) {
  const safePlan = plan && typeof plan === 'object' ? plan : {};
  const sum = normalizeSummary(safePlan, summary);
  const counts = sum.counts;
  const renderedAt = options.renderedAt || new Date().toISOString();
  const blockedMap = buildBlockedMap(sum);
  const phases = Array.isArray(safePlan.phases) ? safePlan.phases : [];
  const history = Array.isArray(safePlan.history) ? safePlan.history : [];
  const archived = Array.isArray(safePlan.archived) ? safePlan.archived : [];

  const warningsHtml = sum.dependencyWarnings.length > 0
    ? `<section class="alert-banner" role="alert" aria-label="依赖告警">
        <h2>依赖告警 (${sum.dependencyWarnings.length})</h2>
        <ul>
          ${sum.dependencyWarnings.map((w) => {
            const msg = w.message || `${w.phaseId} 依赖的 ${w.upstreamPhaseId} 当前状态为 ${w.upstreamStatus}`;
            return `<li><code>${escapeHtml(w.code || 'DEPENDENCY_WARNING')}</code> ${escapeHtml(msg)}</li>`;
          }).join('\n          ')}
        </ul>
      </section>`
    : '';

  const phasesHtml = phases.length === 0
    ? '<section class="phase-card"><p class="empty-note">暂无阶段</p></section>'
    : phases.map((phase) => {
        const phaseStatus = phase.status || derivePhaseStatusFallback(phase);
        const phaseMeta = getStatusMeta(phaseStatus);
        const tasks = Array.isArray(phase.tasks) ? phase.tasks : [];
        const phaseDepsHtml = Array.isArray(phase.dependsOn) && phase.dependsOn.length > 0
          ? `<div class="phase-meta"><strong>依赖阶段:</strong> ${phase.dependsOn.map((d) => `<code>${escapeHtml(d)}</code>`).join(' ')}</div>`
          : '';
        const phaseGoalHtml = phase.goal
          ? `<p class="phase-goal">${escapeHtml(phase.goal)}</p>`
          : '';
        const tasksHtml = tasks.length === 0
          ? '<p class="empty-note">空阶段，暂无任务</p>'
          : `<ul class="task-list">
              ${tasks.map((task) => {
                const taskMeta = getStatusMeta(task.status);
                const blockers = blockedMap.get(task.id);
                const metaRows = [];
                if (task.owner) {
                  metaRows.push(`<div><span class="meta-label">负责人:</span> <code>${escapeHtml(task.owner)}</code></div>`);
                }
                if (task.acceptance) {
                  metaRows.push(`<div><span class="meta-label">验收标准:</span> ${escapeHtml(task.acceptance)}</div>`);
                }
                if (Array.isArray(task.dependsOn) && task.dependsOn.length > 0) {
                  metaRows.push(`<div><span class="meta-label">前置依赖:</span> ${task.dependsOn.map((d) => `<code>${escapeHtml(d)}</code>`).join(' ')}</div>`);
                }
                if (task.statusReason) {
                  metaRows.push(`<div class="meta-reason"><span class="meta-label">状态原因:</span> ${escapeHtml(task.statusReason)}</div>`);
                }
                if (blockers && blockers.length > 0) {
                  metaRows.push(`<div class="meta-blocked" role="note"><span class="meta-label">上游受阻:</span> ${escapeHtml(formatBlockedBy(blockers))}</div>`);
                }
                if (task.note) {
                  metaRows.push(`<div><span class="meta-label">备注:</span> ${escapeHtml(task.note)}</div>`);
                }
                if (Array.isArray(task.evidence) && task.evidence.length > 0) {
                  metaRows.push(`<div><span class="meta-label">证据:</span> ${task.evidence.map((e) => `<code>${escapeHtml(e)}</code>`).join(' ; ')}</div>`);
                }
                if (task.origin && task.origin !== 'initial') {
                  metaRows.push(`<div><span class="meta-label">来源:</span> <code>${escapeHtml(task.origin)}</code></div>`);
                }
                return `<li class="task-item status-${escapeHtml(task.status)}" data-task-id="${escapeHtml(task.id)}" data-status="${escapeHtml(task.status)}">
                  <div class="task-head">
                    <span class="badge badge-${escapeHtml(task.status)}">${escapeHtml(taskMeta.badge)}</span>
                    <code class="task-id">${escapeHtml(task.id)}</code>
                    <span class="task-title">${escapeHtml(task.title)}</span>
                  </div>
                  ${metaRows.length > 0 ? `<div class="task-meta">${metaRows.join('\n                    ')}</div>` : ''}
                </li>`;
              }).join('\n              ')}
            </ul>`;

        return `<section class="phase-card status-${escapeHtml(phaseStatus)}" data-phase-id="${escapeHtml(phase.id)}" data-phase-status="${escapeHtml(phaseStatus)}">
          <header class="phase-head">
            <h2><code>${escapeHtml(phase.id)}</code> ${escapeHtml(phase.title)}</h2>
            <span class="badge badge-${escapeHtml(phaseStatus)}">${escapeHtml(phaseMeta.badge)}</span>
          </header>
          ${phaseGoalHtml}
          ${phaseDepsHtml}
          ${tasksHtml}
        </section>`;
      }).join('\n      ');

  const truncatedNote = safePlan.truncatedHistoryCount ? `，已截断 ${safePlan.truncatedHistoryCount} 条` : '';
  const historyHtml = history.length === 0
    ? '<p class="empty-note">暂无变更记录</p>'
    : `<ul class="log-list">${history.map((entry) => `<li>${escapeHtml(formatHistoryLine(entry))}</li>`).join('')}</ul>`;

  const archivedHtml = archived.length === 0
    ? '<p class="empty-note">暂无已归档项</p>'
    : `<ul class="log-list">${archived.map((entry) => `<li>${escapeHtml(formatArchivedLine(entry))}</li>`).join('')}</ul>`;

  const embeddedSnapshot = safeJsonForScript({
    plan: safePlan,
    summary: sum,
    renderedAt,
  });

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <title>${escapeHtml(safePlan.title || sum.title || 'TODO 计划视图')}</title>
  <style>
    :root {
      --bg: #f8fafc;
      --surface: #ffffff;
      --border: #cbd5e1;
      --text: #0f172a;
      --muted: #475569;
      --completed: #15803d;
      --completed-bg: #dcfce7;
      --in-progress: #0369a1;
      --in-progress-bg: #e0f2fe;
      --pending: #475569;
      --pending-bg: #f1f5f9;
      --impossible: #7e22ce;
      --impossible-bg: #f3e8ff;
      --error: #b91c1c;
      --error-bg: #fee2e2;
      --warn: #92400e;
      --warn-bg: #fef3c7;
      --focus: #2563eb;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px 16px 48px;
      background: var(--bg);
      color: var(--text);
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
      line-height: 1.55;
    }
    main { max-width: 980px; margin: 0 auto; }
    .card, .phase-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 18px 20px;
      margin-bottom: 16px;
    }
    h1 { margin: 0 0 8px; font-size: 1.55rem; }
    h2 { margin: 0; font-size: 1.15rem; }
    .plan-goal { margin: 4px 0 12px; color: var(--muted); }
    .timestamps {
      display: flex;
      flex-wrap: wrap;
      gap: 10px 20px;
      font-size: 0.9rem;
      color: var(--muted);
      margin-bottom: 14px;
    }
    .progress-wrap { margin: 12px 0 16px; }
    .progress-label {
      display: flex;
      justify-content: space-between;
      font-size: 0.92rem;
      font-weight: 600;
      margin-bottom: 6px;
    }
    .progress-track {
      width: 100%;
      height: 14px;
      background: #e2e8f0;
      border-radius: 999px;
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      background: var(--completed);
      width: ${counts.completionRate}%;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      gap: 10px;
    }
    .stat-box {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 12px;
      background: #f8fafc;
    }
    .stat-label { font-size: 0.82rem; color: var(--muted); }
    .stat-value { font-size: 1.25rem; font-weight: 700; }
    .alert-banner {
      background: var(--warn-bg);
      border: 1px solid #f59e0b;
      border-left: 5px solid var(--warn);
      border-radius: 8px;
      padding: 12px 16px;
      margin-bottom: 16px;
      color: var(--warn);
    }
    .alert-banner ul { margin: 8px 0 0; padding-left: 20px; }
    .filter-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 16px 0;
    }
    .filter-btn {
      appearance: none;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--text);
      border-radius: 999px;
      padding: 6px 14px;
      font-size: 0.88rem;
      font-weight: 600;
      cursor: pointer;
    }
    .filter-btn[aria-pressed="true"] {
      background: var(--text);
      color: #ffffff;
      border-color: var(--text);
    }
    .filter-btn:focus-visible, summary:focus-visible {
      outline: 3px solid var(--focus);
      outline-offset: 2px;
    }
    .phase-head {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }
    .phase-goal, .phase-meta { margin: 4px 0 10px; font-size: 0.92rem; color: var(--muted); }
    .task-list { list-style: none; margin: 10px 0 0; padding: 0; }
    .task-item {
      border: 1px solid var(--border);
      border-left: 4px solid var(--pending);
      border-radius: 8px;
      padding: 10px 12px;
      margin-bottom: 10px;
    }
    .task-item.status-completed { border-left-color: var(--completed); }
    .task-item.status-in_progress { border-left-color: var(--in-progress); background: #f0f9ff; }
    .task-item.status-impossible { border-left-color: var(--impossible); }
    .task-item.status-error { border-left-color: var(--error); background: #fef2f2; }
    .task-item.is-hidden { display: none; }
    .task-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .task-id { font-weight: 700; font-size: 0.88rem; }
    .task-title { font-weight: 600; }
    .task-meta {
      margin-top: 8px;
      padding-left: 8px;
      font-size: 0.88rem;
      color: var(--muted);
      display: grid;
      gap: 4px;
    }
    .meta-label { font-weight: 600; color: var(--text); }
    .meta-reason { color: var(--error); }
    .meta-blocked {
      color: var(--warn);
      background: var(--warn-bg);
      padding: 4px 8px;
      border-radius: 6px;
    }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 0.8rem;
      font-weight: 700;
      border: 1px solid transparent;
    }
    .badge-completed { color: var(--completed); background: var(--completed-bg); border-color: #86efac; }
    .badge-in_progress { color: var(--in-progress); background: var(--in-progress-bg); border-color: #7dd3fc; }
    .badge-pending, .badge-empty { color: var(--pending); background: var(--pending-bg); border-color: #cbd5e1; }
    .badge-impossible { color: var(--impossible); background: var(--impossible-bg); border-color: #d8b4fe; }
    .badge-error { color: var(--error); background: var(--error-bg); border-color: #fca5a5; }
    details.card summary { cursor: pointer; font-weight: 700; }
    .log-list { margin: 10px 0 0; padding-left: 20px; font-size: 0.88rem; color: var(--muted); }
    .log-list li { margin-bottom: 4px; }
    .empty-note { color: var(--muted); font-style: italic; margin: 8px 0 0; }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.86em;
      background: #f1f5f9;
      padding: 1px 5px;
      border-radius: 4px;
    }
    @media print {
      body { background: #ffffff; padding: 0; }
      .filter-bar { display: none; }
      .task-item.is-hidden { display: block !important; }
    }
  </style>
</head>
<body>
  <main>
    <header class="card">
      <h1>${escapeHtml(safePlan.title || sum.title || '未命名计划')}</h1>
      ${safePlan.goal ? `<p class="plan-goal">${escapeHtml(safePlan.goal)}</p>` : ''}
      <div class="timestamps">
        <span><strong>Plan ID:</strong> <code>${escapeHtml(safePlan.planId || sum.planId)}</code></span>
        <span><strong>计划更新时间:</strong> <code>${escapeHtml(safePlan.updatedAt || sum.updatedAt || '-')}</code> (revision #${escapeHtml(String(safePlan.revision ?? sum.revision))})</span>
        <span><strong>快照生成时间:</strong> <code>${escapeHtml(renderedAt)}</code></span>
      </div>
      <div class="progress-wrap">
        <div class="progress-label">
          <span>总任务完成进度</span>
          <span>${counts.completionRate}% (${counts.completed}/${counts.totalTasks})</span>
        </div>
        <div class="progress-track" role="progressbar" aria-valuenow="${counts.completionRate}" aria-valuemin="0" aria-valuemax="100" aria-label="总任务完成进度">
          <div class="progress-fill"></div>
        </div>
      </div>
      <div class="stats-grid">
        <div class="stat-box"><div class="stat-label">已完成</div><div class="stat-value">${counts.completed}</div></div>
        <div class="stat-box"><div class="stat-label">未完成 (进行中 ${counts.inProgress} / 待办 ${counts.pending})</div><div class="stat-value">${counts.unfinished}</div></div>
        <div class="stat-box"><div class="stat-label">无法完成</div><div class="stat-value">${counts.impossible}</div></div>
        <div class="stat-box"><div class="stat-label">出错</div><div class="stat-value">${counts.error}</div></div>
        <div class="stat-box"><div class="stat-label">已归档</div><div class="stat-value">${counts.archived}</div></div>
        <div class="stat-box"><div class="stat-label">总任务</div><div class="stat-value">${counts.totalTasks}</div></div>
      </div>
    </header>

    ${warningsHtml}

    <nav class="filter-bar" role="toolbar" aria-label="按任务状态筛选">
      <button type="button" class="filter-btn" data-filter="all" aria-pressed="true">全部 (${counts.totalTasks})</button>
      <button type="button" class="filter-btn" data-filter="in_progress" aria-pressed="false">进行中 (${counts.inProgress})</button>
      <button type="button" class="filter-btn" data-filter="pending" aria-pressed="false">未完成 (${counts.pending})</button>
      <button type="button" class="filter-btn" data-filter="error" aria-pressed="false">出错 (${counts.error})</button>
      <button type="button" class="filter-btn" data-filter="impossible" aria-pressed="false">无法完成 (${counts.impossible})</button>
      <button type="button" class="filter-btn" data-filter="completed" aria-pressed="false">已完成 (${counts.completed})</button>
    </nav>

    <section aria-label="阶段与任务列表">
      ${phasesHtml}
    </section>

    <details class="card">
      <summary>变更历史 (${history.length} 条${escapeHtml(truncatedNote)})</summary>
      ${historyHtml}
    </details>

    <details class="card">
      <summary>已归档项 (${archived.length} 项)</summary>
      ${archivedHtml}
    </details>
  </main>

  <script id="dw-todo-plan-data" type="application/json">${embeddedSnapshot}</script>
  <script>
    (function () {
      var buttons = Array.prototype.slice.call(document.querySelectorAll('.filter-btn'));
      var tasks = Array.prototype.slice.call(document.querySelectorAll('.task-item'));
      function applyFilter(filter) {
        buttons.forEach(function (btn) {
          btn.setAttribute('aria-pressed', btn.getAttribute('data-filter') === filter ? 'true' : 'false');
        });
        tasks.forEach(function (item) {
          var status = item.getAttribute('data-status');
          var show = filter === 'all' || status === filter;
          item.classList.toggle('is-hidden', !show);
        });
      }
      buttons.forEach(function (btn) {
        btn.addEventListener('click', function () {
          applyFilter(btn.getAttribute('data-filter') || 'all');
        });
      });
    })();
  </script>
</body>
</html>
`;
}

function renderPlan(format, plan, summary, options = {}) {
  const fmt = String(format === undefined || format === null ? 'terminal' : format).trim().toLowerCase();
  if (fmt === 'terminal') {
    return renderTerminal(plan, summary, options);
  }
  if (fmt === 'text') {
    return renderTerminal(plan, summary, { ...options, noColor: true });
  }
  if (fmt === 'brief') {
    return renderBrief(plan, summary);
  }
  if (fmt === 'markdown' || fmt === 'md') {
    return renderMarkdown(plan, summary, options);
  }
  if (fmt === 'html') {
    return renderHtml(plan, summary, options);
  }
  const err = new Error(`Unsupported render format: ${format}`);
  err.code = 'INVALID_ARGUMENT';
  err.exitCode = 2;
  throw err;
}

module.exports = {
  STATUS_META,
  escapeHtml,
  safeJsonForScript,
  renderTerminal,
  renderBrief,
  renderMarkdown,
  renderHtml,
  renderPlan,
};
