# Deterministic parent evidence checks

`dsh_check_result` checks an existing, explicitly pinned `taskId` and `attempt` against a parent-owned `checks` array. It never submits, continues, retries, acquires an execution lease, changes acceptance state or invokes a model. It retrieves all saved UTF-16 pages and verifies attempt identity, length and SHA-256 before parsing JSON. Failed, clipped, incomplete, unknown-truncation or unconfirmed-cleanup results produce UNKNOWN, even if a claim looks correct. Budgeted completed envelopes are unwrapped by strictly parsing their `summary` JSON object.

Each check returns PASS, FAIL or UNKNOWN with a bounded code. Aggregate status is `checks_failed` if any check fails, `incomplete` if any remains unknown, otherwise `checks_passed`. **Every response retains `parentAcceptance: not_assessed` and `sourceAuthority: not_assessed`.** Passing selected checks does not prove all claims are covered, prose is true, a citation entails a prerequisite, source files are authoritative, an exit code proves scientific success, or a result is acceptable to its parent.

Checks have unique IDs, at most 64 entries and at most 32768 UTF-8 bytes of normalized JSON. JSON pointers use the empty root or `/field` with `~0`/`~1` escapes and only own properties. Missing claims are UNKNOWN. Sensitive rejected values, source text and raw filesystem exceptions are not echoed.

| kind | Parent input | Claim and behavior |
| --- | --- | --- |
| `literal` | `pointer`, scalar `expected` | Exact value and type equality. Numbers must fit the safe integer magnitude; use strings for larger exact integers. |
| `count` | `pointer`, integer `expected` | Claim must be an array with the specified length. |
| `arithmetic` | `pointer`, `operator: sum/product`, 1–64 `operands`, optional `absoluteTolerance` | Compare a numeric claim with the JavaScript floating-point result. Tolerance defaults to zero and must be chosen by the parent before seeing the answer. Nonfinite arithmetic, unsafe integer operands/intermediates (including mixed fractional sequences), or multiplication underflow to zero are UNKNOWN. This is not exact decimal algebra. |
| `source-quote` | `pointer`, `source: {path, sha256}` | Claim must contain 1-based inclusive `startLine`, `endLine`, and `quote`. Compare the excerpt at those lines, normalizing newline conventions only. This checks location/text, not entailment. |
| `execution` | `pointer`, `receipt: {path, sha256}`, `identity: {pointer, expected}`, `exitCodePointer` | Claim must be `{identity, status: succeeded/failed}`. A JSON receipt with matching identity and a safe integer exit code is required; zero means succeeded. Definition/import/call-site existence or a missing exit code never proves execution. |
| `manual` | `reason: semantic/prerequisite/scientific` | Always UNKNOWN / PARENT_REVIEW_REQUIRED. Keep assertions separate from authoritative rules; review every asserted or newly added prerequisite and distinguish general rules from numerical execution. |

All artifact paths are relative to the saved task workspace and use its existing protected-name, byte and link policy. Absolute paths, parent traversal, protected files and escaping links are rejected. Sources must match the parent-pinned SHA-256, be valid UTF-8 text without NUL bytes, and fit the existing 256 KiB file limit. Changed, unavailable, binary or oversized evidence is UNKNOWN. Receipts and hashes can also come from untrusted writers: the parent must establish their authority independently. A valid locator or matching file alone does not establish entailment.

Example checks file (an array, not the task arguments):

```json
[
  {"id":"row-count","kind":"count","pointer":"/rows","expected":21},
  {"id":"total","kind":"arithmetic","pointer":"/total","operator":"sum","operands":[5,8,8]},
  {"id":"prerequisites","kind":"manual","reason":"prerequisite"}
]
```

Call the MCP tool with `{taskId, attempt, checks}` or use `node scripts/check-result.js TASK_UUID ATTEMPT CHECKS_JSON_FILE`. The CLI emits JSON and exits 0 only for `checks_passed`; incomplete/failed checks exit 1. It reads at most 32768 bytes of the checks file, starts an observation-only local MCP connection with the current Node runtime, honors configured state-directory precedence without decrypting credentials, and drains child diagnostics. No output is written back to the task store. The original raw result and failure evidence remain available for independent review.
