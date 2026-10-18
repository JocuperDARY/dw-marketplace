// Test-only model stream. It never dispatches to a provider adapter.
export const name = 'offline-checkpoint-model';
export const inject = ['llm'];
export function apply(ctx) {
  let calls = 0;
  ctx.on('llm/stream', async function* (options) {
    calls++;
    const continued = JSON.stringify(options.messages).includes('Previous progress data');
    let block;
    if (!continued && calls === 1) {
      if (!options.tools.some(tool => tool.name === 'bridge_read')) throw new Error('Expected work-stage file tool');
      block = { type: 'tool-call', id: 'offline-read', name: 'bridge_read', arguments: JSON.stringify({ path: 'input.txt' }) };
    } else {
      if (!continued && (!JSON.stringify([options.system, options.messages]).includes('Return the checkpoint JSON now') || (options.tools?.length ?? 0) !== 0)) throw new Error('Checkpoint reserve was not enforced');
      block = { type: 'text', text: JSON.stringify({ state: continued ? 'completed' : 'checkpoint', summary: continued ? 'Finished using saved evidence' : 'Read input.txt: offline evidence', nextSteps: continued ? '' : 'Finish the summary' }) };
    }
    yield { type: 'block-start', index: 0, blockType: block.type };
    yield { type: 'block-end', index: 0, block };
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 } };
    yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } };
  });
}
