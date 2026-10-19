// Local fake adapter: exercises SDK requests, never invokes a network provider.
export const name = 'offline-delivery-model';
export const inject = ['llm'];
export function apply(ctx) {
  ctx.on('llm/stream', async function* (options) {
    const prompt = JSON.stringify(options.messages);
    const recovery = prompt.includes('Text-only recovery after');
    const reasoningOnly = prompt.includes('fixture-reasoning-only');
    if (options.tools?.length) throw new Error('Delivery fixture must remain tool-free');
    if (!prompt.includes('Strict output format')) throw new Error('Output contract did not reach SDK');
    if (options.reasoningEffort !== (recovery || !reasoningOnly ? 'off' : 'low')) throw new Error('Wrong work/recovery effort');
    const report = prompt.includes('fixture-report');
    if (report && !prompt.includes('Report evidence contract')) throw new Error('Report contract did not reach SDK');
    const deliverable = JSON.stringify(report
      ? { facts: [{ id: 'seconds', kind: 'observation', value: 180, unit: 's', source: 'plan.json:limits.seconds' }], prose: 'Measured 180 seconds.' }
      : { draft: 'bounded facts', path: 'C:\\fixture\\file.json' });
    const summary = recovery || report ? deliverable : 'Read exactly the inputs.\n\n' + deliverable;
    const final = prompt.includes('Budget orchestration is enabled') ? JSON.stringify({ state: 'completed', summary, nextSteps: '' }) : summary;
    const block = reasoningOnly && !recovery ? { type: 'reasoning', text: 'private-delivery-reasoning-marker' } : { type: 'text', text: final };
    yield { type: 'block-start', index: 0, blockType: block.type };
    yield { type: 'block-end', index: 0, block };
    const outputTokens = reasoningOnly && !recovery ? options.maxTokens : 100;
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens, totalTokens: outputTokens + 100 } };
    yield { type: 'finish', reason: { kind: reasoningOnly && !recovery ? 'max-tokens' : 'stop' } };
  });
}
