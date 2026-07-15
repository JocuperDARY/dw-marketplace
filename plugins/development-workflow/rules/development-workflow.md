# Development Workflow

> The `development-workflow` Skill is authoritative. This always-loaded rule keeps only the cross-stage invariants; load the relevant child Skill for detailed execution.

## Invariants

1. **Use auditable edits.** Manual changes use the current runtime's structured mechanism, such as Claude Code `Edit`/`Write` or Codex `apply_patch`. Repository formatters and generators remain valid deterministic tools.
2. **Protect sensitive data.** Do not print secrets or send project data to an unauthorized external tool.
3. **Respect authorization.** Do not stage, commit, push, deploy, message, or change external state unless the user requested that action.
4. **Choose a minimal sufficient tool set.** Discover declared capabilities instead of assuming names. Use CodeGraph first only when `.codegraph/` exists; otherwise use `rg` and focused file reads.
5. **Require fresh evidence.** A completion claim names the command/check, outcome, and any unverified residual risk.
6. **Reclaim owned resources.** Track and stop this task's child processes, development servers, watchers, workers, ports, and temporary resources on success, failure, or interruption.

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
