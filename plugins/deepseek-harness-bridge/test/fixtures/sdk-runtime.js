import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
let sessionId;
let mode;
let seq = 0;
const send = value => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
const event = (type, data) => send({ method: 'session.event', params: { sessionId, event: { type, seq: ++seq, data } } });
lines.on('line', line => {
  const request = JSON.parse(line);
  const respond = result => send({ id: request.id, result });
  if (request.method === 'initialize') respond({ serverInfo: { name: 'offline-fixture', version: '1' } });
  else if (request.method === 'session/resume') respond({});
  else if (request.method === 'session/prompt') {
    sessionId = request.params.sessionId;
    mode = request.params.contentBlocks[0].text;
    // Stale content before this prompt's durable inbox receipt must be ignored.
    event('assistant/message', { message: { content: [{ type: 'text', text: 'stale result' }] } });
    respond({ messageId: 'receipt-1' });
    event('agent/inbox/spliced', { inserted: [{ id: 'receipt-1' }] });
  } else if (request.method === 'session/wait') {
    if (mode === 'hang') return;
    if (mode === 'fail') { send({ id: request.id, error: { code: -32000, message: 'dummy-provider-secret' } }); return; }
    if (mode === 'tool-limit') for (let i = 0; i < 3; i++) event('tool/call', { name: 'bridge_read' });
    if (mode === 'reasoning-only') event('assistant/message', { message: { content: [{ type: 'reasoning', text: 'private-reasoning-marker' }] } });
    else if (mode !== 'empty') event('assistant/message', { message: { content: [{ type: 'text', text: mode === 'redact' ? process.env.DEEPSEEK_API_KEY : 'fresh result' }] } });
    if (mode === 'malformed') event('turn/end', {});
    else if (mode !== 'missing-terminal') event('turn/end', { reason: { kind: ['truncated', 'reasoning-only'].includes(mode) ? 'max-tokens' : 'completed' } });
    respond({});
  } else if (request.method === 'shutdown') { respond({}); process.exitCode = 0; lines.close(); process.stdin.destroy(); }
});
