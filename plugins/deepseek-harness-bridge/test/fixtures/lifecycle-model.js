// Offline SDK fixture; the provider is never called.
import { readFileSync } from 'node:fs';
const source = JSON.parse(readFileSync(new URL('./lifecycle-failure.json', import.meta.url), 'utf8'));
export const name = 'offline-lifecycle-model';
export const inject = ['llm'];
export function apply(ctx) {
  ctx.on('llm/stream', async function* (options) {
    if (options.reasoningEffort !== 'off' || options.maxTokens !== 2048 || options.tools?.length) throw new Error('Lifecycle request limits changed');
    if (!JSON.stringify(options.messages).includes('Lifecycle consistency contract')) throw new Error('Lifecycle contract did not reach SDK');
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: source.text } };
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
}
