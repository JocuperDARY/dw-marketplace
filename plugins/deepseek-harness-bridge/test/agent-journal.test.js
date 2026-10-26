import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentJournal } from '../src/agent-journal.js';
import { createTaskContext } from '../src/task-context.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-journal-')); const id = randomUUID();
  const journal = new AgentJournal(root, id, { lockWaitMs: 25 });
  await journal.initialize({ taskId: id, taskContext: createTaskContext({ assignment: 'Keep all constraints.', requestId: id }) });
  t.after(async () => { if (t.passed) await rm(root, { recursive: true, force: true }); });
  return { root, id, journal };
}

test('journal commits idempotent messages with operation identity and CAS instruction changes', async t => {
  const { journal, id } = await fixture(t);
  const first = await journal.accept('send', { requestId: 'message-1', text: 'NO_RETRAIN' });
  assert.equal(first.contextRevision, 2);
  assert.equal((await journal.accept('send', { requestId: 'message-1', text: 'NO_RETRAIN' })).messageId, first.messageId);
  await assert.rejects(journal.accept('followup', { requestId: 'message-1', text: 'NO_RETRAIN' }), { code: 'REQUEST_ID_CONFLICT' });
  await assert.rejects(journal.accept('send', { requestId: 'replace-stale', text: 'Changed', change: 'replace', targetMessageIds: [id], expectedContextRevision: 1 }), { code: 'CONTEXT_CONFLICT' });
  const second = await journal.accept('send', { requestId: 'replace-good', text: 'New rule', change: 'replace', targetMessageIds: [id], expectedContextRevision: 2 });
  assert.equal(second.contextRevision, 3);
  assert.equal((await journal.context()).entries[0].status, 'inactive');
  assert.equal((await journal.read()).pending.length, 2);
});

test('an old activity cannot expire context or overwrite a new activity during handoff', async t => {
  const { journal, id } = await fixture(t); await journal.startActivity(`${id}:2`);
  const before = await journal.read();
  await assert.rejects(journal.finishActivity({ number: 1, status: 'completed', cleanup: 'confirmed' }), { code: 'STALE_ACTIVITY' });
  assert.deepEqual(await journal.read(), before);
  await journal.startEpoch('current-epoch', 'current-session');
  assert.equal((await journal.read()).runtime.epoch, 'current-epoch');
});

test('agent events have independent durable cursors, full maximum messages and honest gaps', async t => {
  const { root, id, journal } = await fixture(t); await journal.startActivity(`${id}:1`); await journal.startEpoch('epoch-one', 'session-one');
  const page = await journal.events();
  await journal.workerMessage('epoch-one', { kind: 'question', text: '问'.repeat(8192) });
  const reopened = new AgentJournal(root, id);
  const a = await reopened.events(page.cursor); const b = await journal.events(page.cursor);
  assert.deepEqual(a.events, b.events); assert.equal(a.events[0].text.length, 8192);
  assert.equal((await journal.events(a.cursor)).events.length, 0);
  await assert.rejects(journal.events(Buffer.from(JSON.stringify({ v: 1, a: id, g: 'wrong', s: 0 })).toString('base64url')), { code: 'INVALID_CURSOR' });
  const head = await journal.read();
  await assert.rejects(journal.events(journal.cursor(head, head.eventSeq + 1)), { code: 'CURSOR_GAP' });
});

test('turn scope expires only after inclusion and persistent context survives worker summaries', async t => {
  const { journal, id } = await fixture(t);
  const included = await journal.accept('send', { requestId: 'turn-1', text: 'THIS_ACTIVITY_ONLY', scope: 'turn' });
  await journal.startActivity(`${id}:1`); await journal.startEpoch('one', 'session');
  await journal.included('one', { contextRevision: 2, instructionIds: [id, included.messageId], materialIds: [], inputSha256: 'a'.repeat(64) });
  const pending = await journal.accept('send', { requestId: 'turn-2', text: 'NOT_YET_INCLUDED', scope: 'turn' });
  await journal.finishEpoch('one', 'confirmed');
  await journal.finishActivity({ number: 1, status: 'completed', cleanup: 'confirmed' });
  const context = await journal.context();
  assert.equal(context.entries.find(item => item.id === included.messageId).status, 'inactive');
  assert.equal(context.entries.find(item => item.id === pending.messageId).status, 'active');
  assert.equal((await journal.read()).pending.length, 1);
});

test('journal preserves foreign locks and rejects stale runtime commands', async t => {
  const { journal, id } = await fixture(t);
  await journal.startActivity(`${id}:1`); await journal.startEpoch('new', 'session');
  await assert.rejects(journal.workerMessage('old', { kind: 'progress', text: 'cannot cross epoch' }), { code: 'STALE_EPOCH' });
  const path = join(journal.directory, 'transaction.lock'); const bytes = '{"nonce":"foreign"}'; await writeFile(path, bytes);
  await assert.rejects(journal.accept('send', { requestId: 'blocked', text: 'queue' }), { code: 'STATE_LOCKED' });
  assert.equal(await readFile(path, 'utf8'), bytes);
});
