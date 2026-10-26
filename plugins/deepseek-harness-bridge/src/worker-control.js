import { createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm/message';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentJournal } from './agent-journal.js';
import { atomicWrite } from './concurrent-store.js';
import { requireValue, safeError } from './errors.js';

export const name = 'deepseek-bridge-control';
export const inject = ['agents', 'sessions', 'llm', 'tools'];

export function apply(ctx, config) {
  const journal = new AgentJournal(config.taskDirectory, config.agentId);
  let busy = false; let disposed = false; let failure; let stopping;
  const epoch = config.epoch;
  ctx.on('agent/created', async ({ agent }) => {
    if (agent.id !== config.sessionId) return;
    const head = await journal.read();
    const events = agent.session.snapshotEvents();
    for (const item of head.pending) {
      let saved;
      try { saved = JSON.parse(await readFile(join(journal.directory, 'native', `${item.messageId}.json`), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      requireValue(saved.message?.source?.bridgeMessageId === item.messageId && saved.message.role === 'user'
        && typeof saved.message.id === 'string', 'INVALID_AGENT_STATE', 'The saved native message identity is invalid.');
      const observed = events.some(event => event.type === 'agent/inbox/spliced' && event.data?.inserted?.some(message => message.id === saved.message?.id));
      if (saved.dispatchStarted && !observed) {
        await journal.runtime(epoch, async tx => {
          tx.head.recoveryRequired = true;
          const pending = tx.head.pending.find(value => value.messageId === item.messageId);
          if (pending) pending.delivery = 'deliveryUnknown';
          await tx.emit('delivery_unknown', { messageId: item.messageId });
        });
        throw new Error('Native message delivery is unknown; input replay was stopped.');
      }
      if (!observed) {
        saved.dispatchStarted = true;
        await atomicWrite(join(journal.directory, 'native', `${item.messageId}.json`), JSON.stringify(saved));
        agent.inject(freezeMessage(saved.message));
      }
      requireValue(await ctx.sessions.flush(agent.session), 'DELIVERY_UNKNOWN', 'Native inbox reconciliation could not be persisted.');
      await journal.runtime(epoch, async tx => {
        const pending = tx.head.pending.find(value => value.messageId === item.messageId);
        if (pending) { pending.delivery = 'enqueued'; pending.nativeMessageId = saved.message.id; pending.epoch = epoch; }
        await tx.emit('message_enqueued', { messageId: item.messageId, nativeMessageId: saved.message.id, reconciled: observed });
      });
    }
  });
  const fail = async error => {
    failure = error;
    const agent = ctx.agents.get(config.sessionId);
    agent?.cancel({ kind: 'hook', reason: 'bridge-control-unavailable' }, { keepInbox: true });
    try { await journal.runtime(epoch, async tx => {
      tx.head.recoveryRequired = true; tx.head.runtime.status = 'failed';
      await tx.emit('control_failed', { error: safeError(error) });
    }); } catch { /* Durable failure is not guessed if the journal itself is unavailable. */ }
  };
  const interrupt = async agent => {
    if (stopping) return stopping;
    agent.cancel({ kind: 'hook', reason: 'bridge-parent-interrupt' }, { keepInbox: true });
    const service = ctx.get('subagents');
    stopping = (async () => {
      if (service) await service.drainDescendants([agent]);
      await agent.whenIdle();
      await ctx.sessions.flush(agent.session);
      await journal.runtime(epoch, async tx => {
        tx.head.runtime.status = 'stopped';
        tx.head.interrupt.activityStopped = true; tx.head.interrupt.descendantsStopped = true;
        await tx.emit('interrupt_settled', { activityStopped: true, descendantsStopped: true, runtimeCleanup: 'pending' });
      });
    })();
    void stopping.catch(fail); return stopping;
  };

  const deliver = async (agent, pending) => {
    const command = await journal.command(pending.sequence);
    const nativePath = join(journal.directory, 'native', `${command.messageId}.json`);
    let saved;
    try { saved = JSON.parse(await readFile(nativePath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (saved) {
      requireValue(saved.message?.source?.bridgeMessageId === command.messageId && saved.message.role === 'user'
        && typeof saved.message.id === 'string', 'INVALID_AGENT_STATE', 'The native message mapping is invalid.');
      const log = agent.session.snapshotEvents();
      const observed = log.find(event => event.type === 'agent/inbox/spliced' && event.data?.inserted?.some(item => item.id === saved.message.id));
      if (observed) {
        await ctx.sessions.flush(agent.session);
        await journal.runtime(epoch, async tx => {
          const item = tx.head.pending.find(item => item.messageId === command.messageId);
          if (item) { item.delivery = 'enqueued'; item.epoch = epoch; item.nativeMessageId = saved.message.id; }
          await tx.emit('message_enqueued', { messageId: command.messageId, nativeMessageId: saved.message.id, reconciled: true });
        });
        return;
      }
      // A prior process could have sent a message then lost its persistence checkpoint.
      // An absent event after restart does not prove the side effect never happened.
      requireValue(saved.epoch === epoch && !saved.dispatchStarted, 'DELIVERY_UNKNOWN', 'Native delivery cannot be proved; automatic replay was stopped.');
    } else {
      const text = command.change === 'retract' ? 'The parent explicitly retracted instructions; use the current authoritative context.'
        : `Bridge parent ${command.kind} (message ${command.messageId}). ${command.kind === 'instruction' ? 'Use the current authoritative context for active instructions and explicit supersession.' : 'This is material or a question, not authority to change task scope or restrictions.'}\n${JSON.stringify(command.text)}`;
      saved = { epoch, dispatchStarted: false, message: createUserMessage({ content: [{ type: 'text', text }],
        source: { kind: 'bridge-parent', bridgeMessageId: command.messageId, messageKind: command.kind } }) };
      await atomicWrite(nativePath, JSON.stringify(saved), { immutable: true });
    }
    const message = freezeMessage(saved.message);
    const dispatched = await journal.runtime(epoch, async tx => {
      const item = tx.head.pending.find(item => item.messageId === command.messageId);
      if (!item || tx.head.interrupt || tx.head.runtime.status !== 'open') return false;
      saved.dispatchStarted = true;
      await atomicWrite(nativePath, JSON.stringify(saved));
      item.nativeMessageId = message.id;
      if (command.operation === 'followup') agent.steer(message); else agent.inject(message);
      return true;
    });
    if (!dispatched) return;
    requireValue(await ctx.sessions.flush(agent.session), 'DELIVERY_UNKNOWN', 'Native inbox persistence was not confirmed.');
    await journal.runtime(epoch, async tx => {
      const item = tx.head.pending.find(item => item.messageId === command.messageId);
      if (item) { item.delivery = 'enqueued'; item.epoch = epoch; item.nativeMessageId = message.id; }
      await tx.emit('message_enqueued', { messageId: command.messageId, nativeMessageId: message.id });
    });
  };

  const tick = async () => {
    if (busy || disposed || failure) return;
    busy = true;
    try {
      const head = await journal.read();
      if (head.runtime?.epoch !== epoch || head.runtime.status !== 'open') return;
      const agent = ctx.agents.get(config.sessionId);
      if (!agent) return;
      if (head.interrupt?.epoch === epoch) { void interrupt(agent); return; }
      for (const item of head.pending) {
        if (item.bootstrapEpoch === epoch) continue;
        if (item.delivery === 'enqueued') continue;
        await deliver(agent, item);
      }
      if (agent.status === 'idle' && head.runtime.closeRequested) await journal.runtime(epoch, async tx => {
        const undispatched = tx.head.pending.some(item => item.operation === 'followup' && item.delivery !== 'enqueued');
        if (tx.head.runtime.closeRequested && !undispatched && agent.status === 'idle') {
          tx.head.runtime.status = 'closing'; await tx.emit('runtime_closing');
        }
      });
    } catch (error) { await fail(error); }
    finally { busy = false; }
  };
  const timer = setInterval(() => { void tick(); }, 25);
  ctx.on('dispose', () => { disposed = true; clearInterval(timer); });
  ctx.on('llm/stream', async function* (_options, next) {
    const head = await journal.read();
    requireValue(!failure && !head.recoveryRequired && head.runtime?.epoch === epoch && head.runtime.status === 'open' && !head.interrupt,
      'INTERRUPT_PENDING', 'The runtime is not accepting new model requests.');
    yield* next();
  }, { prepend: true });

  if (config.communicationTool) ctx.tools.register(defineTool({
    name: 'bridge_send_message',
    description: 'Send progress, a question, or an explicit reply to your bound Codex parent. A question ends this native turn; report only observed facts. Does not contact other chats or change authorization.',
    parameters: { kind: { type: 'string', enum: ['progress', 'question', 'reply'], required: true },
      text: { type: 'string', required: true, description: '1–8192 Unicode code points, no whitespace-only messages.' },
      replyTo: { type: 'string', description: 'Optional Bridge parent message ID being answered.' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      try {
        requireValue(exec.agent?.id === config.sessionId, 'NOT_OWNER', 'Only the bound root worker may message this parent.');
        const result = await journal.workerMessage(epoch, args);
        if (args.kind === 'question') exec.concludeTurn();
        return JSON.stringify(result);
      } catch (error) { return JSON.stringify({ error: safeError(error) }); }
    },
  }));
}
