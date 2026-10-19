import { writeFile } from 'node:fs/promises';

// Test only: scripted streams through the real SDK; never calls a provider.
export const name = 'offline-native-probe-model';
export const inject = ['llm'];
export function apply(ctx, config) {
  let index = 0;
  const requests = [];
  ctx.on('llm/stream', async function* (options) {
    requests.push({ maxTokens: options.maxTokens ?? null, reasoningEffort: options.reasoningEffort,
      tools: options.tools?.map(tool => tool.name), messages: options.messages });
    await writeFile(config.receipt, JSON.stringify(requests, null, 2));
    const step = config.steps[index++];
    const block = step ? { type: 'tool-call', id: `native-probe-${index}`, name: step.name, arguments: JSON.stringify(step.args) }
      : { type: 'text', text: 'Offline native fixture finished; inspect tool outcomes independently.' };
    yield { type: 'block-start', index: 0, blockType: block.type };
    yield { type: 'block-end', index: 0, block };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } };
    yield { type: 'finish', reason: { kind: step ? 'tool-calls' : 'stop' } };
  });
}
