import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, open, readFile, unlink } from 'node:fs/promises';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicWrite } from './concurrent-store.js';
import { BridgeError, requireValue } from './errors.js';
import { readPublished, readPublishedSync } from './publication-read.js';
import { applyContextMessage, finishContextActivity, markContextIncluded, validateTaskContext } from './task-context.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const valid = value => requireValue(value, 'INVALID_AGENT_STATE', 'The agent journal is invalid; its evidence was preserved.');
const sequenceName = number => String(number).padStart(16, '0') + '.json';
async function directory(path, create = false) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path); valid(stat.isDirectory() && !stat.isSymbolicLink());
}
async function json(path) {
  const stat = await lstat(path); valid(stat.isFile() && !stat.isSymbolicLink());
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error instanceof SyntaxError) valid(false); throw error; }
}

/** A per-agent short transaction. Waiting, SDK execution and cleanup never hold this lock.
 * Commands/events are segmented files; head publication alone commits their visibility.
 * Context versions retain original authority separately from worker progress and results. */
export class AgentJournal {
  constructor(taskDirectory, agentId, { lockWaitMs = 5000, writer = atomicWrite } = {}) {
    valid(UUID.test(agentId));
    this.directory = join(taskDirectory, 'agent'); this.agentId = agentId;
    this.lockWaitMs = lockWaitMs; this.writer = writer;
  }

  async read() {
    await directory(this.directory);
    const head = await readPublished(() => json(join(this.directory, 'head.json')));
    valid(head.version === 1 && head.agentId === this.agentId && UUID.test(head.generation)
      && Number.isSafeInteger(head.eventSeq) && head.eventSeq >= 0
      && Number.isSafeInteger(head.commandSeq) && head.commandSeq >= 0
      && Number.isSafeInteger(head.contextRevision) && head.contextRevision >= 1
      && Array.isArray(head.pending) && Array.isArray(head.questions));
    return head;
  }

  async context(revision) {
    const head = await this.read(); revision ??= head.contextRevision;
    valid(Number.isSafeInteger(revision) && revision >= 1 && revision <= head.contextRevision);
    await directory(join(this.directory, 'contexts'));
    const context = validateTaskContext(await json(join(this.directory, 'contexts', sequenceName(revision))));
    valid(context.revision === revision); return context;
  }

  contextSync() {
    // The official PromptContext provider is synchronous, including admission
    // refresh. Read one committed head and its immutable context version.
    const read = path => { const stat = lstatSync(path); valid(stat.isFile() && !stat.isSymbolicLink());
      try { return JSON.parse(readFileSync(path, 'utf8')); } catch (error) { if (error instanceof SyntaxError) valid(false); throw error; } };
    const stat = lstatSync(this.directory); valid(stat.isDirectory() && !stat.isSymbolicLink());
    const head = readPublishedSync(() => read(join(this.directory, 'head.json')));
    valid(head.agentId === this.agentId && Number.isSafeInteger(head.contextRevision) && head.contextRevision >= 1);
    const contexts = lstatSync(join(this.directory, 'contexts')); valid(contexts.isDirectory() && !contexts.isSymbolicLink());
    const context = validateTaskContext(read(join(this.directory, 'contexts', sequenceName(head.contextRevision))));
    valid(context.revision === head.contextRevision); return context;
  }

  async initialize(record) {
    await directory(this.directory, true);
    for (const folder of ['contexts', 'commands', 'requests', 'events', 'native']) await directory(join(this.directory, folder), true);
    return this.transaction(async tx => {
      if (tx.head) return;
      tx.context = validateTaskContext(record.taskContext);
      tx.head = { version: 1, agentId: this.agentId, generation: randomUUID(), eventSeq: 0, commandSeq: 0,
        contextRevision: tx.context.revision, availability: 'idle', activityId: null, runtime: null,
        pending: [], questions: [], includedContextRevision: null, recoveryRequired: false };
      await tx.emit('agent_created', { contextRevision: tx.context.revision, initialMessageId: record.taskId });
    }, { initialize: true });
  }

  async transaction(operation, { initialize = false } = {}) {
    await directory(this.directory);
    const lockPath = join(this.directory, 'transaction.lock'); const nonce = randomUUID();
    const started = Date.now(); let handle;
    while (!handle) {
      try { handle = await open(lockPath, 'wx', 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        requireValue(Date.now() - started < this.lockWaitMs, 'STATE_LOCKED', 'The agent transaction lock is still owned; it was preserved.');
        await delay(10);
      }
    }
    try {
      await handle.writeFile(JSON.stringify({ nonce, pid: process.pid })); await handle.sync();
      let head;
      try { head = await this.read(); }
      catch (error) { if (!initialize || error.code !== 'ENOENT') throw error; }
      const tx = { head, context: head ? await this.context(head.contextRevision) : null,
        emit: async (kind, data = {}) => {
          valid(Number.isSafeInteger(tx.head.eventSeq + 1));
          const event = { sequence: ++tx.head.eventSeq, kind, agentId: this.agentId,
            activityId: tx.head.activityId, at: new Date().toISOString(), ...data };
          await this.writer(join(this.directory, 'events', sequenceName(event.sequence)), JSON.stringify(event));
          return event;
        } };
      const beforeContext = head ? JSON.stringify(tx.context) : null;
      const result = await operation(tx);
      if (JSON.stringify(tx.context) !== beforeContext) {
        // Inclusion binding changes are metadata, not a new parent instruction revision.
        // Publish a fresh revision so readers of old frozen input retain exact evidence.
        if (head && tx.context.revision === head.contextRevision) tx.context.revision++;
        tx.head.contextRevision = tx.context.revision;
        await this.writer(join(this.directory, 'contexts', sequenceName(tx.context.revision)), JSON.stringify(tx.context));
      }
      await this.writer(join(this.directory, 'head.json'), JSON.stringify(tx.head));
      return result;
    } finally {
      await handle.close();
      const own = await json(lockPath);
      requireValue(own.nonce === nonce, 'RECOVERY_REQUIRED', 'The agent lock owner changed; the foreign lock was preserved.');
      await unlink(lockPath);
    }
  }

  async command(sequence) {
    const head = await this.read(); valid(Number.isSafeInteger(sequence) && sequence >= 1 && sequence <= head.commandSeq);
    const command = await json(join(this.directory, 'commands', sequenceName(sequence)));
    valid(command.sequence === sequence && UUID.test(command.messageId)); return command;
  }

  async accept(operation, input, { legacyInput = false } = {}) {
    const normalized = { operation, requestId: input.requestId, kind: input.kind ?? 'instruction', scope: input.scope ?? 'persistent',
      change: input.change ?? 'add', ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.expectedContextRevision !== undefined ? { expectedContextRevision: input.expectedContextRevision } : {}),
      ...(input.targetMessageIds ? { targetMessageIds: input.targetMessageIds } : {}), ...(input.replyTo ? { replyTo: input.replyTo } : {}) };
    const fingerprint = hash(normalized); const requestPath = join(this.directory, 'requests', hash(input.requestId) + '.json');
    return this.transaction(async tx => {
      let old;
      try { old = await json(requestPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (old && old.sequence <= tx.head.commandSeq) {
        const command = await this.command(old.sequence);
        if (command.requestId === input.requestId) {
          requireValue(command.fingerprint === fingerprint, 'REQUEST_ID_CONFLICT', 'This agent requestId belongs to a different operation or message.');
          return { ...command.receipt, duplicate: true };
        }
      }
      requireValue(tx.head.availability !== 'closed', 'AGENT_CLOSED', 'This agent is closed.');
      requireValue(!tx.head.recoveryRequired, 'RECOVERY_REQUIRED', 'Agent recovery must be confirmed before execution messages are accepted.');
      requireValue(operation !== 'followup' || tx.head.availability !== 'interrupting', 'INTERRUPT_PENDING', 'The current activity is still stopping.');
      if (input.replyTo) requireValue(tx.head.questions.some(item => item.id === input.replyTo && !item.resolved), 'UNKNOWN_QUESTION', 'replyTo must name an unresolved question from this agent.');
      const messageId = randomUUID();
      const { operation: _op, requestId: _req, replyTo: _reply, ...contextMessage } = normalized;
      try { tx.context = applyContextMessage(tx.context, { id: messageId, ...contextMessage }, { legacyInput }); }
      catch (error) {
        if (['CONTEXT_REVISION', 'CONTEXT_TARGET', 'CONTEXT_CONFLICT'].includes(error.code))
          throw new BridgeError('CONTEXT_CONFLICT', 'The context revision or explicit instruction target is no longer valid.', { validation: { phase: 'policy', issues: [{ path: [error.code === 'CONTEXT_TARGET' ? 'targetMessageIds' : 'expectedContextRevision'], code: 'invalid_value' }] } });
        throw error;
      }
      const receipt = { agentId: this.agentId, messageId, accepted: true, contextRevision: tx.context.revision,
        activityId: tx.head.activityId, disposition: tx.head.availability === 'running' && tx.head.runtime?.status === 'open' ? 'runtime_pending' : 'queued' };
      const command = { ...normalized, fingerprint, messageId, sequence: ++tx.head.commandSeq, receipt };
      await this.writer(join(this.directory, 'commands', sequenceName(command.sequence)), JSON.stringify(command));
      await this.writer(requestPath, JSON.stringify({ sequence: command.sequence }));
      tx.head.pending.push({ messageId, sequence: command.sequence, operation, contextRevision: tx.context.revision, delivery: 'accepted',
        ...(operation === 'followup' && tx.head.availability === 'interrupted' ? { resumeAfterInterrupt: tx.head.activityId } : {}) });
      if (input.replyTo) tx.head.questions.find(item => item.id === input.replyTo).resolved = true;
      await tx.emit('message_accepted', { messageId, operation, contextRevision: tx.context.revision });
      return receipt;
    });
  }

  async requestInterrupt(input) {
    const fingerprint = hash({ operation: 'interrupt', requestId: input.requestId });
    const requestPath = join(this.directory, 'requests', hash(input.requestId) + '.json');
    return this.transaction(async tx => {
      let old; try { old = await json(requestPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (old && old.sequence <= tx.head.commandSeq) {
        const command = await this.command(old.sequence);
        if (command.requestId === input.requestId) {
          requireValue(command.fingerprint === fingerprint, 'REQUEST_ID_CONFLICT', 'This requestId belongs to a different agent operation.');
          return { ...command.receipt, duplicate: true };
        }
      }
      const active = ['running', 'interrupting'].includes(tx.head.availability);
      const receipt = { agentId: this.agentId, activityId: tx.head.activityId,
        epoch: tx.head.runtime?.epoch ?? null, interruptRequested: active };
      const command = { operation: 'interrupt', requestId: input.requestId, fingerprint,
        sequence: ++tx.head.commandSeq, messageId: randomUUID(), receipt };
      await this.writer(join(this.directory, 'commands', sequenceName(command.sequence)), JSON.stringify(command));
      await this.writer(requestPath, JSON.stringify({ sequence: command.sequence }));
      if (active) {
        tx.head.availability = 'interrupting';
        tx.head.interrupt ??= { ...receipt, requestId: input.requestId, activityStopped: false, descendantsStopped: false };
        await tx.emit('interrupt_requested', { sessionEpoch: receipt.epoch });
      }
      return receipt;
    });
  }

  async startActivity(activityId) {
    return this.transaction(async tx => {
      requireValue(!tx.head.recoveryRequired && !tx.head.runtime, 'RECOVERY_REQUIRED', 'A previous runtime has not been reconciled.');
      tx.head.activityId = activityId; tx.head.availability = 'running'; tx.head.interrupt = null;
      await tx.emit('activity_started');
    });
  }

  async startEpoch(epoch, sessionId) {
    return this.transaction(async tx => {
      requireValue(tx.head.availability === 'running' && !tx.head.runtime, 'RECOVERY_REQUIRED', 'The agent cannot start another runtime.');
      tx.head.runtime = { epoch, sessionId, status: 'open' };
      // The SDK's first ordinary prompt wakes this epoch and assembles all
      // already committed context. Steering these again would start extra turns.
      for (const item of tx.head.pending) item.bootstrapEpoch = epoch;
      await tx.emit('runtime_started', { sessionEpoch: epoch });
    });
  }

  async runtime(epoch, operation) {
    return this.transaction(async tx => {
      requireValue(tx.head.runtime?.epoch === epoch, 'STALE_EPOCH', 'The runtime control command belongs to another epoch.');
      return operation(tx);
    });
  }

  async included(epoch, evidence) {
    return this.runtime(epoch, async tx => {
      const { instructionIds, materialIds } = evidence;
      tx.context = markContextIncluded(tx.context, [...instructionIds, ...materialIds], tx.head.activityId);
      tx.head.includedContextRevision = evidence.contextRevision;
      const included = tx.head.pending.filter(item => item.contextRevision <= evidence.contextRevision);
      tx.head.pending = tx.head.pending.filter(item => item.contextRevision > evidence.contextRevision);
      await tx.emit('input_included', { ...evidence, messageIds: included.map(item => item.messageId), semanticAcceptance: 'not_assessed' });
      return included;
    });
  }

  async finishEpoch(epoch, cleanup) {
    return this.runtime(epoch, async tx => {
      tx.head.recoveryRequired ||= cleanup !== 'confirmed';
      tx.head.runtime = null;
      await tx.emit('runtime_stopped', { sessionEpoch: epoch, runtimeCleanup: cleanup });
    });
  }

  async finishActivity(attempt) {
    return this.transaction(async tx => {
      requireValue(tx.head.activityId === `${this.agentId}:${attempt.number}`, 'STALE_ACTIVITY', 'An older activity cannot change the current agent state.');
      tx.context = finishContextActivity(tx.context, tx.head.activityId);
      tx.head.recoveryRequired ||= attempt.cleanup !== 'confirmed' || ['failed', 'cleanup_failed', 'state_write_failed', 'timed_out'].includes(attempt.status);
      tx.head.availability = attempt.status === 'cancelled' ? 'closed' : attempt.status === 'interrupted' ? 'interrupted'
        : tx.head.questions.some(item => !item.resolved) ? 'needs_input' : 'idle';
      await tx.emit('activity_finished', { status: attempt.status, cleanup: attempt.cleanup, attempt: attempt.number,
        result: { taskId: this.agentId, attempt: attempt.number }, parentAcceptance: 'not_assessed' });
    });
  }

  async workerMessage(epoch, { kind, text, replyTo }) {
    requireValue(['progress', 'question', 'reply'].includes(kind) && typeof text === 'string' && /\S/u.test(text)
      && [...text].length <= 8192, 'INVALID_ARGUMENT', 'Worker messages require a supported kind and 1–8192 nonblank Unicode code points.');
    return this.runtime(epoch, async tx => {
      if (replyTo) requireValue(tx.context.entries.some(item => item.id === replyTo), 'INVALID_ARGUMENT', 'replyTo must name a message in this agent.');
      const messageId = randomUUID();
      if (kind === 'question') tx.head.questions.push({ id: messageId, resolved: false });
      const event = await tx.emit(kind === 'question' ? 'question_open' : 'worker_message', { messageId, messageKind: kind, text, ...(replyTo ? { replyTo } : {}) });
      return { messageId, sequence: event.sequence, accepted: true, parentAcceptance: 'not_assessed' };
    });
  }

  cursor(head, sequence = head.eventSeq) {
    return Buffer.from(JSON.stringify({ v: 1, a: this.agentId, g: head.generation, s: sequence })).toString('base64url');
  }

  async events(afterCursor, limit = 32) {
    const head = await this.read(); let after = 0;
    if (afterCursor) {
      let value; try { value = JSON.parse(Buffer.from(afterCursor, 'base64url').toString()); } catch { /* Safe error below. */ }
      requireValue(value?.v === 1 && value.a === this.agentId && value.g === head.generation
        && Number.isSafeInteger(value.s) && value.s >= 0, 'INVALID_CURSOR', 'The event cursor is not for this agent generation.');
      requireValue(value.s <= head.eventSeq, 'CURSOR_GAP', 'The cursor exceeds retained event history.'); after = value.s;
    }
    const events = [];
    for (let sequence = after + 1; sequence <= Math.min(head.eventSeq, after + limit); sequence++) {
      let event;
      try { event = await json(join(this.directory, 'events', sequenceName(sequence))); }
      catch (error) { if (error.code === 'ENOENT') throw new BridgeError('CURSOR_GAP', 'A required event segment is unavailable.'); throw error; }
      valid(event.sequence === sequence && event.agentId === this.agentId); events.push(event);
    }
    const last = events.at(-1)?.sequence ?? after;
    return { events, cursor: this.cursor(head, last), hasMore: last < head.eventSeq, head };
  }
}
