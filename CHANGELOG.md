# Changelog

All notable changes to this project will be documented in this file.

This project follows [Conventional Commits](https://www.conventionalcommits.org/) and [Semantic Versioning](https://semver.org/).

## [2.0.4] — 2026-04-27

Patch release. Fixes two production bugs causing pane leaks and tool-call timeouts in long-running subagent sessions.

### 🐛 Fixes

- **Runner now closes its pane on signal exit (SIGTERM/SIGINT/SIGHUP).** Previously the close-pane wrapper only fired on a normal `copilot` exit, so any signal-killed child left an orphaned `Terminated` pane (observed in anvil and minionctl real sessions). Runner now registers signal handlers that map POSIX signums to exit codes (143/130/129) and call the close action via `spawnSync` with a 2s timeout, guarded by an idempotent `closePaneOnce` helper so success-path + signal-path can't double-close.
- **Default tool timeout raised from 90s to 30min.** Blocking launches frequently exceeded the old 90-second budget when child agents were doing real work, returning misleading `TOOL_TIMEOUT` errors with the child still running. Override via `COPILOT_SUBAGENT_TOOL_TIMEOUT_MS` (parsed by new `resolveToolTimeoutMs`; invalid/empty/≤0 falls back to default).
- **Error path now reaps panes when `closePaneOnCompletion: true`.** `handleLaunchError` previously left panes open on timeout/failure even when the caller had opted into auto-close, mirroring only the success path. Added a small `reapPaneIfRequested` helper that mirrors the success-path reap.

### 🧹 Internal

- 8 new unit tests across `runner-signal-handling`, `tool-timeout`, `launch-error-pane-reap`.
- Quality gates green: 282/282 unit tests, CRAP 165/165 ≤ 8, mutation 100% (70/70 killed).

## [2.0.3] — 2026-04-26

Patch release. Defaults the pane backend to `zellij` so agents stop reaching for `tmux` first.

### 🐛 Fixes

- **Skill now recommends `zellij` by default.** The skill text previously said "Prefer `tmux` by default", which led every agent to pick tmux even though backend auto-resolution in `lib/mux.mjs` already prefers zellij. Skill examples updated to pass `"backend": "zellij"` (and `paneId: "pane:N"` in the set_title sample). `tmux` remains a first-class fallback when zellij isn't available or when the parent already lives inside a tmux session.
- **Tool schemas surface the new default.** `copilot_subagent_launch`, `copilot_subagent_parallel`, and `copilot_subagent_resume` now describe the `backend` field as "prefer zellij when available, falling back to tmux" and reorder the enum to `cmux | zellij | tmux` so even agents that ignore the skill see the preference.

### 🧹 Internal

- Quality gates green: 274/274 unit tests.

## [2.0.2] — 2026-04-25

Patch release. Adds child-lifecycle context so interactive subagents know to call `subagent_done`.

### 🐛 Fixes

- **Interactive subagents now reliably call `subagent_done` (TIX-000059).** Previously, child sessions only had the tool's parameter description as context for when to use it. In `-p` (autonomous) mode this didn't matter — copilot exited naturally when the prompt completed. In `-i` (interactive) mode the child idled in a REPL between turns with no terminal condition, never reaching `subagent_done`, so panes never self-closed via the TIX-000058 path. The extension now appends a brief lifecycle preamble to the child's system prompt (via SDK `systemMessage.append`) when `COPILOT_SUBAGENT_LAUNCH_ID` is set, telling the child it is a subagent, when to call `subagent_done` vs. `caller_ping`, and that the parent can resume. Append mode preserves all SDK guardrails. Parent sessions are unaffected.

### 🧹 Internal

- Quality gates green: 274/274 unit tests, CRAP 0 violations, mutation 70/70 killed.

## [2.0.1] — 2026-04-22

Patch release. Source layout refactored to separate the project's own source from Copilot CLI's extension auto-discovery directory, plus a fix for orphaned subagent panes.

### 🐛 Fixes

- **Subagent panes now self-close on child exit (TIX-000058).** Previously, panes only auto-closed in the awaited path (`awaitCompletion: true`). Non-awaited launches and `awaitCompletion: false` callers leaked panes even when `closePaneOnCompletion: true` was set. The child wrapper now reads `$ZELLIJ_PANE_ID`/`$TMUX_PANE` and issues the close-pane command directly when copilot exits — works uniformly for sync, async, interactive (user-/exit), and autonomous launches. The session itself persists in copilot's state-dir, so closing the pane is non-destructive: `copilot_subagent_resume` reopens the conversation in a fresh pane.
- **No more auto-loaded duplicate extension.** Extension and end-user skill source moved from `.github/extensions/` and `.github/skills/` to `packages/copilot-interactive-subagents/{extension,skill}/`. Copilot CLI auto-discovers `.github/extensions/*/extension.mjs` from cwd, so the previous layout caused the in-repo source to register as a second extension whenever a user `cd`'d into this repo, clashing with the globally-installed copy and breaking tool routing (`External tool name clash: copilot_subagent_list_agents …`). Downstream consumers continue to install via `node scripts/install.mjs` exactly as before; install destinations are unchanged.

### 🧹 Internal

- `scripts/install.mjs` source paths updated to the new `packages/` layout.
- Release tarball now ships `packages/copilot-interactive-subagents/` instead of separate `.github/extensions/` and `.github/skills/` trees.
- Quality gates green: 272/272 unit tests, CRAP 0 violations, mutation 68/68 killed.

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
