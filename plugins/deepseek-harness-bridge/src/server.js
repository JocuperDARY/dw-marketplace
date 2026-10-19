import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { safeError } from './errors.js';
import { capabilities } from './capabilities.js';
import { reviewContractSchema } from './delivery.js';
import { reportContractSchema } from './report.js';

export const VERSION = '1.3.0';
const taskId = z.string().uuid();
const requestId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/);
const prompt = z.string().min(1).max(65536).describe('Bounded assignment with context, file ownership, acceptance criteria and required evidence.');
const timeoutMs = z.number().int().min(1000).max(1800000).optional().describe('Wall-clock attempt limit, or stage ceiling with budget, in milliseconds; default 300000. Teardown may take several more seconds.');
const attempt = z.number().int().min(1).max(16).optional();
const budget = z.object({
  totalModelRequests: z.number().int().min(2).max(1024),
  totalOutputTokens: z.number().int().min(512).max(33554432),
  totalToolCalls: z.number().int().min(0).max(4096),
  totalDurationMs: z.number().int().min(1000).max(86400000),
}).strict().optional().describe('REQUIRED for default budgeted execution. Preauthorized totals across stages, continuations and one shared text-only recovery for truncation or explicitly checked JSON format. Output includes reasoning. At least 2 stage requests are required; 3 total requests and 768 output tokens allow a separate soft recovery reserve. Totals are not a currency cap.');

export function createServer({ manager, doctor, preflight = () => {} }) {
  const definitions = [
    { name: 'dsh_submit', description: 'Start an independent official DeepSeek Flash worker with existing user authorization. Prefer an independently reviewable work package (owned module, multi-file evidence, full rule/test matrix); do not inflate tokens or scope just to spend budget. Long/multi-step work MUST supply budget. Rule verification uses verification/reviewContract; factual reports use reportContract to preserve limits, observations and execution states. completed never means parent acceptance. Select a minimal reviewed capabilityProfile. Explicit single-request permits only one inference call without tools or continuation. Returns immediately; never reuses a desktop conversation.',
      schema: z.object({ requestId, prompt, workspace: z.string().min(1).describe('Absolute existing workspace directory, disjoint from bridge state.'),
        access: z.enum(['read-only', 'workspace-write']).optional(),
        executionMode: z.enum(['budgeted', 'single-request']).optional().describe('Default budgeted requires explicit totals. single-request is an explicit opt-out limited to one inference-only request, no tools or continuation.'),
        workload: z.enum(['mechanical', 'drafting', 'standard', 'reasoning', 'verification']).optional().describe('mechanical is literal extraction/reformatting; drafting is bounded prose from supplied facts (both off/4096). standard (default) low/8192; reasoning high/16384. Rule classification and test expectations use verification (high/16384), requiring reviewContract. Explicit effort and caps are preserved. Even low reasoning can consume an entire output cap without visible text.'),
        outputFormat: z.enum(['text', 'json-object']).optional().describe('Set json-object for JSON-only deliverables, including mechanical extraction. The entire final response (or completed stage summary) must parse as one JSON object: no prose/fences or string/array roots. Reports outputValidation separately from runtime and semantic acceptance. Budgeted tasks permit at most one shared tool-free/off format or truncation recovery within original totals; single-request never retries. Default text; reviewContract implies json-object.'),
        reviewContract: reviewContractSchema.optional().describe('Required for verification: exact caseIds, known ruleIds and required checkIds (empty if none). Supply labeled rule meanings in prompt. Adds per-item evidence and structural coverage checks only; never semantic acceptance or automatic retries. In budgeted mode the final summary contains the deliverable JSON string.'),
        reportContract: reportContractSchema.optional().describe('Typed source facts for a factual report: limits are not measurements, execution statuses are not completed work. Requires JSON {facts,prose}, defaults omitted workload to drafting/off, incompatible with reviewContract. Checks literal roles/values/units/source coverage only; prose and source truth still need parent review. Maximum 16 KiB. No semantic retry; continuation retains the same facts.'),
        effort: z.enum(['off', 'low', 'high', 'max']).optional().describe('Work request effort. Checkpoint and delivery recovery requests always use off. Reasoning shares the output token allowance.'), timeoutMs, budget,
        maxTokens: z.number().int().min(256).max(32768).optional().describe('Per-request ceiling including reasoning, never silently raised. Defaults by effort: off 4096, low 8192, high 16384, max 32768. Actual work allowance uses remaining stage output minus a checkpoint reserve of up to 2048.'),
        maxToolCalls: z.number().int().min(0).max(128).optional(),
        maxModelRequests: z.number().int().min(1).max(128).optional().describe('Per-stage ceiling including auxiliary/checkpoint calls, default 6 (minimum 2 in budgeted mode). single-request requires 1 and forbids recovery. At most one tool-free recovery per budgeted task, shared across confirmed max-tokens and explicitly checked JSON format failures; never a semantic retry.'),
        maxRequestBytes: z.number().int().min(1024).max(1048576).optional().describe('Maximum serialized model input bytes per request, default 262144. Not a tokenizer or currency estimate.'),
        capabilityProfile: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).optional().describe('files (default), inference-only, or a reviewed profile from dsh_capabilities.') }).strict(),
      run: input => manager.submit(input, preflight), write: true, network: true },
    { name: 'dsh_status', description: 'Read one task attempt and its process-cleanup status. completed means worker completion; parent acceptance is separate.',
      schema: z.object({ taskId, attempt }).strict(), run: input => manager.status(input) },
    { name: 'dsh_list', description: 'List up to 50 recent task IDs for recovery in this bridge data directory.',
      schema: z.object({}).strict(), run: () => manager.list() },
    { name: 'dsh_usage', description: 'Read saved usage for all retained tasks or one task, without model calls. Sums each stage once; legacy missing receipts stay unknown. Reported token sums, missing-call counts and unknown receipt groups are separate from conservative budget charges. Reasoning/cache fields are components, not additions to totalTokens. Admitted requests without usage do not prove billing. Local coverage only; no account bill or desktop-ledger sync. Uses bounded observation-lock retries.',
      schema: z.object({ taskId: taskId.optional() }).strict(), run: input => manager.usage(input) },
    { name: 'dsh_wait', description: 'Wait up to 30 seconds for a task and return compact status. Reuse status/result; do not submit a duplicate task.',
      schema: z.object({ taskId, timeoutMs: z.number().int().min(0).max(30000).optional() }).strict(), run: input => manager.wait(input) },
    { name: 'dsh_result', description: 'Read worker text and completion evidence. outputValidation checks whole JSON; deliveryValidation checks rule coverage; reportValidation checks literal fact roles/values/units/source coverage only. facts_preserved does not validate prose or source truth; proseAcceptance and parentAcceptance remain not_assessed. not_requested is not a pass. Runtime completed, resultAvailable and nextOffset do not establish correctness. output.kind distinguishes complete_text, partial_text, reasoning_only and empty; modelTruncated is provider truncation, outputTruncated is storage clipping. Read-only lock retries are bounded. Offsets count UTF-16 code units.',
      schema: z.object({ taskId, attempt, offset: z.number().int().min(0).max(1048576).optional(), limit: z.number().int().min(1).max(32000).optional() }).strict(),
      run: input => manager.result(input) },
    { name: 'dsh_continue', description: 'Continue a completed worker session, or a safely paused budgeted task from its checkpoint. Budgeted tasks retain the original total authorization and deadline; continuation cannot refill them. Keeps workspace, model and access. At most 16 attempts; cannot inject input while running.',
      schema: z.object({ taskId, requestId, prompt, timeoutMs }).strict(), run: input => manager.continue(input, preflight), write: true, network: true },
    { name: 'dsh_cancel', description: 'Stop the SDK-owned runtime for this task and wait for cleanup confirmation. Partial file edits remain available for review.',
      schema: z.object({ taskId }).strict(), run: input => manager.cancel(input), write: true },
    { name: 'dsh_doctor', description: 'Check local configuration and dependency versions without model calls or credential values. validation.modelCalls: 0 applies to this diagnostic only, not cumulative consumption; use dsh_usage for saved usage. Does not prove paid execution or desktop integration.',
      schema: z.object({}).strict(), run: () => doctor() },
    { name: 'dsh_capabilities', description: 'Inventory installed DSH package metadata and available reviewed worker profiles, without executing third-party code or reading credentials. Installed and runtime-verified are separate states. Use this to choose a minimal task-specific capabilityProfile.',
      schema: z.object({}).strict(), run: () => capabilities() },
  ];
  const server = new Server({ name: 'deepseek-harness-bridge', version: VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions.map(({ name, description, schema, write, network }) => ({
    name, description, inputSchema: z.toJSONSchema(schema, { target: 'draft-7' }),
    annotations: { readOnlyHint: !write, destructiveHint: !!write, idempotentHint: true, openWorldHint: !!network },
  })) }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const definition = definitions.find(item => item.name === request.params.name);
    if (!definition) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code: 'UNKNOWN_TOOL', message: 'Unknown bridge tool.' } }) }] };
    const parsed = definition.schema.safeParse(request.params.arguments ?? {});
    if (!parsed.success) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code: 'INVALID_ARGUMENT', message: 'Arguments do not match the advertised tool schema.' } }) }] };
    try {
      const result = await definition.run(parsed.data);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      const result = { error: safeError(error) };
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
  });
  return server;
}
