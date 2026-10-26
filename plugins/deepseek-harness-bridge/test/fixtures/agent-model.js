import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { AgentJournal } from '../../src/agent-journal.js';

export const name = 'offline-agent-communication-model';
export const inject = ['llm'];
export function apply(ctx, config) {
  if (config.closingBarrier) {
    const runtime = AgentJournal.prototype.runtime;
    AgentJournal.prototype.runtime = function (epoch, operation) {
      return runtime.call(this, epoch, async tx => {
        const result = await operation(tx);
        if (tx.head.runtime.status === 'closing') {
          // Expose the exact head-publication / lock-release window without a
          // production test hook. The parent must not terminate this writer.
          await this.writer(join(this.directory, 'head.json'), JSON.stringify(tx.head));
          await writeFile(config.closingBarrier + '.entered', 'closing');
          while (true) {
            try { await readFile(config.closingBarrier + '.release'); break; }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
            await delay(10);
          }
        }
        return result;
      });
    };
  }
  let step = 0;
  ctx.on('llm/stream', async function* (options) {
    const index = step++;
    let requests = [];
    try { requests = JSON.parse(await readFile(config.receipt, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const visible = JSON.stringify(options.messages);
    requests.push({ sessionId: options.sessionId, index, messages: options.messages, tools: options.tools?.map(tool => tool.name) });
    await writeFile(config.receipt, JSON.stringify(requests));
    if (config.barrier && index === 0 && !visible.includes('RESUME_AFTER_INTERRUPT')) {
      while (true) {
        options.signal?.throwIfAborted();
        try { await readFile(config.barrier); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await delay(20, undefined, { signal: options.signal });
      }
    }
    let block;
    if (config.question && !visible.includes('ANSWER_COLOR_BLUE'))
      block = { type: 'tool-call', id: `question-${index}`, name: 'bridge_send_message', arguments: JSON.stringify({ kind: 'question', text: 'Choose a color for the output.' }) };
    else if (config.readStep && index === 0 && !visible.includes('RESUME_AFTER_INTERRUPT'))
      block = { type: 'tool-call', id: 'read-step', name: 'bridge_read', arguments: JSON.stringify({ path: 'input.txt' }) };
    else block = { type: 'text', text: JSON.stringify({ result: 'OFFLINE_AGENT_COMPLETE', noRetrain: visible.includes('DO_NOT_RETRAIN'), blue: visible.includes('ANSWER_COLOR_BLUE'),
      resumed: visible.includes('RESUME_AFTER_INTERRUPT'), parentAcceptance: 'not_assessed' }) };
    yield { type: 'block-start', index: 0, blockType: block.type };
    yield { type: 'block-end', index: 0, block };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } };
    yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } };
  });
}
