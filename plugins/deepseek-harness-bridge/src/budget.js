import { readFile, writeFile, rename } from 'node:fs/promises';

/** Runs inside the worker, before the official adapter is allowed to open a stream. */
export async function installBudget(ctx, config) {
  const receipt = { nonce: config.nonce, modelRequests: 0, maxRequestBytesObserved: 0, calls: [], denied: null };
  let publication = Promise.resolve();
  const persist = () => {
    const content = JSON.stringify(receipt);
    publication = publication.then(async () => {
      const temporary = `${config.budgetPath}.tmp`;
      await writeFile(temporary, content, { mode: 0o600 });
      await rename(temporary, config.budgetPath);
    });
    return publication;
  };
  await persist();
  ctx.on('llm/stream', async function* (options, next) {
    const requestBytes = Buffer.byteLength(JSON.stringify({ messages: options.messages, system: options.system, tools: options.tools, toolHistory: options.toolHistory }));
    let denial;
    if (config.armedPath) {
      try { if ((await readFile(config.armedPath, 'utf8')) !== config.nonce) denial = 'NOT_ARMED'; }
      catch { denial = 'NOT_ARMED'; }
    }
    if (denial) { /* Initialization is never allowed to spend. */ }
    else if (options.provider !== 'deepseek-official' || options.model !== 'deepseek-flash' || options.reasoningEffort !== config.effort) denial = 'ROUTE_DENIED';
    else if (receipt.modelRequests >= config.maxModelRequests) denial = 'MODEL_REQUEST_LIMIT';
    else if (!Number.isInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > config.maxTokens) denial = 'OUTPUT_TOKEN_LIMIT';
    else if (requestBytes > config.maxRequestBytes) denial = 'REQUEST_SIZE_LIMIT';
    else if (options.messages?.some(message => message.content?.some(block => !['text', 'reasoning', 'tool-call', 'tool-result', 'tool-use', 'tool_use', 'tool_result'].includes(block.type)))) denial = 'NON_TEXT_REQUEST';
    if (denial) {
      receipt.denied = denial;
      await persist();
      throw new Error(`Bridge request blocked: ${denial}`);
    }
    receipt.modelRequests++;
    receipt.maxRequestBytesObserved = Math.max(receipt.maxRequestBytesObserved, requestBytes);
    const call = { number: receipt.modelRequests, requestBytes, usage: null, finished: false };
    receipt.calls.push(call);
    await persist();
    try {
      for await (const chunk of next()) {
        if (chunk.type === 'usage') {
          const usage = Object.fromEntries(['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']
            .filter(key => Number.isFinite(chunk.usage?.[key]) && chunk.usage[key] >= 0).map(key => [key, chunk.usage[key]]));
          call.usage = usage;
        }
        if (chunk.type === 'finish') call.finished = true;
        yield chunk;
      }
    } finally { await persist(); }
  });
}
