import { createHash } from 'node:crypto';
import { contextSnapshot, renderTaskContext, validateTaskContext } from './task-context.js';
import { writeAtomicReceipt } from './atomic-receipt.js';
import { AgentJournal } from './agent-journal.js';

export const name = 'deepseek-bridge-context';
export const inject = ['systemPrompt', 'llm', 'agents'];

export function apply(ctx, config) {
  const context = validateTaskContext(config.context);
  const journal = config.agent ? new AgentJournal(config.agent.taskDirectory, config.agent.agentId) : null;
  const receipts = [];
  ctx.systemPrompt.context({ name: 'bridge:parent-context', order: 130, required: true, interpolate: false,
    text: input => input.agent?.id === config.sessionId ? renderTaskContext(journal ? journal.contextSync() : context) : '' });
  ctx.on('llm/stream', async function* (options, next) {
    if (options.sessionId === config.sessionId && options.purpose !== 'compaction') {
      const sections = options.messages?.flatMap(message => message.source?.kind === 'runtime-context' ? message.source.sections ?? [] : []) ?? [];
      const frozen = sections.findLast(section => section.name === 'bridge:parent-context');
      const revision = Number(frozen?.text.match(/^TASK CONTEXT revision=(\d+)/)?.[1]);
      const loaded = journal ? await journal.context(revision) : context;
      const rendered = renderTaskContext(loaded); const snapshot = contextSnapshot(loaded);
      const included = options.messages?.some(message => message.content?.some(block => block.type === 'text' && block.text.includes(rendered)));
      if (!included) throw new Error('Bridge required parent context is absent from the frozen model input.');
      const inputSha256 = createHash('sha256').update(JSON.stringify(options.messages)).digest('hex');
      receipts.push({ number: receipts.length + 1, contextRevision: snapshot.revision, inputSha256,
        instructionIds: snapshot.activeInstructions.map(item => item.id), materialIds: snapshot.materials.map(item => item.id) });
      if (journal) {
        const consumed = await journal.included(config.agent.epoch, receipts.at(-1));
        const agent = ctx.agents.get(config.sessionId);
        // A dynamic snapshot may include a message before its inbox item is
        // claimed. Remove only that already-proven input, avoiding an extra wake.
        for (const item of consumed) if (item.nativeMessageId) agent?.inbox.remove(item.nativeMessageId);
      }
      await writeAtomicReceipt(config.receiptPath, JSON.stringify({ nonce: config.nonce, sessionId: config.sessionId,
        source: 'frozen-request-before-adapter', semanticAcceptance: 'not_assessed', requests: receipts }));
    }
    yield* next();
  }, { prepend: true });
}
