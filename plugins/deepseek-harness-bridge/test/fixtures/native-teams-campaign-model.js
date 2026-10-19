import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { writeAtomicReceipt } from '../../src/atomic-receipt.js';

// The actual SDK and Agent Teams runtime execute these fixed, offline streams.
// Barriers control scheduling only; the bridge's real budget/tool hooks remain active.
export const name = 'offline-native-teams-campaign-model';
export const inject = ['llm'];

export function apply(ctx, config) {
  const receipt = { pid: process.pid, nodeVersion: process.version, requests: [], events: [] };
  let publication = Promise.resolve();
  let parent = 0;
  let child = 0;
  let childFinished = false;
  let childCheckpoint = false;
  let childIdle = false;
  const persist = () => {
    const content = JSON.stringify(receipt, null, 2);
    publication = publication.then(() => writeAtomicReceipt(config.receipt, content));
    return publication;
  };
  const record = async (type, details = {}) => {
    receipt.events.push({ type, at: Date.now(), ...details });
    await persist();
  };
  const state = async () => JSON.parse(await readFile(config.teamPath, 'utf8'));
  const denied = async () => {
    try { return JSON.parse(await readFile(config.budgetPath, 'utf8')).denied; }
    catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
  };
  const until = async (condition, signal) => {
    const deadline = Date.now() + (config.mode === 'soft-deadline' ? 65000 : 12000);
    while (!(await condition())) {
      if (Date.now() >= deadline) throw new Error('Offline Teams barrier timed out; retained receipts identify the blocked side.');
      await delay(20, undefined, { signal });
    }
  };
  const create = { name: 'agent_teams_create', args: {
    name: 'offline-team', description: 'Offline native delegation/shared-budget regression.', approval: 'automatic',
    plan: {
      members: [{ name: 'fixture-worker', role: 'Read the local fixture and report once', provider: 'deepseek-official', model: 'deepseek-flash', reasoning_effort: 'off' }],
      tasks: [{ id: 'read', subject: 'Read the fixture', description: 'Read input.txt and report OFFLINE_CHILD_READ_CONFIRMED to the captain.', assignee: 'fixture-worker' }],
    },
  } };
  ctx.on('agent/request', async ({ agent, turn, step }, next) => {
    await record('agent-request', { agentId: agent.id, sessionId: agent.session.id, turn, step });
    return next();
  });
  ctx.on('subagent/start', info => record('subagent-start', { id: info.id, runId: info.runId, provider: info.provider, local: info.local }));
  ctx.on('subagent/end', info => record('subagent-end', { id: info.id, runId: info.runId, provider: info.provider, local: info.local, stopReason: info.stopReason }));
  ctx.on('agent/status', async ({ agent, status }) => {
    if (agent.session.id !== config.captainSessionId && child > 0) childIdle = status === 'idle';
    await record('agent-status', { sessionId: agent.session.id, status });
  });
  ctx.on('llm/stream', async function* (options) {
    if (typeof options.sessionId !== 'string') throw new Error('Expected the SDK loop to stamp an authoritative session identity.');
    const member = options.sessionId !== config.captainSessionId;
    const number = member ? ++child : ++parent;
    const checkpoint = JSON.stringify([options.system, options.messages]).includes('Return the checkpoint JSON now');
    receipt.requests.push({ member, number, sessionId: options.sessionId, maxTokens: options.maxTokens,
      effort: options.reasoningEffort, checkpoint, tools: options.tools?.map(tool => tool.name) ?? [], messages: options.messages });
    await persist();
    let step;
    let text = config.mode === 'success' ? (member ? 'OFFLINE_CHILD_READ_CONFIRMED' : 'OFFLINE_TEAM_COMPLETED')
      : member ? 'OFFLINE_CHILD_WORK_NOT_VERIFIED' : 'OFFLINE_CAP_BOUNDARY_OBSERVED';
    if (checkpoint) {
      if (member) childCheckpoint = true;
      await record('checkpoint', { member, number });
      text = JSON.stringify({ state: 'checkpoint', summary: `${member ? 'Child' : 'Captain'} saved bounded offline progress`, nextSteps: 'Continue the unfinished fixture task' });
    } else if (member) {
      if (config.mode === 'cancel' || config.mode === 'captain-checkpoint') {
        await record('child-active', { number });
        try {
          // This heartbeat proves the active in-process child becomes quiescent.
          // It creates no shell, detached process, external request or live state.
          while (true) {
            await writeFile(config.heartbeat, `${process.pid}:${Date.now()}`);
            await delay(25, undefined, { signal: options.signal });
          }
        } finally { await record('child-stream-settled', { aborted: options.signal?.aborted === true }); }
      }
      if (config.mode === 'soft-deadline' && number === 1) {
        await record('child-deadline-wait', { softDeadline: config.softDeadline });
        await until(() => Date.now() >= config.softDeadline, options.signal);
        await record('child-deadline-reached', { softDeadline: config.softDeadline });
      }
      const task = (await state()).tasks[0];
      switch (number) {
        case 1: step = { name: 'agent_teams_claim_task', args: { task_id: task.id } }; break;
        case 2: step = { name: 'agent_teams_update_task', args: { task_id: task.id, attempt_id: task.attemptId, status: 'in_progress' } }; break;
        case 3: step = { name: 'bridge_read', args: { path: 'input.txt' } }; break;
        case 4: {
          const evidence = JSON.stringify(options.messages);
          if (config.mode === 'success' && !evidence.includes('NATIVE_CHILD_FILE_FIXTURE')) throw new Error('Child did not receive a real bridge_read result.');
          step = { name: 'agent_teams_update_task', args: { task_id: task.id, attempt_id: task.attemptId, status: config.mode === 'success' ? 'completed' : 'failed',
            output: config.mode === 'success' ? 'OFFLINE_CHILD_READ_CONFIRMED' : 'OFFLINE_CHILD_WORK_NOT_VERIFIED' } }; break;
        }
        case 5: step = { name: 'agent_teams_send_message', args: { to: 'captain', source_task_id: task.id,
          source_attempt_id: task.attemptId, content: config.mode === 'success' ? 'OFFLINE_CHILD_REPORT_TO_CAPTAIN' : 'OFFLINE_CHILD_CAP_BOUNDARY_REPORT' } }; break;
        default: childFinished = true; await record('child-finished');
      }
    } else if (number === 1) step = create;
    else if (config.mode === 'success') {
      if (number === 2) {
        await until(() => childFinished, options.signal);
        step = { name: 'agent_teams_status', args: {} };
      } else if (number === 3) {
        if (!JSON.stringify(options.messages).includes('OFFLINE_CHILD_REPORT_TO_CAPTAIN')) throw new Error('Captain did not receive the actual child report.');
        step = { name: 'agent_teams_delete', args: {} };
      }
    } else if (config.mode === 'tool-cap') await until(() => childFinished, options.signal);
    else if (config.mode === 'checkpoint' || config.mode === 'soft-deadline') {
      await until(async () => childCheckpoint || childIdle || receipt.events.some(event => event.type === 'subagent-end') || !!(await denied()), options.signal);
      // Force a new captain assembly after the child consumed a shared checkpoint.
      // Returning text here would hide CHECKPOINT_CLOSED on the next root request.
      step = { name: 'agent_teams_status', args: {} };
    } else if (config.mode === 'captain-checkpoint') {
      await until(() => receipt.events.some(event => event.type === 'child-active'), options.signal);
      step = { name: 'agent_teams_status', args: {} };
    } else if (config.mode === 'cancel') {
      await record('captain-active', { number });
      try { await until(() => false, options.signal); }
      finally { await record('captain-stream-settled', { aborted: options.signal?.aborted === true }); }
    } else await until(async () => !!(await denied()), options.signal);

    const block = step ? { type: 'tool-call', id: `native-${member ? 'child' : 'captain'}-${number}`, name: step.name, arguments: JSON.stringify(step.args) }
      : { type: 'text', text };
    yield { type: 'block-start', index: 0, blockType: block.type };
    yield { type: 'block-end', index: 0, block };
    const outputTokens = config.outputTokens ?? 10;
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens, totalTokens: outputTokens + 10 } };
    yield { type: 'finish', reason: { kind: step ? 'tool-calls' : 'stop' } };
  });
}
