# Reading a complete saved result

`dsh_result.limit` counts UTF-16 code units, defaults to **16000**, and cannot exceed
**32000**. A request for `50000` is a schema error before task-manager execution.
The existing eleven MCP tools and the result input limits are unchanged.

Each available result page also returns:

```json
{
  "taskId": "task UUID",
  "sessionId": "saved session ID",
  "number": 1,
  "requestId": "attempt request ID",
  "offset": 0,
  "nextOffset": 16000,
  "resultAvailable": true,
  "text": "saved result page",
  "resultPage": {
    "unit": "utf16-code-units",
    "totalCharacters": 40000,
    "sha256": "SHA-256 of the whole saved text encoded as UTF-8"
  }
}
```

`nextOffset: null` ends the saved artifact. `resultAvailable: false` means its file
is missing, rather than an empty successful result. An empty available artifact
has zero total characters and a SHA-256 for the empty string. Historical behavior
for a manually requested offset beyond the end remains an empty page.

Use the exported reader with an existing MCP client:

```js
import { readCompleteResult } from './src/result-reader.js';

const saved = await readCompleteResult(request => client.callTool(request), {
  taskId: existingTaskId,
  attempt: 1,             // Recommended when the parent already observed it.
  limit: 16000,           // Optional; this is the default.
  parseJson: true,        // Optional; requires a JSON object root.
});
// saved.text contains the whole saved text; saved.json is parsed only now.
// saved.receipt retains the last page's lifecycle and validation evidence.
```

For a parent tool adapter, pass the same `{name, arguments}` request to the
existing `dsh_result` tool and return its MCP response or unwrapped result object.
Only that tool is called. No submit, continuation, wait loop, or automatic retry
is performed. If attempt is omitted initially, the first returned `number` pins
every later call. The reader validates task/session/request/attempt identity,
terminal status, total length, digest, truncation evidence, contiguous offsets,
page length, forward progress, and the exact terminal boundary. It verifies the
assembled digest before attempting JSON parsing. A surrogate pair may straddle
pages; join JavaScript strings before encoding or parsing them.

The executable adapter opens a separate read-only MCP connection to the packaged
bridge using the current Node executable. Point it at the same retained store as
the original task, and run under Node 24.18+:

```powershell
$env:DSH_BRIDGE_DATA_DIR = 'C:\path\to\retained-bridge-state'
& 'C:\path\to\node.exe' '.\scripts\read-result.js' 'TASK_UUID' 1 --json
```

It writes a JSON result to stdout and closes its client/transport. Omit `--json`
to retrieve text without a JSON content check. No credentials are put in command
arguments; observation does not require a provider key. Use the same state and
configuration directory environment as the original bridge installation. This
script reads existing task state and never requests an execution lease.
It applies the launcher's store precedence: explicit `DSH_BRIDGE_DATA_DIR`, then
`localConfig().dataDir`, then the existing `PLUGIN_DATA` / `CLAUDE_PLUGIN_DATA` /
user-home default in `index.js`. It uses the current Node executable and does not
apply `config.nodePath`, read `api-key.dpapi`, or decrypt a provider credential.
Bridge child stderr is drained privately rather than forwarded.

Failure classes are separate:

| Evidence | Reader outcome |
| --- | --- |
| Bad input, including limit 50000 | `category: input`, no tool calls |
| Transport/tool error, missing artifact, invalid page, changed identity, length/digest mismatch | `category: read`; validated prefix retained in `error.partial`, `complete: false` |
| All saved pages read, provider or storage clipping recorded | `retrieval.complete: true`, separate `truncation.model` and `truncation.storage`; JSON mode raises `RESULT_TRUNCATED` in `category: content` and retains `error.result` |
| All saved pages read but invalid JSON or non-object root | `INVALID_JSON` or `INVALID_JSON_OBJECT`, `category: content`, full `error.result` retained |

The CLI prints these safe categories/codes and retained evidence to stderr and
exits nonzero on failure. A retryable observation error is still surfaced to the
parent; this reader does not retry it. Its original safe bridge code is retained
as the error cause in the module API.
An available page can contain a normal attempt-level `error` alongside a failed
runtime status; that is preserved as execution evidence. Only an MCP `isError`
or a standalone error envelope is a failed observation. Failed execution alone
does not make a successful artifact read fail.

Reading the whole artifact establishes retrieval completeness only. Model
truncation, storage clipping, task execution status, output-format validation,
delivery/report/lifecycle checks, and parent semantic acceptance remain separate.
Missing historical truncation evidence is returned as `null` (unknown), rather
than asserted false; successful JSON parsing does not resolve that uncertainty.
In budgeted mode an outer JSON envelope may contain a `summary` JSON string:
parse that inner string only after validating the complete outer object. This
reader does not accept the inner deliverable or prove its claims.

The metadata describes the saved UTF-8-decoded text, rather than an independent
signature of provider output or a scientific acceptance criterion. Each page
recomputes the digest from that attempt's file, detecting changed content across
pages; ordinary attempts publish their result before terminal status and retain
separate files for later attempts. A modified artifact consistently present
before the first read is outside this cross-page consistency check.
