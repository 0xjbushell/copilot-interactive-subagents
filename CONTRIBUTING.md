# Contributing

Thanks for your interest in contributing to `copilot-interactive-subagents`!

## Prerequisites

- Node.js ≥ 18
- [GitHub Copilot CLI](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-in-the-command-line) (for E2E tests)
- tmux ≥ 3.0 and/or zellij ≥ 0.40 (for E2E tests)

## Setup

```bash
git clone https://github.com/0xjbushell/copilot-interactive-subagents.git
cd copilot-interactive-subagents
npm install
```

## Development workflow

Every change to business logic must pass all three quality gates:

```bash
# 1. Unit tests (~2s)
npm test

# 2. CRAP scoring — complexity × coverage, all functions must score < 8
npm run test:crap

# 3. Mutation testing — behavioral coverage, target ≥ 80% kill rate
npm run test:mutation
```

All three in one command:

```bash
npm test && npm run test:crap && npm run test:mutation
```

### E2E tests

E2E tests run real Copilot sessions against real tmux/zellij backends. They require an authenticated Copilot CLI and take several minutes.

**Prerequisites:**

- Copilot CLI installed and authenticated (`copilot --version` works)
- tmux ≥ 3.0 installed
- zellij ≥ 0.40 installed (for zellij tests)

```bash
# tmux (run from any terminal)
npm run test:e2e

# zellij (must run from inside an active zellij session)
ZELLIJ_E2E=1 npm run test:e2e
```

E2E tests are not part of CI — they require interactive authentication and real terminal multiplexers. **Run them locally before tagging a release.**

### Pre-release checklist

Before tagging a new version:

1. All unit tests pass: `npm test`
2. CRAP and mutation gates pass: `npm run test:crap && npm run test:mutation`
3. E2E tests pass on tmux: `npm run test:e2e`
4. E2E tests pass on zellij: `ZELLIJ_E2E=1 npm run test:e2e` (from inside zellij)
5. Deploy locally and smoke test: `cp -r .github/extensions/copilot-interactive-subagents ~/.copilot/extensions/`
6. Update `CHANGELOG.md` with new version section
7. Tag: `git tag v1.x.x && git push origin v1.x.x`

## Installing your changes locally

After making changes, deploy the extension to your local Copilot CLI:

```bash
cp -r .github/extensions/copilot-interactive-subagents ~/.copilot/extensions/copilot-interactive-subagents
```

Then start a new `copilot` session to pick up the changes.

## Project structure

```
.github/extensions/copilot-interactive-subagents/
├── extension.mjs          # Entry point — tool registration and top-level handlers
└── lib/                   # Business logic modules (one concern per file)

test/
├── *.test.mjs             # Unit tests
├── unit/                  # Additional unit tests
├── e2e/                   # E2E tests (real copilot sessions)
└── helpers/               # Test utilities
```

## Code conventions

- **DI pattern** — inject `services` to stub `fs`, `child_process`, etc. See `lib/launch.mjs` for the canonical example.
- **Atomic writes** — manifest state uses temp+rename to prevent corruption.
- **New modules** — add to `scripts/quality/targets.mjs` for CRAP and mutation tracking.
- **Tests** — use `test/helpers/red-harness.mjs#importProjectModule` to import modules under test.

## Commits

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add new tool for session inspection
fix: handle empty pane output in zellij
docs: update installation instructions
test: add E2E coverage for fork feature
```

## Pull requests

1. Fork the repo and create a feature branch
2. Make your changes
3. Ensure all quality gates pass (`npm test && npm run test:crap && npm run test:mutation`)
4. Open a PR against `main`
