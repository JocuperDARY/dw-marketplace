import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { BridgeError, safeError } from './errors.js';
import { capabilities } from './capabilities.js';
import { normalizeReviewContract, reviewContractSchema } from './delivery.js';
import { normalizeReportContract, reportContractSchema } from './report.js';
import { lifecycleContractSchema, normalizeLifecycleContract } from './lifecycle.js';
import { prepareNativeWorkspace } from './native-workspace.js';
import { inputPrompt } from './submission-plan.js';
import { validateNativeSelection } from './planning.js';
import { checkResultSchema, normalizeEvidenceChecks } from './parent-evidence.js';
import { recoveryMilestonesSchema, normalizeRecoveryMilestones } from './recovery-progress.js';

export const VERSION = '3.5.0';
const taskId = z.string().uuid();
const controlToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional().describe('Opaque capability returned only by initial submit. Required to continue or cancel from another connection. Keep in the parent chat; never include in worker prompts or shared reports.');
const scope = z.enum(['connection', 'store']).optional().describe('Default connection lists this connection’s owned tasks. Explicit store includes all retained tasks and historical read-only records for recovery; it grants no execution control.');
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

const submissionSchema = z.object({ requestId, prompt, parentLabel: z.string().max(160).optional().describe('Optional display label for the parent chat; not authorization or a secret.'), workspace: z.string().min(1).describe('Absolute existing workspace directory, disjoint from bridge state. Native Windows Shell requires worker-account ownership and no junction ancestry; use dsh_prepare_workspace for a new independent directory.'),
  recoveryMilestones: recoveryMilestonesSchema.optional().describe('Budgeted mode only: optional parent-declared workspace JSON artifacts with exact scalar assertions. Unique IDs and at most 32768 UTF-8 bytes. A newly satisfied milestone during a successful ordinary checkpoint can renew text-only recovery once; pre-existing artifacts, prose changes and recovery stages cannot. IDs are consumed once, original totals never reset, and matching artifacts do not prove source authority or semantic acceptance. Omit to retain a single recovery episode.'),
  access: z.enum(['read-only', 'workspace-write']).optional(),
  executionMode: z.enum(['automatic', 'budgeted', 'single-request']).optional().describe('Default automatic with no invented resource caps; supplying budget enables persistent total accounting. Explicit single-request always means one inference-only request, zero tools, no retry or continuation.'),
  workload: z.enum(['mechanical', 'drafting', 'standard', 'reasoning', 'verification']).optional().describe('Selects reasoning effort only: mechanical/drafting off; standard low; reasoning/verification high. Prefer reasoning for geometric transforms, slicing/broadcasting, numerical boundaries, cross-file control flow and runtime diagnosis; routine implementation may use standard. Verification requires reviewContract or lifecycleContract. Does not create token limits. Explicit effort and caps are preserved; reasoning shares the provider output allowance.'),
  outputFormat: z.enum(['text', 'json-object']).optional().describe('Set json-object for JSON-only deliverables, including mechanical extraction. The entire final response (or completed stage summary) must parse as one JSON object: no prose/fences or string/array roots. Reports outputValidation separately from runtime and semantic acceptance. New budgeted tasks permit one initial tool-free/off recovery; parent-declared verified progress can renew later episodes within original totals. Without recoveryMilestones, only one episode is available. Single-request never retries. Default text; every delivery contract implies json-object.'),
  reviewContract: reviewContractSchema.optional().describe('Per-case rule coverage for verification: exact caseIds, known ruleIds and required checkIds (empty if none). Supply labeled rule meanings in prompt. Adds per-item evidence and structural coverage checks only; never semantic acceptance or automatic retries. In budgeted mode the final summary contains the deliverable JSON string.'),
  reportContract: reportContractSchema.optional().describe('Typed source facts for a factual report: limits are not measurements, execution statuses are not completed work. Requires JSON {facts,prose}, defaults omitted workload to drafting/off, incompatible with reviewContract/lifecycleContract. Checks literal roles/values/units/source coverage only; prose and source truth still need parent review. Additional admission checks require unique facts[].id values and at most 16384 UTF-8 bytes in the JSON-serialized contract; JSON Schema cannot express these checks. Rejections identify validation.phase=contract and safe field paths. No semantic retry; continuation retains the same facts.'),
  lifecycleContract: lifecycleContractSchema.optional().describe('Parent-declared ordered lifecycle outcomes: unique statuses and cases with allowedStatuses, exact slotReusable boolean and nonblank basis. Unique case IDs, allowed-status vocabulary membership and at most 16384 UTF-8 bytes of normalized JSON are additional admission checks. Implies JSON and defaults omitted workload/effort to verification/high without adding resource caps. Incompatible with reviewContract/reportContract. Checks literal rows/order/outcomes/counts only; caveats, source truth and parent acceptance remain unassessed. Safe field errors precede task admission; no semantic retries or budget increase.'),
  effort: z.enum(['off', 'low', 'high', 'max']).optional().describe('Work request effort. Checkpoint and delivery recovery requests always use off. Reasoning shares the output token allowance.'), timeoutMs, budget,
  maxTokens: resourceLimit().describe('Optional user-specified per-request output ceiling including reasoning. Omitted/null adds no bridge ceiling; the official adapter still has model/provider defaults and constraints, reported separately. Never call a large finite value unlimited.'),
  maxToolCalls: resourceLimit(0).describe('Optional user-specified per-stage tool-call ceiling. Omitted/null is unspecified, except single-request/inference-only permits no tools.'),
  maxModelRequests: resourceLimit().describe('Optional user-specified per-stage model-call ceiling. Omitted/null is unspecified; explicit single-request remains exactly one request.'),
  maxRequestBytes: resourceLimit().describe('Optional user-specified serialized model-input byte ceiling. Omitted/null adds no bridge request-byte cap; protocol, file and storage constraints are separate.'),
  nativePlugins: z.array(z.enum(['skills', 'files', 'shell', 'teams'])).optional().describe('Only permitted with the effective native capability profile. Omit this field for inference-only (including single-request), files and custom profiles; even [] is invalid there. With native, omission selects compatible capabilities for the access mode and [] disables native extensions. Skills are searched in DSH first; supplemental skill text is used only when no suitable native skill exists.'),
  capabilityProfile: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).optional().describe('native (default), files, inference-only, or a configured profile. single-request defaults to inference-only. Installed, registered, called and model-applied are separate evidence.') }).strict();

function validateSubmissionContracts(input) {
  inputPrompt(input.prompt);
  validateNativeSelection(input);
  normalizeRecoveryMilestones(input.recoveryMilestones, input.executionMode ?? (input.budget !== undefined ? 'budgeted' : 'automatic'));
  // Pure contract checks precede connection ownership, credentials and task admission.
  normalizeReviewContract(input.reviewContract);
  normalizeReportContract(input.reportContract);
  normalizeLifecycleContract(input.lifecycleContract);
  if (input.lifecycleContract && (input.reviewContract || input.reportContract || input.outputFormat === 'text')) {
    throw new BridgeError('INVALID_ARGUMENT', 'lifecycleContract requires JSON object output and cannot be combined with another delivery contract.', {
      validation: { phase: 'contract', issues: [{ path: ['lifecycleContract'], code: 'invalid_value' }] },
    });
  }
}

export function createServer({ manager, doctor, preflight = () => {} }) {
  const definitions = [
    { name: 'dsh_check_result', description: 'Check one pinned complete saved result against parent-declared literal facts, counts, arithmetic, source quotes and execution receipts. Reads bounded workspace files using pinned SHA-256. Returns per-item PASS/FAIL/UNKNOWN; missing, clipped, failed or inconsistent evidence never passes. No model calls, retries, execution locks or state writes. This is deterministic evidence checking only: source authority, natural-language entailment and parent/scientific acceptance remain not_assessed.',
      schema: checkResultSchema, run: input => { normalizeEvidenceChecks(input.checks); return manager.checkResult(input); } },
    { name: 'dsh_prepare_workspace', description: 'Create one NEW independent workspace directory under an existing parent, with the bridge host account as owner. Zero model calls; does not adopt existing directories or change existing ownership/ACLs. Use before native Shell tasks when a Codex-created directory belongs to a different sandbox account. Existing delivered files remain untouched.',
      schema: z.object({ workspace: z.string().min(1).describe('Absolute path of a new, absent directory under an existing parent; must be disjoint from bridge state.'), stageRuntimeSupport: z.boolean().optional().describe('Opt in to staging the packaged Windows process launcher and current bridge Node path/version into the NEW workspace. Default false leaves it empty. Does not execute or probe tools; child/native Shell execution remains unverified.') }).strict(),
      run: input => prepareNativeWorkspace({ ...input, dataDir: manager.options?.dataDir ?? manager.dataDir }), write: true, destructive: false, idempotent: false },
    { name: 'dsh_plan', description: 'Preview a NEW submission using the same argument schema and normalization as submit, without credentials, model calls, worker starts, task-record reads, state writes or execution locks. Shows effective limits, caller versus omitted settings, warnings, recovery and continuation constraints. Does not authorize the payload, reserve admission, validate replay or prove runtime/content acceptance. Existing tasks retain their saved policies.',
      schema: submissionSchema, run: input => { validateSubmissionContracts(input); return manager.plan(input); } },
    { name: 'dsh_submit', description: 'Start an independent official DeepSeek Flash worker for the assigned scope. Omitted resource limits stay unspecified; preserve user-specified limits and ask before adding discretionary caps. Prefer relevant DSH-native skills and compatible plugins, loading skill bodies only when selected. Rule verification uses verification/reviewContract or declared lifecycleContract outcomes; factual reports use reportContract. completed never means parent acceptance. Explicit single-request permits one inference call without tools or continuation. Returns immediately; never reuses a desktop conversation.',
      schema: submissionSchema,
      run: input => {
        validateSubmissionContracts(input);
        return manager.submit(input, preflight);
      }, write: true, network: true },
    { name: 'dsh_status', description: 'Read one task attempt and its process-cleanup status. completed means worker completion; parent acceptance is separate.',
      schema: z.object({ taskId, attempt }).strict(), run: input => manager.status(input) },
    { name: 'dsh_list', description: 'Read up to 50 recent tasks without taking an execution lease. Default connection scope; explicit store scope includes other connections and historical records. activeTaskIds may contain several tasks; observation never interrupts or recovers them.',
      schema: z.object({ scope }).strict(), run: input => manager.list(input) },
    { name: 'dsh_usage', description: 'Read saved usage for this connection, explicit store scope, or one task, without model calls. Sums each stage once; legacy missing receipts stay unknown. Reported token sums, missing-call counts and unknown receipt groups are separate from conservative budget charges. Reasoning/cache fields are components, not additions to totalTokens. Admitted requests without usage do not prove billing. Local coverage only; no account bill or desktop-ledger sync. Observations acquire no execution lease.',
      schema: z.object({ taskId: taskId.optional(), scope }).strict(), run: input => manager.usage(input) },
    { name: 'dsh_wait', description: 'Wait up to 30 seconds for a task and return compact status. Reuse status/result; do not submit a duplicate task.',
      schema: z.object({ taskId, timeoutMs: z.number().int().min(0).max(30000).optional() }).strict(), run: input => manager.wait(input) },
    { name: 'dsh_result', description: 'Read worker text and completion evidence. limit is at most 32000 UTF-16 code units per page (default 16000); offset and nextOffset use UTF-16 code units. Pin the returned number as attempt on later pages. resultPage reports totalCharacters and saved-text SHA-256 for complete reassembly; parse JSON only after all pages pass identity, offset and digest checks. lifecycleValidation checks declared per-case statuses/reuse and counts; consistent does not validate caveats or source rules. outputValidation checks whole JSON; deliveryValidation checks rule coverage; reportValidation checks literal fact roles/values/units/source coverage only. facts_preserved does not validate prose or source truth; proseAcceptance and parentAcceptance remain not_assessed. not_requested is not a pass. Runtime completed, resultAvailable and nextOffset do not establish correctness. output.kind distinguishes complete_text, partial_text, reasoning_only and empty; modelTruncated is provider truncation, outputTruncated is storage clipping. Observations never recover or interrupt another task.',
      schema: z.object({ taskId, attempt, offset: z.number().int().min(0).max(1048576).optional(), limit: z.number().int().min(1).max(32000).optional().describe('Page length in UTF-16 code units: minimum 1, maximum 32000, default 16000. Use nextOffset and an explicit attempt to read subsequent pages; never request 50000.') }).strict(),
      run: input => manager.result(input) },
    { name: 'dsh_continue', description: 'Continue one completed worker session or safely paused budgeted task. Other connections require its controlToken. Retains original totals, deadlines, workspace, model, access and capabilities; unspecified limits remain unspecified. Only one attempt may own the session. Single-request and historical pre-v3 tasks cannot continue. A running attempt returns a conflict without launching another worker.',
      schema: z.object({ taskId, requestId, prompt, timeoutMs, controlToken }).strict(), run: input => manager.continue(input, preflight), write: true, network: true },
    { name: 'dsh_cancel', description: 'Request cancellation of exactly this task attempt and wait for its owner to confirm SDK runtime cleanup. Other connections require its controlToken. A pending acknowledgement is not confirmed cancellation. Other tasks keep running; partial edits remain available.',
      schema: z.object({ taskId, controlToken, timeoutMs: z.number().int().min(0).max(30000).optional().describe('Wait for cancellation acknowledgement, not an execution budget. Zero returns without waiting.') }).strict(), run: input => manager.cancel(input), write: true },
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
    try {
      const parsed = definition.schema.safeParse(request.params.arguments ?? {});
      if (!parsed.success) throw new BridgeError('INVALID_ARGUMENT', 'Arguments do not match the advertised tool schema.', {
        validation: { phase: 'schema', issues: parsed.error.issues },
      });
      const result = await definition.run(parsed.data);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      const result = { error: safeError(error) };
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
  });
  return server;
}
