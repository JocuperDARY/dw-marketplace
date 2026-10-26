import { z } from 'zod';

export const agentIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const requestId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/);
const controlToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional();
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const text = z.string().min(1).regex(/\S/u).refine(value => [...value].length <= 32768,
  { message: 'Message exceeds the advertised code-point limit.' }).meta({ maxLength: 32768 });
const targets = z.array(agentIdSchema).min(1).max(64)
  .refine(ids => new Set(ids).size === ids.length).meta({ uniqueItems: true });
const identity = { agentId: agentIdSchema, requestId, controlToken };
const change = { ...identity, kind: z.literal('instruction').optional(), scope: z.literal('persistent').optional(),
  targetMessageIds: targets, expectedContextRevision: revision };

// A union advertises the same conditional requirements the runtime enforces.
// The text length is Unicode code points in both Zod and JSON Schema.
export const agentMessageSchema = z.union([
  z.object({ ...identity, text, kind: z.enum(['instruction', 'context', 'question']).optional(),
    scope: z.enum(['persistent', 'turn']).optional(), change: z.literal('add').optional(),
    expectedContextRevision: revision.optional(), replyTo: agentIdSchema.optional() }).strict(),
  z.object({ ...change, text, change: z.literal('replace') }).strict(),
  z.object({ ...change, change: z.literal('retract') }).strict(),
]).meta({ type: 'object' });
export const agentInterruptSchema = z.object({ ...identity,
  waitTimeoutMs: z.number().int().min(0).max(30000).optional() }).strict();
export const agentWaitSchema = z.object({ targets: z.array(z.object({ agentId: agentIdSchema,
  afterCursor: z.string().min(1).max(512).optional() }).strict()).min(1).max(32),
  timeoutMs: z.number().int().min(0).max(30000).optional() }).strict();
export const agentListSchema = z.object({ scope: z.enum(['connection', 'store']).optional(),
  limit: z.number().int().min(1).max(50).optional(), cursor: z.string().optional() }).strict();
