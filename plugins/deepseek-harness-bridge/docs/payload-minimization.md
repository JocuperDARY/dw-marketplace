# Minimal user prompts and rejection evidence

`dsh_prepare_payload` is a local pure operation. The parent supplies an `objective` with `text` and `classification`, plus optional `segments` with unique `id`, `role`, `classification` and `text`. Roles are `authority`, `assertion` and `fact`; classifications are `general`, `synthetic` and `internal`. These are **parent declarations**, not verified truth, entitlement or automatic secret detection.

By default only general/synthetic entries are included. Optional `includeIds` selects the exact set (up to 65 IDs), including reserved ID `objective`; internal entries require explicit selection. An internal objective therefore requires explicit selection. Segment IDs cannot be `objective`. Input and rendered prompt each have a 65536 UTF-8 byte boundary; at most 64 segments. Duplicate/unknown IDs and size constraints are checked at admission beyond the public JSON Schema. Errors report schema-owned fields without rejected content.

```json
{
  "objective": {"text": "Audit this synthetic eligibility claim.", "classification": "synthetic"},
  "segments": [
    {"id": "rule", "role": "authority", "classification": "general", "text": "Eligibility requires a positive value."},
    {"id": "claim", "role": "assertion", "classification": "synthetic", "text": "Eligibility also requires an even value."}
  ]
}
```

The response's `submission` contains `prompt` and `payloadSha256`. Copy those unchanged into `dsh_plan`/`dsh_submit` alongside normal request/workspace/options. The optional hash is checked before task state or credentials are accessed; changing even whitespace invalidates it. This is exact **UTF-8 user-prompt identity**, not a hash of the full provider request. SDK instructions, delivery contracts, prior session context and files/tool results may add input later. Capability and access authorization still govern those channels.

The manifest lists destination (`deepseek-official` / `deepseek-flash`), selected/omitted IDs and parent-declared categories, byte count and explicit identity scope. Omitted bodies are not returned. The preparation API neither reads source files nor scans credentials nor calls a model. It does not recognize secrets mislabeled as general/synthetic. Selection and a digest never grant outbound approval. Obtain any applicable user/host approval for the actual content and context; never retry an approval rejection as a model failure.

`dsh_record_rejection` accepts only `requestId`, `payloadSha256`, `taskId: null`, and reason `host-approval-rejected` or `invalid-arguments`. Use it only when no task receipt exists. Do not place content, paths or secrets in the identifier. It records the parent's claim; `independentlyVerified: false`, `modelUsage: null` and `admission: reported-not-admitted` must remain visible. It does not independently prove provider execution or billing. Its local operation makes zero model calls and grants no retry authorization.

Records live in `<dataDir>/rejections-v1`, outside task records/registries. Request IDs are unique across this rejection directory: exact duplicates return the original timestamp; different evidence for the same ID fails with `REJECTION_CONFLICT` without overwriting it. Publication is immutable and atomic, including concurrent duplicates. No task execution lock is acquired. These reports are excluded from `dsh_list`, `dsh_usage` and model-quality denominators; missing provider usage stays unknown. This is local evidence retention, not a cryptographically authenticated host audit log.

Single-request no-retry, cumulative budgets and historical task evidence are unchanged. The parent must separately review source authority, natural-language reasoning and delivery correctness.
