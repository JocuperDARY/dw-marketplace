/** Native stage preparation reservations are separate from charged adapter calls.
 * A prepared captain request keeps its mode while other sessions prepare work.
 */
export function createTeamCheckpoint(ctx, captainSessionId) {
  const prepared = new Map();
  const children = new Map();
  let drain;
  let drained = false;
  let captain;
  const ownedChildren = new Set();
  const ownedAgents = new Set();
  const observedAgents = new Map();
  const captureOwnership = () => {
    const registry = ctx.agents;
    captain ??= registry.get(captainSessionId);
    if (!captain) return;
    const candidates = registry.list();
    // isOwnedBy compares exact owner references, even after an owner detaches.
    // Keep them while admitted descendant materializations finish during drain.
    const parents = [captain, ...ownedAgents];
    for (let index = 0; index < parents.length; index++) for (const child of candidates) {
      if (child === captain || ownedAgents.has(child) || !registry.isOwnedBy(child.id, parents[index])) continue;
      ownedAgents.add(child);
      ownedChildren.add(child.id);
      parents.push(child);
    }
  };
  const release = (sessionId, expected) => {
    const entry = prepared.get(sessionId);
    if (!entry || (expected && entry !== expected && entry.agent !== expected)) return;
    prepared.delete(sessionId);
    entry.signal?.removeEventListener('abort', entry.abort);
  };
  const observe = agent => {
    captureOwnership();
    if (ownedAgents.has(agent) && observedAgents.get(agent.id) !== agent) {
      observedAgents.set(agent.id, agent);
      children.set(agent.id, { sessionId: agent.id, status: agent.status ?? 'unknown' });
    }
  };
  ctx.on('agent/created', ({ agent }) => { observe(agent); });
  ctx.on('subagent/start', () => { captureOwnership(); });
  ctx.on('agent/status', ({ agent, status }) => {
    observe(agent);
    if (observedAgents.get(agent.id) === agent) children.get(agent.id).status = status;
    if (status === 'idle') release(agent.id, agent);
  });
  ctx.on('agent/disposed', ({ agent }) => {
    release(agent.id, agent);
    if (observedAgents.get(agent.id) === agent) children.get(agent.id).status = 'disposed';
  });
  ctx.on('agent/error', ({ agent }) => release(agent.id, agent));
  ctx.on('session/event', (session, event) => {
    if (observedAgents.get(session.id)?.session !== session) return;
    const row = children.get(session.id);
    if (event.type === 'turn/end') row.turnEnd = event.data.reason?.kind ?? 'unknown';
    if (event.type === 'assistant/message') {
      row.interrupted = event.data.interrupted === true;
      const text = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      row.text = text.slice(0, 512);
      row.textTruncated = text.length > 512;
    }
  });
  // A rejected pre-step never reaches agent/request or llm/stream. Idle also
  // releases a prepared no-step turn, and abort covers every async boundary.
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    try {
      const result = await next();
      if (result.kind === 'reject') release(agent.id, agent);
      return result;
    } catch (error) { release(agent.id, agent); throw error; }
  }, { prepend: true });
  return {
    captainSessionId,
    get closing() { return drain !== undefined; },
    get: sessionId => prepared.get(sessionId),
    reservations: () => [...prepared.values()],
    release,
    reserve(agent, mode, signal) {
      signal?.throwIfAborted();
      observe(agent);
      release(agent.id);
      const entry = { ...mode, agent, signal, abort: () => release(agent.id, entry) };
      prepared.set(agent.id, entry);
      signal?.addEventListener('abort', entry.abort, { once: true });
      return entry;
    },
    startDrain() {
      if (!drain) {
        captureOwnership();
        if (!captain || ctx.agents.get(captainSessionId) !== captain) throw new Error('Native checkpoint captain is unavailable.');
        // This call synchronously closes descendant admission and cancels live
        // children. A child must never await the resulting self-disposal join.
        // Cordis get() is the supported optional-service lookup. Its undefined
        // result must not fall through to an undeclared property injection.
        const subagents = ctx.get ? ctx.get('subagents') : ctx.subagents;
        drain = Promise.resolve(subagents?.drainDescendants([captain])).then(() => { drained = true; });
        void drain.catch(() => {});
      }
      return drain;
    },
    async settlement(signal, publish) {
      const pending = this.startDrain();
      signal?.throwIfAborted();
      let abort;
      try {
        await (signal ? Promise.race([pending, new Promise((_resolve, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
        })]) : pending);
      } finally { if (abort) signal.removeEventListener('abort', abort); }
      // Inbox.claim precedes assembly in the pinned SDK. Drain can deliver late
      // native notices after that claim, which would otherwise request another
      // model step after the captain's final checkpoint. Fold only notices from
      // the successfully drained runtime ownership tree; preserve all other steering.
      const notices = captain.inbox.nextStep.filter(message => message.source.kind === 'subagent-settled'
        && message.source.form === 'notice' && ownedChildren.has(message.source.senderSessionId));
      const snapshot = { drained, children: [...children.values()].slice(0, 16).map(row => ({ ...row })), omittedChildren: Math.max(0, children.size - 16),
        lateNotices: notices.slice(0, 16).map(message => {
          const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
          return { messageId: message.id, senderSessionId: message.source.senderSessionId, text: text.slice(0, 512), textTruncated: text.length > 512 };
        }), omittedNotices: Math.max(0, notices.length - 16) };
      // Preserve bounded evidence before public Inbox.remove records the native
      // notices as canceled. Their original message IDs are never re-admitted.
      await publish(snapshot);
      signal?.throwIfAborted();
      for (const message of notices) captain.inbox.remove(message.id);
      return JSON.stringify(snapshot);
    },
  };
}
