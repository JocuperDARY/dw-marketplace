import { writeFile } from 'node:fs/promises';

// Fixed local responses drive the real SDK tools. No provider is contacted.
export const name = 'offline-native-work-model';
export const inject = ['llm'];
export function apply(ctx, config) {
  let index = 0;
  const requests = [];
  ctx.on('llm/stream', async function* (options) {
    const messages = JSON.stringify(options.messages);
    const resumed = messages.includes('CAMPAIGN_RESUME_WORK');
    requests.push({ maxTokens: options.maxTokens, effort: options.reasoningEffort,
      tools: options.tools?.map(tool => tool.name), messages: options.messages });
    await writeFile(config.receipt, JSON.stringify(requests, null, 2));
    const step = (resumed ? config.resumeSteps : config.steps)?.[index++];
    let args = step?.args;
    if (args?.job_id === '$latestJob') {
      const matches = [...messages.matchAll(/started background job ([a-zA-Z0-9_-]+)/g)];
      if (!matches.length) throw new Error('The previous tool did not return a background job id.');
      args = { ...args, job_id: matches.at(-1)[1] };
    }
    const block = step
      ? { type: 'tool-call', id: `work-${resumed ? 'resume' : 'start'}-${index}`, name: step.name, arguments: JSON.stringify(args) }
      : { type: 'text', text: 'OFFLINE_WORK_COMPLETE: parent must inspect actual artifacts and tool results.' };
    yield { type: 'block-start', index: 0, blockType: block.type };
    yield { type: 'block-end', index: 0, block };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } };
    yield { type: 'finish', reason: { kind: step ? 'tool-calls' : 'stop' } };
  });
}
