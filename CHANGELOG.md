# Changelog

All notable changes to this project will be documented in this file.

This project follows [Conventional Commits](https://www.conventionalcommits.org/) and [Semantic Versioning](https://semver.org/).

## [1.0.0] — 2026-04-14

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
