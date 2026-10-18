// Synthetic public rule fixture; no project paths, historical receipts or private data.
export const contract = { caseIds: ['C05', 'C06'], ruleIds: ['AUDIT', 'SCRATCH', 'READER', 'TOTAL'], checkIds: ['CACHE_SUM'] };
export const correct = {
  cases: [
    { id: 'C05', classification: 'audit', ruleIds: ['AUDIT'], basis: 'Across both roots, 40 + 25 = 65 MiB exceeds the shared 64 MiB cap.', expected: 'STOP audit cap', uncertainty: 'none' },
    { id: 'C06', classification: 'scratch', ruleIds: ['SCRATCH', 'READER', 'TOTAL'], basis: 'RUN_ROOT/launch/tmp/foo/state-before.jsonl is an anchored scratch descendant, not a fixed root reader. 80 MiB counts toward total only; audit is zero.', expected: 'PASS byte caps: 80 MiB <= 512 MiB; other gates are separate.', uncertainty: 'Other identity gates are not evaluated.' },
  ],
  checks: [{ id: 'CACHE_SUM', basis: '39340819 bytes + 35331611 bytes', result: '74672430 bytes; not a peak-memory bound.' }],
  uncertainty: 'No tests executed by this inference-only worker.', nextAction: 'Parent independently verifies cases, thresholds and arithmetic before adopting tests.',
};

export function wrongDraft() {
  const value = structuredClone(correct);
  value.cases[0].basis = '40 + 25 = 65 MiB; 70 MiB cap is cross-root.';
  value.cases[1].classification = 'audit';
  value.cases[1].basis = 'Not a fixed root reader, therefore audit; 80 MiB exceeds 64 MiB.';
  value.cases[1].expected = 'STOP audit cap';
  value.checks = [];
  return value;
}
