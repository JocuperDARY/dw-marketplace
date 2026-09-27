# Development Workflow

> The `development-workflow` Skill is authoritative. This always-loaded rule keeps only the cross-stage invariants; load the relevant child Skill for detailed execution.

## Invariants

1. **Use auditable edits.** Manual changes use the current runtime's structured mechanism, such as Claude Code `Edit`/`Write` or Codex `apply_patch`. Repository formatters and generators remain valid deterministic tools.
2. **Protect sensitive data.** Do not print secrets or send project data to an unauthorized external tool.
3. **Respect authorization.** Do not stage, commit, push, deploy, message, or change external state unless the user requested that action.
4. **Choose a minimal sufficient tool set.** Discover declared capabilities instead of assuming names. Use CodeGraph first only when `.codegraph/` exists; otherwise use `rg` and focused file reads.
5. **Require fresh evidence.** A completion claim names the command/check, outcome, and any unverified residual risk.
6. **Reclaim owned child processes, development servers, and other resources through an observation gate.** Begin with a bounded read-only baseline and current compound identity; a schedule, PID, name, path, age, timeout, low load, no output, historical event, or suspected-hung label grants no stop authority. Use graceful-first recovery, verify exact absence, and compare at least three same-method samples over a 15-second-or-longer post-action window. Normal teardown requires a valid teardown reason or condition. Incident response or persistent repair additionally requires the applicable cause to be confirmed. Missing required ownership, identity, authorization, teardown evidence, applicable cause evidence, or post-action observation is `HOLD`/`UNVERIFIED`.
7. **Use the canonical collaboration protocol.** When work needs child delegation, interactive messages, a resource ledger, lifecycle recovery, or multi-agent execution evidence, route through [dw-collaboration](../skills/dw-collaboration/SKILL.md). Select topology from freshly observed capabilities, serialize shared writes, and reclaim only exact verified task-owned resources.
8. **Trace important changes.** When this workflow is active, record complete before/after content with reasons for important files, keep old versions until they are proven valueless, and apply the B6 approval process before critical additions or deletions.
9. **Make the next step clear.** Frame ordinary advice around what to do and why. For status, handoffs, and review findings, state the scope, completed work, current facts, and evidence-supported conclusions, then what remains uncertain and what comes next. Support a claim that something remains unchanged with the check performed and its coverage. Use explicit restrictions when an applicable authorization, protected-scope, safety/resource, evidence, budget, or confirmed-failure boundary actually limits an action or claim; preserve required prohibitions, stops, HOLD states, and failure findings, and explain the condition for proceeding where relevant.


## Scale By Risk

| Level | Typical conditions | Minimum process |
|-------|--------------------|-----------------|
| Light | Local, reversible, no runtime behavior change | Goal + focused edit + static check + diff review |
| Standard | Behavior change, bug fix, or multiple related files | Traceable plan + regression evidence + relevant gates + 3C |
| High | Security/data/production, cross-module, irreversible, or external side effects | Written design + rollback/backup + expanded tests/review + explicit authorization points |

File count informs impact but does not determine risk by itself. An urgent change may shorten explanation, but it does not remove rollback and correctness evidence.

## Route By Task

- **Diagnose/review only:** gather evidence and report findings; do not modify files unless fixing was requested.
- **Bug fix:** reproduce -> identify the root cause -> add a failing regression -> fix -> verify.
- **Feature:** clarify contract -> choose a plan proportional to risk -> test behavior -> implement -> verify.
- **Performance:** establish a representative local baseline -> profile -> change one bottleneck -> verify equivalence and performance.
- **Docs/config/Skill:** use a failing structure, link, schema, or static check; do not force unrelated compilation or TDD.
- **Incident:** reversible containment may precede root-cause work; record containment separately from the permanent fix.

## Planning Contract

Before implementation, know the goal, scope, affected surfaces, risks, acceptance evidence, and rollback needs. Compare multiple solutions only when a real tradeoff exists. Pause for user input only when a missing decision materially changes scope, risk, authority, or external state.

## Verification Contract

Apply all three checks:

| Check | Question |
|-------|----------|
| Consistency | Does the result match the agreed goal and plan? |
| Completeness | Are affected paths, edge cases, docs, cleanup, and rollback needs handled? |
| Correctness | Do project-native tests and observed outputs support the claim? |

Unavailable hardware, credentials, dependencies, or network access are `UNVERIFIED`, not green. State the missing check and residual risk.

## Completion

- Update existing documentation only when behavior, contracts, operations, or repository policy require it.
- Store reusable knowledge in repository docs first; external memory requires an available capability, authorization, and redaction.
- Verify owned processes and ports are gone, not merely signaled.
- Preserve unrelated user changes. If Git actions were requested, scope them to this task and follow repository conventions.
