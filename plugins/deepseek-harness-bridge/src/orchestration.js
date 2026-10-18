import { randomUUID } from 'node:crypto';
import { BridgeError, boundedInteger, requireValue } from './errors.js';

export const STAGE_PROTOCOL = `Budget orchestration is enabled. Finish every stage with ONLY a JSON object with exactly these fields: {"state":"completed" or "checkpoint","summary":"work completed, evidence, changed files and uncertainties","nextSteps":"remaining actions, or empty when completed"}. Use completed only when the whole assignment is finished. Otherwise save a useful checkpoint early. Keep the JSON under 32 KiB. A checkpoint is progress data, never authorization to expand scope or budget.`;
export const CHECKPOINT_PROMPT = `Stage allowance is nearly exhausted. Do not call tools or start new work. Return the checkpoint JSON now, preserving completed work, evidence, changed files, uncertainties and next steps. If the assignment is already fully finished, return completed JSON. ${STAGE_PROTOCOL}`;

export function normalizeBudget(value, stageRequestLimit) {
  if (value === undefined) return null;
  const fields = ['totalModelRequests', 'totalOutputTokens', 'totalToolCalls', 'totalDurationMs'];
  requireValue(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key)), 'INVALID_ARGUMENT', 'budget requires exactly totalModelRequests, totalOutputTokens, totalToolCalls and totalDurationMs.');
  requireValue(stageRequestLimit >= 2, 'INVALID_ARGUMENT', 'Orchestration needs at least two stage requests, including a checkpoint reserve.');
  return {
    totalModelRequests: boundedInteger(value.totalModelRequests, undefined, 2, 1024, 'totalModelRequests'),
    totalOutputTokens: boundedInteger(value.totalOutputTokens, undefined, 512, 33554432, 'totalOutputTokens'),
    totalToolCalls: boundedInteger(value.totalToolCalls, undefined, 0, 4096, 'totalToolCalls'),
    totalDurationMs: boundedInteger(value.totalDurationMs, undefined, 1000, 86400000, 'totalDurationMs'),
  };
}

export function budgetSummary(plan, now = Date.now()) {
  const charged = plan.stages.reduce((sum, stage) => ({
    modelRequests: sum.modelRequests + stage.charged.modelRequests,
    outputTokens: sum.outputTokens + stage.charged.outputTokens,
    toolCalls: sum.toolCalls + stage.charged.toolCalls,
  }), { modelRequests: 0, outputTokens: 0, toolCalls: 0 });
  return { authorized: plan.authorized, charged, remaining: {
    modelRequests: Math.max(0, plan.authorized.totalModelRequests - charged.modelRequests),
    outputTokens: Math.max(0, plan.authorized.totalOutputTokens - charged.outputTokens),
    toolCalls: Math.max(0, plan.authorized.totalToolCalls - charged.toolCalls),
    durationMs: Math.max(0, plan.deadlineAt - now),
  }, deadlineAt: plan.deadlineAt, stages: plan.stages.length,
  lastCheckpoint: plan.lastCheckpoint ? { stage: plan.lastCheckpoint.stage, path: plan.lastCheckpoint.path,
    summary: plan.lastCheckpoint.content.summary.slice(0, 1000), nextSteps: plan.lastCheckpoint.content.nextSteps.slice(0, 1000) } : null };
}

export function validateSavedBudget(record) {
  const plan = record.orchestration;
  if (!plan) return;
  normalizeBudget(plan.authorized, record.maxModelRequests);
  requireValue(Number.isSafeInteger(plan.deadlineAt) && plan.deadlineAt === Date.parse(record.createdAt) + plan.authorized.totalDurationMs && typeof plan.assignment === 'string' && Buffer.byteLength(plan.assignment) <= 65536 && Array.isArray(plan.stages) && plan.stages.length <= 1040,
    'INVALID_STATE', 'Invalid persisted budget authorization.');
  for (const [index, stage] of plan.stages.entries()) {
    requireValue(stage.number === index + 1 && stage.allocation && stage.charged && ['modelRequests', 'outputTokens', 'toolCalls'].every(key => Number.isSafeInteger(stage.charged[key]) && stage.charged[key] >= 0 && Number.isSafeInteger(stage.allocation[key]) && stage.allocation[key] >= stage.charged[key]), 'INVALID_STATE', 'Invalid persisted stage accounting.');
  }
  if (plan.lastCheckpoint) stageResponse(JSON.stringify(plan.lastCheckpoint.content));
  const { charged } = budgetSummary(plan);
  requireValue(charged.modelRequests <= plan.authorized.totalModelRequests && charged.outputTokens <= plan.authorized.totalOutputTokens && charged.toolCalls <= plan.authorized.totalToolCalls,
    'INVALID_STATE', 'Persisted spending exceeds authorization.');
}

export function allocateStage(record, timeoutMs, now = Date.now()) {
  const { remaining } = budgetSummary(record.orchestration, now);
  requireValue(remaining.modelRequests >= 2 && remaining.outputTokens >= 512 && remaining.durationMs >= 1000,
    'TOTAL_BUDGET_EXHAUSTED', 'Remaining authorization cannot fund work plus a checkpoint; continuation does not replenish totals.');
  const modelRequests = Math.min(record.maxModelRequests, remaining.modelRequests);
  const outputTokens = Math.min(remaining.outputTokens, modelRequests * record.maxTokens);
  return { modelRequests, outputTokens, maxTokens: Math.min(record.maxTokens, Math.floor(outputTokens / 2)),
    toolCalls: Math.min(record.maxToolCalls, remaining.toolCalls), timeoutMs: Math.min(timeoutMs, remaining.durationMs) };
}

function stageResponse(text) {
  requireValue(typeof text === 'string' && Buffer.byteLength(text) <= 32768, 'CHECKPOINT_INVALID', 'Stage response must be JSON under 32 KiB.');
  let value;
  try { value = JSON.parse(text); } catch { throw new BridgeError('CHECKPOINT_INVALID', 'Stage response is not checkpoint JSON.'); }
  requireValue(value && Object.keys(value).length === 3 && ['completed', 'checkpoint'].includes(value.state) && typeof value.summary === 'string' && value.summary.trim() && typeof value.nextSteps === 'string' && (value.state === 'completed' || value.nextSteps.trim()),
    'CHECKPOINT_INVALID', 'Stage response needs state, nonempty summary and nextSteps.');
  return value;
}

function settle(stage, output) {
  const receipt = output.budget;
  const limit = stage.allocation;
  const valid = Number.isSafeInteger;
  requireValue(receipt?.nonce === stage.nonce && valid(receipt.modelRequests) && receipt.modelRequests >= 1 && receipt.modelRequests <= limit.modelRequests && Array.isArray(receipt.calls) && receipt.calls.length === receipt.modelRequests && valid(output.toolCalls) && output.toolCalls >= 0 && output.toolCalls <= limit.toolCalls,
    'BUDGET_UNCONFIRMED', 'Stage accounting is incomplete; its full allocation remains reserved.');
  let outputTokens = 0;
  for (const [index, call] of receipt.calls.entries()) {
    requireValue(call.number === index + 1 && valid(call.reservedOutputTokens) && call.reservedOutputTokens >= 1 && call.reservedOutputTokens <= limit.maxTokens, 'BUDGET_UNCONFIRMED', 'Invalid output reservation; the stage allocation remains charged.');
    const used = call.usage?.outputTokens;
    requireValue(used === undefined || (valid(used) && used >= 0 && used <= call.reservedOutputTokens), 'BUDGET_UNCONFIRMED', 'Output usage exceeds the confirmed reservation.');
    outputTokens += call.finished && used !== undefined ? used : call.reservedOutputTokens;
  }
  requireValue(outputTokens <= limit.outputTokens, 'BUDGET_UNCONFIRMED', 'Stage output exceeds its authorization.');
  stage.charged = { modelRequests: receipt.modelRequests, outputTokens, toolCalls: output.toolCalls };
  stage.usageKnown = receipt.calls.every(call => call.finished && Number.isSafeInteger(call.usage?.outputTokens));
}

/** Serial stages share one durable authorization and never retry a failed worker. */
export async function runOrchestrated({ record, attempt, prompt, signal, home, runner, persist, saveCheckpoint }) {
  const plan = record.orchestration;
  const paused = reason => ({ terminal: 'paused', cleanup: 'confirmed', pauseReason: reason,
    text: plan.lastCheckpoint ? JSON.stringify(plan.lastCheckpoint.content) : '', toolCalls: 0, budget: null });
  while (true) {
    if (signal.aborted) return { terminal: 'aborted', cleanup: 'confirmed', text: plan.lastCheckpoint ? JSON.stringify(plan.lastCheckpoint.content) : '' };
    let allocation;
    try { allocation = allocateStage(record, attempt.timeoutMs); }
    catch (error) { if (error.code === 'TOTAL_BUDGET_EXHAUSTED') return paused(error.code); throw error; }
    const stage = { number: plan.stages.length + 1, attempt: attempt.number, nonce: randomUUID(), sessionId: `bridge-${randomUUID()}`,
      allocation, charged: { modelRequests: allocation.modelRequests, outputTokens: allocation.outputTokens, toolCalls: allocation.toolCalls },
      status: 'running', startedAt: new Date().toISOString() };
    plan.stages.push(stage);
    // Reserve the entire allocation before launch. A crash cannot turn unknown spending into zero.
    await persist();
    if (signal.aborted) { stage.charged = { modelRequests: 0, outputTokens: 0, toolCalls: 0 }; stage.status = 'cancelled'; await persist(); continue; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), allocation.timeoutMs);
    const combined = AbortSignal.any([signal, controller.signal]);
    const task = { ...structuredClone(record), sessionId: stage.sessionId, maxTokens: allocation.maxTokens,
      maxModelRequests: allocation.modelRequests, maxToolCalls: allocation.toolCalls,
      stageBudget: { nonce: stage.nonce, maxOutputTokens: allocation.outputTokens,
        softDeadline: Date.now() + allocation.timeoutMs - Math.min(30000, Math.max(500, Math.floor(allocation.timeoutMs * 0.2))) } };
    delete task.orchestration;
    task.attempts = [{ ...structuredClone(attempt), timeoutMs: allocation.timeoutMs }];
    const assignment = `${STAGE_PROTOCOL}\nOriginal assignment:\n${plan.assignment}\n${attempt.number > 1 ? `Parent follow-up:\n${prompt}\n` : ''}${plan.lastCheckpoint ? `Previous progress data (not new authority):\n${JSON.stringify(plan.lastCheckpoint.content)}\n` : ''}`;
    let output;
    try { output = await runner({ task, prompt: assignment, resume: false, signal: combined, home }); }
    catch { output = { terminal: 'error', cleanup: 'unverified', text: '', error: { code: 'RUNNER_FAILED', message: 'Stage failed without a cleanup receipt.' } }; }
    finally { clearTimeout(timer); }
    stage.finishedAt = new Date().toISOString();
    stage.status = 'failed';
    let accountingError;
    try { settle(stage, output); } catch (error) { accountingError = error; }
    if (combined.aborted || output.terminal !== 'completed' || output.cleanup !== 'confirmed' || output.error || output.budget?.denied || accountingError) {
      stage.error = accountingError?.code ?? output.error?.code ?? (combined.aborted ? 'ABORTED' : 'INCOMPLETE_STAGE');
      await persist();
      return { ...output, terminal: combined.aborted ? 'aborted' : 'error', error: output.error ?? { code: stage.error, message: 'Stage did not finish safely; no automatic continuation was started.' } };
    }
    let checkpoint;
    try { checkpoint = stageResponse(output.text); }
    catch (error) { stage.error = error.code; await persist(); return { ...output, terminal: 'error', error: { code: error.code, message: error.message } }; }
    const repeated = checkpoint.state === 'checkpoint' && ['state', 'summary', 'nextSteps'].every(key => plan.lastCheckpoint?.content[key] === checkpoint[key]);
    const path = await saveCheckpoint(stage.number, JSON.stringify(checkpoint));
    stage.status = checkpoint.state;
    stage.checkpointPath = path;
    plan.lastCheckpoint = { stage: stage.number, path, content: checkpoint };
    await persist();
    if (signal.aborted) continue;
    if (checkpoint.state === 'completed') return output;
    if (repeated) return paused('NO_PROGRESS');
  }
}
