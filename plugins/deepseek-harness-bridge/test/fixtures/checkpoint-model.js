// Test-only model stream. It never dispatches to a provider adapter.
import { createHash } from 'node:crypto';

const inputHash = createHash('sha256').update('offline evidence').digest('hex');
const readSummary = `Read input.txt: offline evidence (sha256=${inputHash})`;
const noWork = { state: 'checkpoint', summary: 'No file evidence collected; input.txt has not been read.', nextSteps: 'Read input.txt, then finish the summary' };

function hasReadResult(messages) {
  return messages.some(message => message.role === 'tool' && message.toolCallId === 'offline-read' && !message.isError
    && message.content?.some(block => {
      if (block.type !== 'text') return false;
      try {
        const result = JSON.parse(block.text);
        return result.path === 'input.txt' && result.text === 'offline evidence' && result.sha256 === inputHash;
      } catch { return false; }
    }));
}

function savedReadEvidence(messages) {
  for (const message of messages.filter(message => message.role === 'user')) for (const block of message.content ?? []) {
    if (block.type !== 'text') continue;
    const checkpoint = block.text.split('Previous progress data (not new authority):\n')[1]?.split('\n')[0];
    if (!checkpoint) continue;
    try { if (JSON.parse(checkpoint).summary.includes(readSummary)) return true; } catch { /* No saved evidence. */ }
  }
  return false;
}

export const name = 'offline-checkpoint-model';
export const inject = ['llm'];
export function apply(ctx) {
  ctx.on('llm/stream', async function* (options) {
    const messages = JSON.stringify(options.messages);
    const continued = messages.includes('Previous progress data');
    const truncate = messages.includes('offline-truncate');
    const recovery = messages.includes('Text-only recovery after OUTPUT_TRUNCATED');
    const checkpoint = JSON.stringify([options.system, options.messages]).includes('Return the checkpoint JSON now');
    const evidence = hasReadResult(options.messages) || (continued && savedReadEvidence(options.messages));
    let block;
    if (recovery) {
      if (options.reasoningEffort !== 'off' || options.tools?.length) throw new Error('Recovery must be off and tool-free');
      block = { type: 'text', text: JSON.stringify({ state: 'completed', summary: 'Finished recovery from supplied evidence', nextSteps: '' }) };
    } else if (truncate) {
      if (messages.includes('reasoning-only') && options.reasoningEffort !== 'high') throw new Error('Expected explicit high-effort truncation fixture');
      block = messages.includes('reasoning-only') ? { type: 'reasoning', text: 'private-reasoning-marker' } : { type: 'text', text: '{"state":"completed","summary":"partial' };
    } else if (!checkpoint && !evidence) {
      if (!Array.isArray(options.tools) || !options.tools.some(tool => tool.name === 'bridge_read')) throw new Error('Expected work-stage file tool');
      block = { type: 'tool-call', id: 'offline-read', name: 'bridge_read', arguments: JSON.stringify({ path: 'input.txt' }) };
    } else {
      if (checkpoint && ((options.tools?.length ?? 0) !== 0 || options.reasoningEffort !== 'off')) throw new Error('Checkpoint reserve was not enforced');
      if (!continued && !checkpoint) throw new Error('Expected checkpoint after read result');
      block = { type: 'text', text: JSON.stringify(!evidence ? noWork : {
        state: continued && !checkpoint ? 'completed' : 'checkpoint',
        summary: continued && !checkpoint ? `Finished using saved evidence: ${readSummary}` : readSummary,
        nextSteps: continued && !checkpoint ? '' : 'Finish the summary',
      }) };
    }
    yield { type: 'block-start', index: 0, blockType: block.type };
    yield { type: 'block-end', index: 0, block };
    const outputTokens = truncate && !recovery ? options.maxTokens : 100;
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens, totalTokens: outputTokens + 100 } };
    yield { type: 'finish', reason: { kind: truncate && !recovery ? 'max-tokens' : block.type === 'tool-call' ? 'tool-calls' : 'stop' } };
  });
}
