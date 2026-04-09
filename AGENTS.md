# AGENTS.md

copilot-interactive-subagents is a Copilot CLI extension adding persistent sessions, interactive mode, fork, resume, and completion signaling to multiplexer-backed subagent panes.

## Development Rules

- Source of truth: `.github/extensions/copilot-interactive-subagents/`
- Tests: `test/` (unit, integration, e2e)
- Specs: `specs/` (explorations → decisions → formal specs)

## Quality Gates (Blocking)

Every code change to business logic MUST pass these gates before claiming completion:

1. **Tests pass**: `npm test` — 0 failures
2. **CRAP score**: `npm run test:crap` — exit 0 required. New code must score CRAP < 8.
3. **Mutation testing**: `npm run test:mutation` — exit 0 required. Target ≥ 80% kill rate.

Run all three in sequence: `npm test && npm run test:crap && npm run test:mutation`

### New Module Checklist

When creating a new `.mjs` file under `lib/`:
1. Add it to `DETERMINISTIC_LOGIC_TARGETS` in `scripts/quality/targets.mjs`
2. Add targeted mutants for critical behavioral assertions
3. Create a corresponding `test/<module-name>.test.mjs`

Skipping quality gates is not allowed. If a gate fails, fix the code — do not proceed.
