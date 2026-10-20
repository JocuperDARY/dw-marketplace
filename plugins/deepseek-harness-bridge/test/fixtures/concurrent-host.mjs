// Offline integration host: injection lives only in this test fixture.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TaskManager } from '../../src/tasks.js';
import { createServer } from '../../src/server.js';

const send = value => { if (process.connected) process.send(value); };
const pending = new Map();
let sequence = 0;
let manager;
let server;

function runner({ task, prompt, signal, resume }) {
  const runId = ++sequence;
  return new Promise(resolve => {
    const finish = (outcome = {}) => {
      signal.removeEventListener('abort', abort);
      pending.delete(runId);
      const usage = outcome.usage ?? { inputTokens: 10, outputTokens: 7, totalTokens: 17 };
      resolve({ terminal: 'completed', cleanup: 'confirmed', toolCalls: 0, text: `host:${process.pid}:run:${runId}`,
        budget: { ...(task.stageBudget ? { nonce: task.stageBudget.nonce } : {}), modelRequests: 1,
          calls: [{ number: 1, finished: true, reservedOutputTokens: task.maxTokens, usage }] }, ...outcome });
    };
    const abort = () => {
      send({ event: 'runner-aborted', runId, taskId: task.taskId });
      // Deliberately require a parent-controlled cleanup receipt. Abort alone
      // must never be mistaken for successful worker teardown.
    };
    pending.set(runId, { finish });
    signal.addEventListener('abort', abort, { once: true });
    send({ event: 'runner-started', runId, taskId: task.taskId, prompt, resume, task });
    if (signal.aborted) abort();
  });
}

process.on('message', async message => {
  if (message.type === 'release') {
    const run = pending.get(message.runId);
    if (run) run.finish(message.outcome);
    return;
  }
  if (message.type === 'close') {
    try {
      await manager?.close();
      await server?.close();
      send({ event: 'closed', id: message.id });
      process.disconnect();
    } catch (error) {
      send({ event: 'close-error', id: message.id, error: { code: error.code, message: error.message } });
    }
  }
});

try {
  manager = await new TaskManager({ dataDir: process.argv[2], runner,
    resolveCapabilities: async id => ({ id, digest: 'offline-process-fixture', access: 'read-only' }) }).open();
  server = createServer({ manager, doctor: async () => ({ fixture: true, modelCalls: 0 }) });
  await server.connect(new StdioServerTransport());
  send({ event: 'ready', pid: process.pid });
} catch (error) {
  send({ event: 'startup-error', error: { code: error.code, message: error.message } });
  process.exitCode = 1;
  process.disconnect();
}
