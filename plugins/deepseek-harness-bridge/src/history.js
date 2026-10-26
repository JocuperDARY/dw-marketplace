import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { BridgeError, requireValue } from './errors.js';

const statuses = ['running', 'cancelling', 'completed', 'paused', 'failed', 'cancelled', 'timed_out', 'cleanup_failed', 'interrupted', 'state_write_failed'];
const timestamp = z.string().datetime().regex(/:\d{2}(?:\.\d{1,3})?Z$/);
export const historySchema = z.object({
  scope: z.enum(['connection', 'store']).optional().describe('Default connection owns tasks created by this connection. Explicit store includes retained and legacy read-only tasks; no execution control is granted.'),
  limit: z.number().int().min(1).max(50).optional().describe('Default50; keep the same page size for subsequent cursor requests.'),
  cursor: z.string().max(256).regex(/^[a-f0-9]{32}\.[1-9][0-9]{0,9}\.[A-Za-z0-9_-]{43}$/).optional().describe('Opaque connection-local snapshot cursor. Use nextRequest unchanged; expired/evicted/foreign cursors cannot restart silently.'),
  parentLabel: z.string().max(160).optional().describe('Exact case-sensitive parent label match; omitted includes unlabeled legacy records.'),
  statuses: z.array(z.enum(statuses)).min(1).max(statuses.length).optional().describe('Unique latest-attempt statuses at snapshot capture; changes after capture are not reflected.'),
  startedFrom: timestamp.optional().describe('Inclusive latest-attempt start time, UTC ISO8601 with seconds and Z, at most3 fractional digits (milliseconds). Greater precision is rejected, never rounded.'),
  startedBefore: timestamp.optional().describe('Exclusive latest-attempt start time, UTC ISO8601 with seconds and Z, at most3 fractional digits; must follow startedFrom.'),
}).strict();

export function normalizeHistory(input = {}) {
  const parsed = historySchema.safeParse(input);
  if (!parsed.success) throw new BridgeError('INVALID_ARGUMENT', 'Arguments do not match the history schema.', {
    validation: { phase: 'schema', issues: parsed.error.issues },
  });
  const value = parsed.data;
  let path;
  if (value.statuses && new Set(value.statuses).size !== value.statuses.length) path = ['statuses'];
  if (value.startedFrom && value.startedBefore && Date.parse(value.startedFrom) >= Date.parse(value.startedBefore)) path = ['startedBefore'];
  if (path) throw new BridgeError('INVALID_ARGUMENT', 'History filters violate the advertised contract.', {
    validation: { phase: 'contract', issues: [{ path, code: 'invalid_value' }] },
  });
  return { cursor: value.cursor, query: { scope: value.scope ?? 'connection', limit: value.limit ?? 50,
    ...(value.parentLabel === undefined ? {} : { parentLabel: value.parentLabel }),
    ...(value.statuses ? { statuses: [...value.statuses].sort() } : {}),
    ...(value.startedFrom ? { startedFrom: new Date(value.startedFrom).toISOString() } : {}),
    ...(value.startedBefore ? { startedBefore: new Date(value.startedBefore).toISOString() } : {}) } };
}

function compareTime(left, right) {
  const milliseconds = Date.parse(left) - Date.parse(right);
  if (milliseconds) return Math.sign(milliseconds);
  // Retained legacy timestamps may contain precision beyond the public query
  // schema. Date.parse truncates it; keep the fractional tail for exact order.
  const tail = value => /:\d{2}\.(\d+)/.exec(value)?.[1].slice(3).replace(/0+$/, '') ?? '';
  const a = tail(left); const b = tail(right);
  const width = Math.max(a.length, b.length);
  const x = a.padEnd(width, '0'); const y = b.padEnd(width, '0');
  return x === y ? 0 : x < y ? -1 : 1;
}

function matches(summary, query) {
  return (query.parentLabel === undefined || query.parentLabel === summary.parentLabel)
    && (!query.statuses || query.statuses.includes(summary.status))
    && (!query.startedFrom || compareTime(summary.startedAt, query.startedFrom) >= 0)
    && (!query.startedBefore || compareTime(summary.startedAt, query.startedBefore) < 0);
}

// Observation cache only: no disk writes, task locks or task-control capabilities.
export class HistoryPages {
  constructor({ now = Date.now, ttlMs = 600000, maxSnapshots = 8, maxBytes = 16 * 1024 * 1024 } = {}) {
    requireValue([ttlMs, maxSnapshots, maxBytes].every(value => Number.isSafeInteger(value) && value > 0),
      'INVALID_CONFIG', 'History cache limits must be positive safe integers.');
    this.now = now; this.ttlMs = ttlMs; this.maxSnapshots = maxSnapshots; this.maxBytes = maxBytes;
    this.secret = randomBytes(32); this.snapshots = new Map(); this.bytes = 0;
  }

  clear() { this.snapshots.clear(); this.bytes = 0; }
  remove(id) { const value = this.snapshots.get(id); if (value) { this.bytes -= value.bytes; this.snapshots.delete(id); } }
  expire() { for (const [id, snapshot] of this.snapshots) if (snapshot.expiresAt <= this.now()) this.remove(id); }
  signature(id, offset, key) { return createHmac('sha256', this.secret).update(`${id}.${offset}.${key}`).digest('base64url'); }

  capture(query, summaries, activeTaskIds = []) {
    this.expire();
    const rows = []; let scopeTotal = 0; let bytes = 0;
    for (const summary of summaries) {
      scopeTotal++;
      if (!matches(summary, query)) continue;
      bytes += Buffer.byteLength(JSON.stringify(summary));
      requireValue(bytes <= this.maxBytes, 'HISTORY_SNAPSHOT_TOO_LARGE', 'History snapshot exceeds the observation cache. Narrow the filters and start a fresh query.');
      rows.push(structuredClone(summary));
    }
    rows.sort((a, b) => compareTime(b.startedAt, a.startedAt) || b.taskId.localeCompare(a.taskId));
    const ids = new Set(rows.map(row => row.taskId));
    const active = [...new Set(activeTaskIds)].filter(id => ids.has(id));
    const snapshot = { id: randomBytes(16).toString('hex'), query: structuredClone(query), key: JSON.stringify(query),
      capturedAt: this.now(), expiresAt: this.now() + this.ttlMs, bytes, rows, scopeTotal, active };
    if (rows.length > query.limit) {
      while (this.snapshots.size >= this.maxSnapshots || this.bytes + bytes > this.maxBytes) this.remove(this.snapshots.keys().next().value);
      this.snapshots.set(snapshot.id, snapshot); this.bytes += bytes;
    }
    return this.page(snapshot, 0);
  }

  next(query, cursor) {
    this.expire();
    const [id, rawOffset, signature] = cursor.split('.');
    const snapshot = this.snapshots.get(id);
    requireValue(snapshot, 'HISTORY_CURSOR_UNAVAILABLE', 'History snapshot expired, was evicted, or belongs to another connection. Start a fresh query without cursor.');
    const key = JSON.stringify(query);
    requireValue(key === snapshot.key, 'HISTORY_CURSOR_MISMATCH', 'Cursor scope, filters and page size must match the original query. Use nextRequest unchanged.');
    const expected = Buffer.from(this.signature(id, rawOffset, key));
    const actual = Buffer.from(signature);
    const offset = Number(rawOffset);
    requireValue(actual.length === expected.length && timingSafeEqual(actual, expected)
      && Number.isSafeInteger(offset) && offset > 0 && offset < snapshot.rows.length && offset % query.limit === 0,
    'HISTORY_CURSOR_INVALID', 'The history cursor is invalid. Start a fresh query or use the returned nextRequest unchanged.');
    return this.page(snapshot, offset);
  }

  page(snapshot, offset) {
    const { query, id, key, rows, active } = snapshot;
    const nextOffset = offset + query.limit;
    const nextCursor = nextOffset < rows.length ? `${id}.${nextOffset}.${this.signature(id, nextOffset, key)}` : null;
    return structuredClone({ tasks: rows.slice(offset, nextOffset), total: rows.length, scopeTotal: snapshot.scopeTotal,
      blocked: false, activeTaskIds: active, activeTaskId: active.length === 1 ? active[0] : null,
      pagination: { mode: 'snapshot', scope: query.scope, snapshotAt: new Date(snapshot.capturedAt).toISOString(),
        expiresAt: new Date(snapshot.expiresAt).toISOString(), offset, limit: query.limit, nextCursor,
        nextRequest: nextCursor ? { ...query, cursor: nextCursor } : null } });
  }
}
