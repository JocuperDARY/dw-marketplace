import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentJournal } from './agent-journal.js';
import { allocateStage } from './orchestration.js';
import { requireValue, safeError } from './errors.js';
import { agentMessageSchema, agentInterruptSchema, agentWaitSchema } from './agent-schema.js';

const live = new Set(['running', 'cancelling']);
const fingerprint = input => createHash('sha256').update(JSON.stringify(input)).digest('hex');

/** Parent control is authorized by the existing capability, never by parentLabel.
 * The journal accepts messages without taking or transferring an execution lease. */
export class AgentCoordinator {
  constructor(manager) { this.manager = manager; }
  journal(record) { return new AgentJournal(this.manager.store.taskDirectory(record.taskId), record.taskId); }
  async requireAgent(agentId, token, mutate = true) {
    const record = await this.manager.agentRecord(agentId);
    requireValue(record.agent, 'NOT_AGENT', 'This task was not created by dsh_spawn_agent; its existing task APIs remain available.');
    if (mutate) await this.manager.store.authorize(agentId, token);
    return record;
  }
  async snapshot(record) {
    const journal = this.journal(record); const head = await journal.read();
    return { ...this.manager.observedSummary(record, record.attempts.at(-1)), agentId: record.taskId,
      activityId: head.activityId, availability: head.availability, recoveryRequired: head.recoveryRequired,
      contextRevision: head.contextRevision, includedContextRevision: head.includedContextRevision,
      pendingMessageCount: head.pending.length, unresolvedQuestionCount: head.questions.filter(item => !item.resolved).length,
      communication: record.agent.communication, sessionEpoch: head.runtime?.epoch ?? null, cursor: journal.cursor(head) };
  }
  async spawn(input, beforeLaunch) {
    const single = input.executionMode === 'single-request';
    requireValue(!single || input.communication !== 'native', 'COMMUNICATION_DISABLED', 'Single-request workers cannot enable execution messaging.');
    const communication = single ? 'disabled' : input.communication ?? 'native';
    const receipt = await this.manager.submit({ ...input, communication, agentMode: true }, beforeLaunch);
    const record = await this.requireAgent(receipt.taskId, undefined, false);
    return { ...await this.snapshot(record), ...(receipt.controlToken ? { controlToken: receipt.controlToken } : {}), duplicate: receipt.duplicate ?? false };
  }
  message(operation, raw, beforeLaunch = () => {}) {
    const input = agentMessageSchema.parse(raw);
    return this.manager.serialize(async () => {
      this.manager.assertAvailable();
      const record = await this.requireAgent(input.agentId, input.controlToken);
      requireValue(record.agent.communication === 'native' && record.planning.executionMode !== 'single-request',
        'COMMUNICATION_DISABLED', 'This worker authorization does not permit execution messaging.');
      const receipt = await this.journal(record).accept(operation, input);
      // Running/closing workers own their wake handoff. A different connection
      // may enqueue but cannot race the active execution lease.
      if (operation === 'followup' && !live.has(record.attempts.at(-1).status)) await this.wake(record.taskId, input.controlToken, beforeLaunch);
      return { ...receipt, ...await this.snapshot(await this.manager.agentRecord(record.taskId)), messageId: receipt.messageId,
        acceptedContextRevision: receipt.contextRevision, accepted: true };
    });
  }
  async wake(agentId, controlToken, beforeLaunch = () => {}, { postInterruptOnly = false } = {}) {
    if (this.manager.closed) return;
    const record = await this.requireAgent(agentId, controlToken);
    const journal = this.journal(record); const head = await journal.read();
    const waking = head.pending.filter(item => item.operation === 'followup'
      && (!postInterruptOnly || item.resumeAfterInterrupt === head.activityId));
    if (!waking.length || live.has(record.attempts.at(-1).status) || this.manager.active.has(agentId)) return;
    // The owner can publish its terminal result before it finishes the journal
    // and releases its lease. Leave accepted input queued for that handoff.
    if (this.manager.snapshot?.leases?.some(item => item.taskId === agentId)) return;
    requireValue(!head.recoveryRequired && !head.runtime && head.availability !== 'interrupting' && head.availability !== 'closed',
      'RECOVERY_REQUIRED', 'The old worker activity must be safely reconciled before resuming.');
    const last = record.attempts.at(-1);
    requireValue(last.cleanup === 'confirmed' && ['completed', 'paused', 'interrupted'].includes(last.status),
      'NOT_RESUMABLE', 'Only an idle or interrupted worker with confirmed cleanup can resume.');
    if (record.orchestration) allocateStage(record, last.timeoutMs);
    requireValue(await this.manager.workspace(record.workspace) === record.workspace, 'WORKSPACE_CHANGED', 'The worker workspace identity changed.');
    await beforeLaunch();
    record.taskContext = await journal.context();
    const id = `wake-${waking.at(-1).messageId}`;
    return this.manager.begin(record, { id, fingerprint: fingerprint({ agentId, id }),
      prompt: 'Continue the assigned task using the current parent context and pending messages. Reuse verified work and evidence; do not repeat completed work. Parent acceptance is still separate.',
      timeoutMs: last.timeoutMs, resume: true, controlToken, skipContext: true,
      expectedRevision: this.manager.snapshot.recordRevisions[record.taskId] });
  }
  async interrupt(raw) {
    const input = agentInterruptSchema.parse(raw);
    const record = await this.requireAgent(input.agentId, input.controlToken); const journal = this.journal(record);
    const receipt = await journal.requestInterrupt(input);
    const deadline = Date.now() + (input.waitTimeoutMs ?? 0);
    let head;
    do { head = await journal.read(); if (head.activityId !== receipt.activityId || head.availability !== 'interrupting' || Date.now() >= deadline) break; await delay(25); } while (true);
    const current = await this.manager.agentRecord(input.agentId);
    const attempt = current.attempts.find(item => `${input.agentId}:${item.number}` === receipt.activityId);
    const settled = !!attempt && !live.has(attempt.status) && attempt.cleanup === 'confirmed';
    return { ...await this.snapshot(current), ...receipt, targetActivityId: receipt.activityId,
      activityStopped: settled || (head.activityId === receipt.activityId && head.interrupt?.activityStopped === true),
      descendantsStopped: settled || (head.activityId === receipt.activityId && head.interrupt?.descendantsStopped === true),
      runtimeCleanup: attempt?.cleanup ?? 'unverified', pendingMessageCount: head.pending.length };
  }
  async wait(raw) {
    const { targets, timeoutMs = 30000 } = agentWaitSchema.parse(raw);
    const deadline = Date.now() + timeoutMs;
    do {
      const updates = []; const errors = [];
      await Promise.all(targets.map(async target => {
        try {
          const record = await this.requireAgent(target.agentId, undefined, false);
          const page = await this.journal(record).events(target.afterCursor);
          updates.push({ agentId: target.agentId, events: page.events, cursor: page.cursor, hasMore: page.hasMore,
            snapshot: await this.snapshot(record) });
        } catch (error) { errors.push({ agentId: target.agentId, error: safeError(error) }); }
      }));
      if (errors.length || updates.some(item => item.events.length) || Date.now() >= deadline)
        return { updates, errors, timedOut: !errors.length && updates.every(item => !item.events.length) };
      await delay(Math.min(50, Math.max(1, deadline - Date.now())));
    } while (true);
  }
  async list(input = {}) {
    const page = await this.manager.list(input);
    const records = page.tasks ?? [];
    const agents = [];
    for (const item of records) {
      const record = this.manager.cachedRecord(item.taskId);
      if (record.agent) agents.push(await this.snapshot(record));
    }
    return { ...page, tasks: undefined, agents };
  }
  async afterActivity(record, attempt) {
    const journal = this.journal(record);
    await journal.finishActivity(attempt);
    if (attempt.status === 'interrupted' && attempt.cleanup === 'confirmed') await journal.transaction(tx => {
      requireValue(tx.head.activityId === `${record.taskId}:${attempt.number}`, 'STALE_ACTIVITY', 'An older interruption cannot change the current agent state.');
      if (tx.head.interrupt) {
        tx.head.interrupt.activityStopped = true;
        // Complete owned-runtime cleanup includes its process tree. Native drain
        // evidence, when available, is recorded separately before teardown.
        tx.head.interrupt.descendantsStopped = true;
      }
    });
  }
}
