# AGENTS.md

## What This Extension Does

`copilot-interactive-subagents` is a Copilot CLI extension. It launches child Copilot agents in tmux/zellij panes, tracks their sessions via launch manifests, and provides tools (`copilot_subagent_launch`, `copilot_subagent_resume`, `copilot_subagent_parallel`, `copilot_subagent_set_title`, `copilot_subagent_list_agents`) for orchestration. v1 adds 6 capabilities: **ephemeral panes** (auto-close after completion), **persistent sessions** (tracked by UUID), **interactive mode** (user collaborates in pane), **resume** (continue a completed session), **fork** (copy a session's context into a new child), and **explicit completion** (`subagent_done` tool).

## Repository Layout

```
.github/extensions/copilot-interactive-subagents/
├── extension.mjs              # Main entry — tool registration, launch orchestration
└── lib/
    ├── agents.mjs             # Agent discovery and validation
    ├── launch.mjs             # Single launch orchestration
    ├── mux.mjs                # Backend detection (tmux/zellij)
    ├── mux-layout.mjs         # Pane layout management
    ├── parallel.mjs           # Parallel launch orchestration
    ├── progress.mjs           # Progress reporting
    ├── resume.mjs             # Resume flow
    ├── state.mjs              # Launch manifest read/write
    ├── state-index.mjs        # Manifest index (list all launches)
    ├── summary.mjs            # Summary extraction from pane/session
    └── titles.mjs             # Pane title management

test/                          # All test files (node:test + node:assert)
├── *.test.mjs                 # Legacy: flat structure (existing tests)
├── unit/                      # v1: new unit tests go here (created by TIX-000015)
│   └── *.test.mjs
└── helpers/red-harness.mjs    # Module import + export validation

scripts/
├── quality/targets.mjs        # CRAP + mutation testing target definitions
├── test-crap.mjs              # CRAP score runner
└── test-mutation.mjs          # Mutation test runner

specs/                         # Design specifications
├── subagents/                 # Formal specs (implementation source of truth)
├── decisions/                 # Locked design decisions
└── explorations/              # Historical research (superseded by specs)
```

## Source of Truth

| What | Path | Rule |
|------|------|------|
| **Extension source** | `.github/extensions/copilot-interactive-subagents/` | ✅ Edit here |
| **Installed copy** | `~/.copilot/extensions/copilot-interactive-subagents/` | ❌ Never edit — overwritten on install |
| **Tests** | `test/` | ✅ Edit here |
| **Quality targets** | `scripts/quality/targets.mjs` | ✅ Update when adding modules |

**Deploy after changes:**
```bash
cp -r .github/extensions/copilot-interactive-subagents ~/.copilot/extensions/copilot-interactive-subagents
```

## Development Workflow

Inner loop for every code change:

```bash
# 1. Run unit tests (fast feedback, ~1s)
npm test

# 2. Run CRAP scoring (complexity + coverage)
npm run test:crap

# 3. Run mutation testing (behavioral coverage)
npm run test:mutation

# All three in one command:
npm test && npm run test:crap && npm run test:mutation
```

## Quality Gates (Blocking)

Every code change to business logic MUST pass all three gates before claiming completion:

1. **Tests pass**: `npm test` — 0 failures
2. **CRAP score**: `npm run test:crap` — exit 0 required. New code MUST score CRAP < 8.
3. **Mutation testing**: `npm run test:mutation` — exit 0 required. Target ≥ 80% kill rate.

Skipping quality gates is not allowed. If a gate fails, fix the code — do not proceed.

### New Module Checklist

When creating a new `.mjs` file under `lib/`:
1. Add it to `DETERMINISTIC_LOGIC_TARGETS` in `scripts/quality/targets.mjs`
2. Add targeted mutants for critical behavioral assertions
3. Create a corresponding test file in `test/unit/` (v1 modules) or `test/` (legacy)

### Test Conventions

- New v1 unit tests go in `test/unit/` (requires TIX-000015 infrastructure)
- Legacy tests remain flat in `test/`
- Import modules via `test/helpers/red-harness.mjs#importProjectModule` — this ensures the module's exports are validated before tests run ("red first" pattern)
- Follow the DI pattern: inject `services` param to stub `fs`, `child_process`, etc. See `lib/launch.mjs` lines 22-59 for the canonical DI example

## Specifications

The implementation source of truth is `specs/subagents/interactive-subagents-v1.md`. Read the **Start Here** section first — it tells you what to build, in what order, and how to verify.
