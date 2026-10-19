// Test-only wrong answer with complete structure; never calls a provider adapter.
export const name = 'offline-verification-model';
export const inject = ['llm'];
export function apply(ctx) {
  ctx.on('llm/stream', async function* (options) {
    if (options.reasoningEffort !== 'high' || options.maxTokens !== 4096 || options.tools?.length) throw new Error('Verification request limits changed');
    if (!JSON.stringify(options.messages).includes('Verification delivery contract')) throw new Error('Delivery contract did not reach SDK');
    // Check the actual SDK request carries the generic evidence instructions.
    for (const instruction of ['claims under review', 'For every asserted or newly added prerequisite',
      'A valid locator alone, like a known rule ID, does not establish that the text supports the conclusion.',
      'numerical instance', 'compound claim']) {
      if (!JSON.stringify(options.messages).includes(instruction)) throw new Error(`Missing evidence instruction: ${instruction}`);
    }
    const answer = {
      cases: [{ id: 'C06', classification: 'audit', ruleIds: ['R1'], basis: 'Not a fixed root reader, therefore audit.', expected: 'STOP', uncertainty: 'none' }],
      checks: [], uncertainty: 'No code executed.', nextAction: 'Parent must verify the classification.',
    };
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(answer) } };
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
}
