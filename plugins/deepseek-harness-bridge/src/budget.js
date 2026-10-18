import { readFile, writeFile, rename } from 'node:fs/promises';
import { CHECKPOINT_PROMPT } from './orchestration.js';

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
  const readToolCalls = async () => {
    let toolCalls = 0;
    if (config.checkpoint && config.toolReceiptPath) {
      const tools = JSON.parse(await readFile(config.toolReceiptPath, 'utf8'));
      if (tools.nonce !== config.nonce || !Number.isSafeInteger(tools.toolCalls) || tools.toolCalls < 0) throw new Error('Invalid tool accounting receipt');
      toolCalls = tools.toolCalls;
    }
    return toolCalls;
  };
  let checkpointPrepared = !!config.checkpoint?.forced;
  const checkpointTokens = config.checkpoint?.maxTokens ?? config.maxTokens;
  const snapshot = (toolCalls, includeDeadline = true) => {
    const chargedOutput = receipt.calls.reduce((sum, call) => sum + (call.finished && Number.isSafeInteger(call.usage?.outputTokens) && call.usage.outputTokens >= 0 && call.usage.outputTokens <= call.reservedOutputTokens ? call.usage.outputTokens : call.reservedOutputTokens), 0);
    const remainingOutput = (config.maxOutputTokens ?? Infinity) - chargedOutput;
    return { remainingOutput, checkpoint: !!config.checkpoint && (receipt.modelRequests >= config.maxModelRequests - 1 || remainingOutput < checkpointTokens + 256 || (includeDeadline && Date.now() >= config.checkpoint.softDeadline) || (config.maxToolCalls > 0 && toolCalls >= config.maxToolCalls)) };
  };
  // This SDK waterfall precedes request freezing and adapter preparation. Do not
  // mutate llm/stream options, or change the route after the adapter was selected.
  if (config.checkpoint) ctx.on('agent/request', async (_request, next) => {
    const proposal = await next();
    const { remainingOutput } = snapshot(await readToolCalls(), false);
    return { ...proposal, provider: 'deepseek-official', model: 'deepseek-flash',
      reasoningEffort: checkpointPrepared ? 'off' : config.effort,
      maxTokens: Math.max(1, Math.min(checkpointPrepared ? checkpointTokens : config.maxTokens,
        remainingOutput - (checkpointPrepared ? 0 : checkpointTokens))) };
  }, { prepend: true });
  if (config.checkpoint) ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
    const result = await next();
    const { checkpoint } = snapshot(await readToolCalls());
    checkpointPrepared ||= checkpoint;
    if (checkpointPrepared) result.sections.push({ name: 'bridge-checkpoint', text: CHECKPOINT_PROMPT, interpolate: false });
    if (checkpointPrepared || config.maxToolCalls === 0) result.tools = [];
    return result;
  }, { prepend: true });
  ctx.on('llm/stream', async function* (options, next) {
    let denial;
    if (config.armedPath) {
      try { if ((await readFile(config.armedPath, 'utf8')) !== config.nonce) denial = 'NOT_ARMED'; }
      catch { denial = 'NOT_ARMED'; }
    }
    // Calculate reservations after the last await; concurrent auxiliary calls
    // must see earlier reservations before either adapter can be dispatched.
    const { remainingOutput, checkpoint: resourceCheckpoint } = snapshot(await readToolCalls(), false);
    // A soft deadline crossing after prompt assembly applies on the next
    // assembly boundary; it must not invalidate an already prepared request.
    const checkpoint = checkpointPrepared || resourceCheckpoint;
    if (denial) { /* Initialization is never allowed to spend. */ }
    else if (options.provider !== 'deepseek-official' || options.model !== 'deepseek-flash' || options.reasoningEffort !== (checkpoint ? 'off' : config.effort)) denial = 'ROUTE_DENIED';
    else if (receipt.modelRequests >= config.maxModelRequests) denial = 'MODEL_REQUEST_LIMIT';
    else if (receipt.checkpointRequested) denial = 'CHECKPOINT_CLOSED';
    else if (!Number.isInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > (checkpoint ? checkpointTokens : config.maxTokens)) denial = 'OUTPUT_TOKEN_LIMIT';
    else if (remainingOutput < options.maxTokens) denial = 'TOTAL_OUTPUT_LIMIT';
    else if (config.checkpoint && !checkpoint && remainingOutput - options.maxTokens < checkpointTokens) denial = 'CHECKPOINT_RESERVE';
    else if (options.messages?.some(message => message.content?.some(block => !['text', 'reasoning', 'tool-call', 'tool-result', 'tool-use', 'tool_use', 'tool_result', 'tool-addition', 'tool-removal'].includes(block.type)))) denial = 'NON_TEXT_REQUEST';
    // LOOP requests are deep-frozen. Changes must be assembled into durable session
    // input above, never applied to a stream request after preparation.
    if (!denial && checkpoint && ((options.tools?.length ?? 0) > 0 || !JSON.stringify([options.system, options.messages]).includes('Stage allowance is nearly exhausted.'))) denial = 'CHECKPOINT_REQUIRED';
    const requestBytes = Buffer.byteLength(JSON.stringify({ messages: options.messages, system: options.system, tools: options.tools, toolHistory: options.toolHistory }));
    if (!denial && requestBytes > config.maxRequestBytes) denial = 'REQUEST_SIZE_LIMIT';
    if (denial) {
      receipt.denied = denial;
      await persist();
      throw new Error(`Bridge request blocked: ${denial}`);
    }
    receipt.modelRequests++;
    if (checkpoint) receipt.checkpointRequested = true;
    receipt.maxRequestBytesObserved = Math.max(receipt.maxRequestBytesObserved, requestBytes);
    const call = { number: receipt.modelRequests, requestBytes, reservedOutputTokens: options.maxTokens, effort: options.reasoningEffort, checkpoint, usage: null, finished: false };
    receipt.calls.push(call);
    await persist();
    try {
      for await (const chunk of next()) {
        if ((checkpoint || (config.checkpoint && config.maxToolCalls === 0)) && (chunk.type.startsWith('tool-') || chunk.blockType === 'tool-call' || chunk.block?.type === 'tool-call')) {
          receipt.denied = 'CHECKPOINT_TOOL_CALL';
          throw new Error('Checkpoint-only response attempted a tool call.');
        }
        if (chunk.type === 'usage') {
          const usage = Object.fromEntries(['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']
            .filter(key => Number.isFinite(chunk.usage?.[key]) && chunk.usage[key] >= 0).map(key => [key, chunk.usage[key]]));
          call.usage = usage;
        }
        if (chunk.type === 'finish') {
          call.finished = true;
          const reason = chunk.reason?.kind ?? chunk.reason;
          call.finishReason = ['stop', 'completed', 'max-tokens', 'tool-calls', 'aborted', 'error'].includes(reason) ? reason : 'unknown';
        }
        yield chunk;
      }
    } finally { await persist(); }
  }, { prepend: true });
}
