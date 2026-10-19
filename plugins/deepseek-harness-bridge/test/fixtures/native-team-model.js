import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

// Scripted parent and child streams test the real native team runtime offline.
export const name = 'offline-native-team-model';
export const inject = ['llm'];
export function apply(ctx, config) {
  let parent = 0;
  let child = 0;
  let publication = Promise.resolve();
  const requests = [];
  const state = async () => JSON.parse(await readFile(config.teamPath, 'utf8'));
  ctx.on('llm/stream', async function* (options) {
    const member = JSON.stringify([options.system, options.messages.filter(message => ['system', 'developer'].includes(message.role))]).includes('You are fixture-worker, a member');
    requests.push({ member, maxTokens: options.maxTokens, effort: options.reasoningEffort, messages: options.messages });
    const content = JSON.stringify(requests, null, 2);
    publication = publication.then(() => writeFile(config.receipt, content));
    await publication;
    let step;
    if (member) {
      const task = (await state()).tasks[0];
      switch (++child) {
        case 1: step = { name: 'agent_teams_claim_task', args: { task_id: task.id } }; break;
        case 2: step = { name: 'agent_teams_update_task', args: { task_id: task.id, attempt_id: task.attemptId, status: 'in_progress' } }; break;
        case 3: step = { name: 'bridge_read', args: { path: 'input.txt' } }; break;
        case 4: step = { name: 'agent_teams_update_task', args: { task_id: task.id, attempt_id: task.attemptId, status: 'completed', output: 'OFFLINE_CHILD_READ_CONFIRMED' } }; break;
      }
    } else switch (++parent) {
      case 1: step = { name: 'agent_teams_create', args: { name: 'offline-team', description: 'Offline child/shared-accounting fixture.', approval: 'automatic', plan: {
        members: [{ name: 'fixture-worker', role: 'Offline read fixture', provider: 'deepseek-official', model: 'deepseek-flash', reasoning_effort: 'off' }],
        tasks: [{ id: 'read', subject: 'Read the fixture', description: 'Read input.txt and report OFFLINE_CHILD_READ_CONFIRMED.', assignee: 'fixture-worker' }],
      } } }; break;
      case 2: {
        const deadline = Date.now() + 15000;
        while ((await state()).tasks[0]?.status !== 'completed') {
          if (Date.now() >= deadline) throw new Error('Offline child did not complete; inspect retained state and requests.');
          await delay(20);
        }
        step = { name: 'agent_teams_status', args: {} }; break;
      }
      case 3: step = { name: 'agent_teams_delete', args: {} }; break;
    }
    const block = step ? { type: 'tool-call', id: `native-${member ? 'child' : 'parent'}-${member ? child : parent}`, name: step.name, arguments: JSON.stringify(step.args) }
      : { type: 'text', text: member ? 'OFFLINE_CHILD_READ_CONFIRMED' : 'OFFLINE_TEAM_COMPLETED' };
    yield { type: 'block-start', index: 0, blockType: block.type };
    yield { type: 'block-end', index: 0, block };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } };
    yield { type: 'finish', reason: { kind: step ? 'tool-calls' : 'stop' } };
  });
}
