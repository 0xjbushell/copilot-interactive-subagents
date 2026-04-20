---
name: developing-copilot-interactive-subagents
description: "Test-first, mutation-validated development workflow for the copilot-interactive-subagents extension. Use when writing, modifying, or refactoring extension code (.github/extensions/copilot-interactive-subagents/) — covers TDD/ATDD with red-harness, dependency injection, the three blocking quality gates (npm test, CRAP, mutation), the test pyramid (unit → integration → E2E), source-of-truth vs installed copy, and ship-gate criteria."
---

# Developing copilot-interactive-subagents

This skill captures the inner-loop and ship-gate workflow proven across the v2 implementation (11 deliverables, 257 unit + 6 integration + 27 E2E tests, 100% mutation kill rate). Follow it for every code change to extension business logic.

## Source of Truth — Read First

| What | Path | Rule |
|------|------|------|
| Extension source | `.github/extensions/copilot-interactive-subagents/` | ✅ Edit here |
| Installed copy | `~/.copilot/extensions/copilot-interactive-subagents/` | ❌ Never edit — overwritten on deploy |
| Tests | `test/` (legacy flat), `test/unit/` (new), `test/integration/`, `test/e2e/` | ✅ Edit here |
| Quality targets | `scripts/quality/targets.mjs` | ✅ Update when adding `lib/*.mjs` |

**Deploy step** (only after quality gates pass on the deliverable):
```bash
cp -r .github/extensions/copilot-interactive-subagents ~/.copilot/extensions/copilot-interactive-subagents
```

## The Inner Loop (per change)

1. **Read the spec / ticket fully** before writing code. For ticketed work: `tix show <id> --full`.
2. **Write failing tests first (TDD/ATDD).** One test per acceptance criterion. ACs are frozen — modify implementation to match, never the reverse.
3. **Import via the red-harness** so missing exports fail loudly:
   ```js
   import { importProjectModule } from "../helpers/red-harness.mjs";
   const mod = await importProjectModule("lib/your-module.mjs", ["expectedExport"]);
   ```
4. **Inject dependencies** via a `services` param. See `lib/launch.mjs:22-59` for the canonical pattern (stub `fs`, `child_process`, clocks, etc.). Never reach for real `node:fs` inside business logic.
5. **Implement until tests pass.** Keep diffs surgical.
6. **Run all three quality gates** (blocking — see next section).
7. **Validate independently** — delegate verification to the `omc:test-run` agent (clean context, no shared state with implementer).
8. **Deploy + commit** in that order so the installed copy stays in sync with green commits.

Use the `task` tool with `general-purpose` for parallel implementation streams when deliverables are independent (the v2 dependency graph identified several parallelizable pairs).

## Quality Gates — Blocking

Every business-logic change MUST pass all three before any "done" claim:

```bash
npm test && npm run test:crap && npm run test:mutation
```

| Gate | Bar | Notes |
|------|-----|-------|
| `npm test` | 0 failures | Runs unit + integration; ~5s |
| `npm run test:crap` | exit 0 | New code must score CRAP < 8 |
| `npm run test:mutation` | exit 0 | Target ≥ 80% kill rate; v2 sustained 100% |

If any gate fails, **fix the code** — do not lower the bar, skip, or comment out. Common fixes are documented in `references/quality-gates.md`.

### New `lib/*.mjs` checklist

When you create a new module under `lib/`:
1. Add it to `DETERMINISTIC_LOGIC_TARGETS` in `scripts/quality/targets.mjs`
2. Register targeted mutants for behavioral assertions (boundary conditions, return-value swaps, condition negations)
3. Place its unit test in `test/unit/your-module.test.mjs`

See `references/quality-gates.md` for the mutation runner's test-discovery glob (a critical gotcha for integration-only logic).

## Test Pyramid — When to Run Each

| Layer | Command | When | Speed |
|-------|---------|------|-------|
| Unit | `npm test` (or `npm run test:unit`) | After every code change | ~1-5s |
| Integration | `npm run test:integration` | When the change adds an integration test | ~10s |
| CRAP | `npm run test:crap` | Before claiming any deliverable done | ~5s |
| Mutation | `npm run test:mutation` | Before claiming any deliverable done | ~30s-2min |
| E2E | `npm run test:e2e` | After deploy; before completing high-risk deletions; final ship gate | ~5min |

### Critical & Non-Negotiable Layers

These two layers catch failure modes the cheaper layers cannot:

- **Integration tests** (`test/integration/`) — exercise multi-module flows with realistic IPC (e.g., sidecar pre-write, manifest persistence, ping → resume → done loop). Required for any deliverable that crosses module boundaries.
- **E2E tests** (`test/e2e/`) — spawn real copilot sessions in real tmux/zellij panes against the **installed extension copy**. Required as the final ship gate and after any change to backend ops, pane lifecycle, or signal/sidecar IPC.

Read `references/e2e-runbook.md` before running E2E — it covers the deploy-first requirement, the zellij-must-be-nested constraint, and post-mortem evidence locations.

### Ship-gate criteria (before tagging a release)

- All three quality gates green on the source-of-truth checkout
- Integration suite green
- E2E green on **both** backends:
  - tmux from any shell
  - zellij from inside a zellij session (nest via `tmux new -d 'zellij'` if needed)
- `omc:test-run` confirms independently
- Optionally: `omc:code-review` clears craftsmanship/security review

## Conventions That Catch Real Bugs

- **Commit-message gotcha**: literal "kill" word triggers a security filter — write "killed" / "terminate".
- **Use the `task` tool, not `copilot_subagent_*`**, for build-time delegation. The subagent extension is the very thing under development; relying on it during a refactor risks self-breakage.
- **One mutant per behavioral assertion**, not per line. Mutants that survive after a green test mean the test asserts the wrong thing.
- **Empty/whitespace summary normalizes to `null`** (not `""`) — preserves the precedence chain (sidecar > pane scrape > session-events).
- **Status taxonomy is fixed**: TERMINAL = {success, failure, timeout, cancelled, ping}; ping is non-failure terminal in aggregation.
- **Manifest version is hard-cutover** — never write a migration shim. Rejection is defense-in-depth (both `readLaunchRecord` and `validateManifest` throw).

## References

- `references/quality-gates.md` — mutation runner internals, CRAP scoring, common gate failures and fixes
- `references/e2e-runbook.md` — deploy-first workflow, zellij nesting, post-mortem evidence
- `AGENTS.md` (repo root) — repo-wide conventions
- `specs/subagents/` — formal specs (implementation source of truth)
- `specs/decisions/` — locked design decisions (do not relitigate)

## Traceability

This skill encodes the workflow proven during the v2 implementation tracked under story `TIX-000041` (11 deliverables, all completed via this loop). The spec it grew out of: `specs/subagents/interactive-subagents-v2.md`. When updating this skill, note which spec section, ticket, or post-mortem drove the change.
