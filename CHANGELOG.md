# Changelog

All notable changes to this project will be documented in this file.

This project follows [Conventional Commits](https://www.conventionalcommits.org/) and [Semantic Versioning](https://semver.org/).

## [2.0.1] — 2026-04-22

Patch release. Repo source layout refactored to fix a tool name clash that prevented `copilot_subagent_*` tools from working when Copilot CLI was launched from inside this repository.

### 🐛 Fixes

- **No more auto-loaded duplicate.** Extension and end-user skill source moved from `.github/extensions/` and `.github/skills/` to `packages/copilot-interactive-subagents/{extension,skill}/`. Copilot CLI auto-discovers `.github/extensions/*/extension.mjs` from cwd, so the previous layout caused the in-repo source to register as a second extension whenever a user `cd`'d into this repo, clashing with the globally-installed copy and breaking tool routing (`External tool name clash: copilot_subagent_list_agents …`). Downstream consumers continue to install via `node scripts/install.mjs` exactly as before; install destinations are unchanged.

### 🧹 Internal

- `scripts/install.mjs` source paths updated to the new `packages/` layout.
- Release tarball now ships `packages/copilot-interactive-subagents/` instead of separate `.github/extensions/` and `.github/skills/` trees.
- Quality gates green: 266/266 unit tests, CRAP 0 violations, mutation 68/68 killed.

## [2.0.0] — 2026-04-21

Second major release. Adds bidirectional parent↔child communication, sidecar-based IPC, and a hardened tool-access model. **Breaking**: manifest v2 → v3 hard cutover (no migration); pre-v2 launches cannot be resumed.

### ✨ Features

- **`caller_ping` (child-only tool)** — a child can pause itself and signal the parent that it needs input. Parent observes `status: "ping"`, `summary: null`, `exitCode: 0`, and a `ping: { message }` field, then continues the child via `resume({ launchId, task: "<answer>" })`. Same launchId supports multiple ping→resume cycles. (D2.1, D2.5)
- **`resume({ task })`** — inject a follow-up instruction when resuming a session. `task: ""` and omitted `task` converge to "no extra prompt". Both cmux and pane delivery paths converge on the same task semantics. (D2.4)
- **Exit-sidecar IPC** — `subagent_done` and `caller_ping` now write structured JSON sidecars at `<workspace>/.copilot-interactive-subagents/exit/<launchId>.json`. Replaces the old `done/<sessionId>` signal-file mechanism. Sidecar is the source of truth; pane scrape and session events are fallbacks. (D1.1, D2.2, D2.3, D3.1)
- **Tool access control** — child sessions only see `subagent_done` and `caller_ping`. Parent spawning tools (`copilot_subagent_*`) are stripped at registration time, preventing runaway recursion. Gated on `COPILOT_SUBAGENT_LAUNCH_ID`. (D4.1)
- **Manifest v3** — adds `copilotSessionId` (pre-generated UUID) and `protocolVersion: 3`. Defense-in-depth rejection of non-v3 manifests via `MANIFEST_VERSION_UNSUPPORTED`. (D1.2)
- **Parallel aggregation: `ping` is non-failure** — `[success, ping]` → `success`; `[failure, ping]` → `partial-success`. Snapshot adds `pingCount`. (D5.1)

### 🐛 Fixes

- `withToolTimeout` now distinguishes timeout vs. error vs. completion in its result discriminator instead of conflating all into a single value. (D1.2)
- `subagent_done({ summary: "" })` and whitespace-only summaries normalize to `null` so pane-scrape fallback fires correctly. (D3.1)

### 🧹 Removed

- `writeSignalFile` and the `done/<sessionId>` directory contract are deleted. The sidecar IPC primitive replaces them entirely. (D5.2)
- Legacy `enrichCompletionSummary` precedence (session-events first) inverted: sidecar > pane scrape > session events. (D2.3)

### 📐 Spec & Skills

- Spec: `specs/subagents/interactive-subagents-v2.md` (formal); locked decisions in `specs/decisions/interactive-subagents-v2-decisions.md`.
- `using-copilot-interactive-subagents` skill rewritten for v2: documents `caller_ping`, `resume({ task })`, ping status, parallel aggregation, child-only tool gating, new error codes (`RESUME_UNSUPPORTED`, `MANIFEST_VERSION_UNSUPPORTED`, `STATE_DIR_MISSING`, `TOOL_TIMEOUT`).
- New `developing-copilot-interactive-subagents` skill: captures the TDD + quality-gates + code-simplification workflow used for v2.

### ✅ Quality

- 266 unit tests, 6 integration tests, 27 E2E tests (tmux + zellij), 68/68 mutants killed. All `lib/*.mjs` modules under CRAP 8.

### ⚠️ Migration

- **No automatic migration.** Pre-v2 launches surface `MANIFEST_VERSION_UNSUPPORTED` on resume. Re-launch instead.
- Parent agents that called `subagent_done` from outside a child session will now error — the gate is strict.



First public release.

### ✨ Features

- **Launch** — spawn a Copilot subagent in a visible tmux or zellij pane with `copilot_subagent_launch`
- **Parallel** — fan out multiple agents simultaneously with `copilot_subagent_parallel`
- **Resume** — continue a completed session in a new pane with `copilot_subagent_resume`
- **Fork** — clone a parent session's context into a new child agent
- **Interactive mode** — keep the pane alive for human collaboration (`interactive: true`)
- **Explicit completion** — agents signal done via `subagent_done` tool instead of sentinel polling
- **Session identity** — every launch gets a `copilotSessionId` persisted in manifest v2
- **Pane lifecycle** — `closePaneOnCompletion` controls whether panes auto-close (default: true for autonomous, false for interactive)
- **Set title** — update pane titles on tmux backends with `copilot_subagent_set_title`
- **List agents** — discover available agents and backends with `copilot_subagent_list_agents`
- **Session locks** — prevent concurrent resume of the same session
- **Atomic state** — manifests written via temp+rename for crash safety

### 📐 Architecture

- Modular codebase: 19 focused modules in `lib/` (avg ~150 lines each)
- Extension entry point reduced to ~520 lines (orchestration + DI wiring only)
- Dependency-injected services for full testability
- Shared utilities extracted to `utils.mjs` (normalizers, status helpers, pane ID parsing)
- Pure-data tool schemas separated from business logic (`tool-schemas.mjs`)
- Request validation isolated in dedicated module (`validation.mjs`)

### 🏗️ Infrastructure

- Unit tests (152 tests, node:test runner)
- CRAP scoring (all functions < 8)
- Mutation testing (100% score)
- E2E tests with real Copilot sessions (27 tests across tmux + zellij)
- CI workflow with Node 18/20/22 matrix
- Release workflow with automated changelog and artifact packaging

### 🔧 Supported Backends

- **tmux** — full support (launch, resume, parallel, set_title, pane lifecycle)
- **zellij** — full support (launch, resume, parallel, pane lifecycle); set_title not yet supported

[1.0.0]: https://github.com/0xjbushell/copilot-interactive-subagents/releases/tag/v1.0.0
