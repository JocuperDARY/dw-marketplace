// Test-only model stream. It never dispatches to a provider adapter.
export const name = 'offline-checkpoint-model';
export const inject = ['llm'];
export function apply(ctx) {
  let calls = 0;
  ctx.on('llm/stream', async function* (options) {
    calls++;
    const messages = JSON.stringify(options.messages);
    const continued = messages.includes('Previous progress data');
    const truncate = messages.includes('offline-truncate');
    const recovery = messages.includes('Text-only recovery after a max-tokens stop');
    let block;
    if (recovery) {
      if (options.reasoningEffort !== 'off' || options.tools?.length) throw new Error('Recovery must be off and tool-free');
      block = { type: 'text', text: JSON.stringify({ state: 'completed', summary: 'Finished recovery from supplied evidence', nextSteps: '' }) };
    } else if (truncate) {
      if (messages.includes('reasoning-only') && options.reasoningEffort !== 'high') throw new Error('Expected explicit high-effort truncation fixture');
      block = messages.includes('reasoning-only') ? { type: 'reasoning', text: 'private-reasoning-marker' } : { type: 'text', text: '{"state":"completed","summary":"partial' };
    } else if (!continued && calls === 1) {
      if (!options.tools.some(tool => tool.name === 'bridge_read')) throw new Error('Expected work-stage file tool');
      block = { type: 'tool-call', id: 'offline-read', name: 'bridge_read', arguments: JSON.stringify({ path: 'input.txt' }) };
    } else {
      if (!continued && (!JSON.stringify([options.system, options.messages]).includes('Return the checkpoint JSON now') || (options.tools?.length ?? 0) !== 0)) throw new Error('Checkpoint reserve was not enforced');
      if (!continued && options.reasoningEffort !== 'off') throw new Error('Checkpoint reasoning must be off');
      block = { type: 'text', text: JSON.stringify({ state: continued ? 'completed' : 'checkpoint', summary: continued ? 'Finished using saved evidence' : 'Read input.txt: offline evidence', nextSteps: continued ? '' : 'Finish the summary' }) };
    }
    yield { type: 'block-start', index: 0, blockType: block.type };
    yield { type: 'block-end', index: 0, block };
    const outputTokens = truncate && !recovery ? options.maxTokens : 100;
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens, totalTokens: outputTokens + 100 } };
    yield { type: 'finish', reason: { kind: truncate && !recovery ? 'max-tokens' : block.type === 'tool-call' ? 'tool-calls' : 'stop' } };
  });
}
