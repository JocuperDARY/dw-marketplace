const FIELDS = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'];
const count = value => Number.isSafeInteger(value) && value >= 0;

function validReceipt(receipt) {
  return receipt && count(receipt.modelRequests) && Array.isArray(receipt.calls)
    && receipt.calls.length === receipt.modelRequests
    && receipt.calls.every((call, index) => call?.number === index + 1);
}

/** Counts each stage once; an attempt's last-stage receipt is only a legacy fallback. */
function receipts(record) {
  if (!record.orchestration) return record.attempts.map(attempt => attempt.budget);
  const groups = [];
  for (const attempt of record.attempts) {
    const stages = record.orchestration.stages.filter(stage => stage.attempt === attempt.number);
    if (!stages.length) { groups.push(null); continue; }
    for (const stage of stages) {
      if (stage.status === 'cancelled' && stage.charged.modelRequests === 0 && !stage.terminal) continue;
      const receipt = stage.budget ?? attempt.budget;
      groups.push(receipt?.nonce === stage.nonce ? receipt : null);
    }
  }
  return groups;
}

export function summarizeUsage(records) {
  const summary = { scope: 'retained_local_receipts', tasks: records.length, attempts: 0, stages: 0,
    recordedModelRequests: 0, finishedModelRequests: 0, unknownReceiptGroups: 0,
    tokens: Object.fromEntries(FIELDS.map(key => [key, { reported: 0, missingCalls: 0 }])),
    orchestrationCharged: { modelRequests: 0, outputTokens: 0, toolCalls: 0 },
    attemptStatuses: {}, cost: null, modelCallsPerformed: 0 };
  for (const record of records) {
    summary.attempts += record.attempts.length;
    for (const attempt of record.attempts) {
      const status = ['running', 'cancelling', 'completed', 'paused', 'failed', 'timed_out', 'cancelled', 'interrupted', 'cleanup_failed', 'state_write_failed'].includes(attempt.status) ? attempt.status : 'unknown';
      summary.attemptStatuses[status] = (summary.attemptStatuses[status] ?? 0) + 1;
    }
    for (const stage of record.orchestration?.stages ?? []) {
      summary.stages++;
      for (const key of Object.keys(summary.orchestrationCharged)) summary.orchestrationCharged[key] += stage.charged[key];
    }
    for (const receipt of receipts(record)) {
      if (!validReceipt(receipt)) { summary.unknownReceiptGroups++; continue; }
      summary.recordedModelRequests += receipt.modelRequests;
      for (const call of receipt.calls) {
        if (call.finished === true) summary.finishedModelRequests++;
        for (const key of FIELDS) {
          const value = call.usage?.[key];
          const field = summary.tokens[key];
          if (count(value) && count(field.reported + value)) field.reported += value;
          else field.missingCalls++;
        }
      }
    }
  }
  return summary;
}
