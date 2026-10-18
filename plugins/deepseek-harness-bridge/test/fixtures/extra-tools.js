import { defineTool } from '@deepseek-ai/dsh-tools';
import { echoValue } from './echo-value.js';
export const name = 'bridge-test-echo';
export const inject = ['tools'];
export async function apply(ctx, config = {}) {
  if (config.delayMs) await new Promise(resolve => setTimeout(resolve, config.delayMs));
  ctx.tools.register(defineTool({ name: 'sample_echo', description: 'Offline fixture echo.',
    parameters: { text: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: echoValue }));
}
