import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { safeError } from './errors.js';
import { capabilities } from './capabilities.js';
import { reviewContractSchema } from './delivery.js';
import { reportContractSchema } from './report.js';
import { prepareNativeWorkspace } from './native-workspace.js';

export const VERSION = '2.0.0-native.1';
const taskId = z.string().uuid();
const requestId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/);
const prompt = z.string().min(1).max(65536).describe('Bounded assignment with context, file ownership, acceptance criteria and required evidence.');
const timeoutMs = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional().describe('Explicit wall-clock attempt/stage ceiling in milliseconds. Omitted/null means no bridge task timeout. Initialization/transport/teardown deadlines are reported separately.');
const attempt = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional();
const resourceLimit = (minimum = 1) => z.number().int().min(minimum).max(Number.MAX_SAFE_INTEGER).nullable().optional();
const budget = z.object({
  totalModelRequests: resourceLimit(),
  totalOutputTokens: resourceLimit(),
  totalToolCalls: resourceLimit(0),
  totalDurationMs: resourceLimit(),
}).strict().optional().describe('Optional user-specified totals across stages and continuations. Each omitted/null total is unspecified, not a default finite allowance. Output includes reasoning. Never invent limits when the user did not supply them; ask if a discretionary cap is needed. Totals are not a currency cap.');

export function createServer({ manager, doctor, preflight = () => {} }) {
  const definitions = [
    { name: 'dsh_prepare_workspace', description: 'Create one NEW independent workspace directory under an existing parent, with the bridge host account as owner. Zero model calls; does not adopt existing directories or change existing ownership/ACLs. Use before native Shell tasks when a Codex-created directory belongs to a different sandbox account. Existing delivered files remain untouched.',
      schema: z.object({ workspace: z.string().min(1).describe('Absolute path of a new, absent directory under an existing parent; must be disjoint from bridge state.') }).strict(),
      run: input => prepareNativeWorkspace({ ...input, dataDir: manager.options?.dataDir ?? manager.dataDir }), write: true, destructive: false, idempotent: false },
    { name: 'dsh_submit', description: 'Start an independent official DeepSeek Flash worker for the assigned scope. Omitted resource limits stay unspecified; preserve user-specified limits and ask before adding discretionary caps. Prefer relevant DSH-native skills and compatible plugins, loading skill bodies only when selected. Rule verification uses verification/reviewContract; factual reports use reportContract. completed never means parent acceptance. Explicit single-request permits one inference call without tools or continuation. Returns immediately; never reuses a desktop conversation.',
      schema: z.object({ requestId, prompt, workspace: z.string().min(1).describe('Absolute existing workspace directory, disjoint from bridge state. Native Windows Shell requires worker-account ownership and no junction ancestry; use dsh_prepare_workspace for a new independent directory.'),
        access: z.enum(['read-only', 'workspace-write']).optional(),
        executionMode: z.enum(['automatic', 'budgeted', 'single-request']).optional().describe('Default automatic with no invented resource caps; supplying budget enables persistent total accounting. Explicit single-request always means one inference-only request, zero tools, no retry or continuation.'),
        workload: z.enum(['mechanical', 'drafting', 'standard', 'reasoning', 'verification']).optional().describe('Selects reasoning effort only: mechanical/drafting off; standard low; reasoning/verification high. Verification requires reviewContract. Does not create token limits. Explicit effort and caps are preserved; reasoning shares the provider output allowance.'),
        outputFormat: z.enum(['text', 'json-object']).optional().describe('Set json-object for JSON-only deliverables, including mechanical extraction. The entire final response (or completed stage summary) must parse as one JSON object: no prose/fences or string/array roots. Reports outputValidation separately from runtime and semantic acceptance. Budgeted tasks permit at most one shared tool-free/off format or truncation recovery within original totals; single-request never retries. Default text; reviewContract implies json-object.'),
        reviewContract: reviewContractSchema.optional().describe('Required for verification: exact caseIds, known ruleIds and required checkIds (empty if none). Supply labeled rule meanings in prompt. Adds per-item evidence and structural coverage checks only; never semantic acceptance or automatic retries. In budgeted mode the final summary contains the deliverable JSON string.'),
        reportContract: reportContractSchema.optional().describe('Typed source facts for a factual report: limits are not measurements, execution statuses are not completed work. Requires JSON {facts,prose}, defaults omitted workload to drafting/off, incompatible with reviewContract. Checks literal roles/values/units/source coverage only; prose and source truth still need parent review. Maximum 16 KiB. No semantic retry; continuation retains the same facts.'),
        effort: z.enum(['off', 'low', 'high', 'max']).optional().describe('Work request effort. Checkpoint and delivery recovery requests always use off. Reasoning shares the output token allowance.'), timeoutMs, budget,
        maxTokens: resourceLimit().describe('Optional user-specified per-request output ceiling including reasoning. Omitted/null adds no bridge ceiling; the official adapter still has model/provider defaults and constraints, reported separately. Never call a large finite value unlimited.'),
        maxToolCalls: resourceLimit(0).describe('Optional user-specified per-stage tool-call ceiling. Omitted/null is unspecified, except single-request/inference-only permits no tools.'),
        maxModelRequests: resourceLimit().describe('Optional user-specified per-stage model-call ceiling. Omitted/null is unspecified; explicit single-request remains exactly one request.'),
        maxRequestBytes: resourceLimit().describe('Optional user-specified serialized model-input byte ceiling. Omitted/null adds no bridge request-byte cap; protocol, file and storage constraints are separate.'),
        nativePlugins: z.array(z.enum(['skills', 'files', 'shell', 'teams'])).optional().describe('Optional native capability selection; omit to inspect/use compatible capabilities for the access mode. Explicit [] disables native extensions. Skills are searched in DSH first; supplemental skill text is used only when no suitable native skill exists.'),
        capabilityProfile: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).optional().describe('native (default), files, inference-only, or a configured profile. single-request defaults to inference-only. Installed, registered, called and model-applied are separate evidence.') }).strict(),
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
    { name: 'dsh_continue', description: 'Continue a completed worker session, or a safely paused budgeted task. Explicit totals and deadlines are retained; unspecified limits stay unspecified. Keeps workspace, model, access and capability contract. Cannot inject input while running; single-request cannot continue. Legacy tasks retain their original boundaries.',
      schema: z.object({ taskId, requestId, prompt, timeoutMs }).strict(), run: input => manager.continue(input, preflight), write: true, network: true },
    { name: 'dsh_cancel', description: 'Stop the SDK-owned runtime for this task and wait for cleanup confirmation. Partial file edits remain available for review.',
      schema: z.object({ taskId }).strict(), run: input => manager.cancel(input), write: true },
    { name: 'dsh_doctor', description: 'Check local configuration and dependency versions without model calls or credential values. validation.modelCalls: 0 applies to this diagnostic only, not cumulative consumption; use dsh_usage for saved usage. Does not prove paid execution or desktop integration.',
      schema: z.object({}).strict(), run: () => doctor() },
    { name: 'dsh_capabilities', description: 'Read installed DSH metadata and resolve native or configured component profiles without executing them or reading credentials. Pass access/workspace for the intended task. Registration, actual calls, skill loads and shared usage are evidenced by task results, not this inventory. Includes remaining SDK/native implementation constraints.',
      schema: z.object({ workspace: z.string().optional(), access: z.enum(['read-only', 'workspace-write']).optional(), nativePlugins: z.array(z.enum(['skills', 'files', 'shell', 'teams'])).optional() }).strict(), run: input => capabilities(undefined, input) },
  ];
  const server = new Server({ name: 'deepseek-harness-bridge', version: VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions.map(({ name, description, schema, write, network, idempotent = true, destructive = !!write }) => ({
    name, description, inputSchema: z.toJSONSchema(schema, { target: 'draft-7' }),
    annotations: { readOnlyHint: !write, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: !!network },
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
