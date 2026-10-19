export const name = 'offline-native-compaction-model';
export const inject = ['llm'];

// The real SDK owns history replacement. This fixture supplies only model output.
export function apply(ctx) {
  let work = 0;
  ctx.on('llm/stream', async function* (options) {
    const summary = options.purpose === 'compaction';
    const tool = !summary && ++work <= 4;
    const block = tool ? { type: 'tool-call', id: `read-${work}`, name: 'bridge_read', arguments: JSON.stringify({ path: 'input.txt' }) }
      : { type: 'text', text: summary ? 'The assigned input was read. Continue the remaining fixture reads, then report NATIVE_COMPACTION_DONE.' : 'NATIVE_COMPACTION_DONE' };
    yield { type: 'block-start', index: 0, blockType: block.type };
    yield { type: 'block-end', index: 0, block };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } };
    yield { type: 'finish', reason: { kind: tool ? 'tool-calls' : 'stop' } };
  });
}
