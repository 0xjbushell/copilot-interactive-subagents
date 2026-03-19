# Copilot Interactive Subagents

## Traceability
- **Shared Key**: copilot-interactive-subagents
- **Spec Path**: `specs/subagents/copilot-interactive-subagents.md`
- **Requirement Refs**: None
- **Decision Refs**: None

## Problem Statement

`pi-interactive-subagents` demonstrates a valuable workflow pattern: a main coding session can launch subagents into visible `tmux`, `cmux`, or `zellij` panes, monitor them, resume them later, and use them as focused workers without collapsing all work into a single conversation context. GitHub Copilot CLI does not provide that pane-driven experience out of the box.

This project should recreate that capability for any Copilot CLI user while staying generic. The extension should not hardcode planner/scout/worker/reviewer prompts. Instead, it should provide the multiplexer-backed launching, monitoring, and resume behavior needed to run any built-in or custom Copilot agent in pane-isolated sub-sessions. The existing pi extension remains the reference model for interaction shape, backend abstraction, and session handoff behavior.

## Scope

### In Scope

- A Copilot CLI extension that opens subagent sessions in `tmux`, `cmux`, or `zellij`.
- Generic subagent launching for any supported Copilot agent the user can select by exact installed agent name.
- Single-agent and parallel-agent orchestration.
- Tracking enough launch metadata to summarize and resume pane-launched sessions.
- Session-workspace-backed state with an optional project-local index for cross-session lookup.
- Tool interfaces that enable higher-level Agent Skills such as planning, iteration, and direct subagent invocation.
- A generic launch tool that Copilot itself can call during larger workflows.
- Reusing the current pi extension as the functional model for multiplexer behavior, screen polling, exit detection, and orchestration patterns.

### Out of Scope

- Bundling project-owned planner, scout, worker, reviewer, or visual-tester prompts into this extension.
- Shipping example Agent Skills in the first version of the project.
- Replacing Copilot CLI's native session model or inventing a separate conversation store.
- Building a non-multiplexer fallback UX as the main product path.
- Defining project-specific workflows that only work for one repository or one team.

## Design Decisions

- The extension is a **capability layer**, not an agent pack.
- The extension must support launching **any built-in or custom agent**, not just custom agents.
- V1 agent targeting should use **exact installed agent names** to keep behavior predictable and avoid role-guessing heuristics.
- Built-in-agent support must not depend on undocumented enumeration APIs; if built-in agents cannot be listed directly, the extension should still accept explicit built-in identifiers and validate them at launch time.
- `tmux`, `cmux`, and `zellij` remain first-class backends; pane visibility is part of the product, not a nice-to-have.
- The primary persistent state should live in the Copilot session workspace, with an optional project-local index for durable lookup across sessions.
- Resume support should work across sessions when metadata exists, even if a launch started in an earlier Copilot session.
- The extension should follow a deterministic multiplexer policy: prefer an explicitly requested backend, otherwise attach to an already active supported backend when detected, otherwise start a new backend session when the backend binary is present and startup is supported, otherwise fail with setup guidance.
- The extension must expose a **generic subagent-launch tool** callable by Copilot, not only manual or skill-driven entrypoints.
- High-level workflows such as `/plan`, `/iterate`, or `/subagent` belong conceptually in Agent Skills, while this extension provides the low-level orchestration tools those skills need.
- The preferred architecture is **hybrid orchestration**: panes and launch flow are extension-managed, while Copilot SDK/session APIs are used wherever they reduce brittleness.
- Completion detection should use an explicit child-process exit sentinel carried through pane output, with backend-native hooks or signals treated as optional optimizations rather than the core contract.
- The pi extension is the reference implementation for behavior, but the Copilot port may replace pi-specific integration details with Copilot SDK and extension mechanisms where appropriate.

## Specific Ideas Disposition

- **Accepted — use the pi extension as the behavioral reference model.**
  - The current repository already solves multiplexer selection, pane creation, screen polling, and session handoff.
  - Those pieces should be studied and ported deliberately instead of reinvented from scratch.

- **Accepted — keep the extension generic instead of embedding a bundled agent catalog.**
  - This keeps the project useful for any Copilot setup and avoids coupling the extension to one opinionated workflow pack.

- **Accepted — target agents by exact installed name in the first version.**
  - This keeps the interface predictable and avoids inventing role-mapping logic before the core launch behavior is proven.

- **Accepted — use workspace-backed session metadata with optional project-local indexing.**
  - Pi stores artifacts under `~/.pi/history/<project>/artifacts/<session-id>/` and also relies on pi session files.
  - For Copilot CLI, session workspace storage should be the primary mechanism because it is native to the host, while a project-local index can be added only where cross-session discovery benefits from it.

- **Accepted — prefer hybrid orchestration over a fully manual or fully Copilot-native approach.**
  - The visible pane experience should stay under extension control.
  - Copilot-native state and agent APIs should be used where they make the implementation less brittle.

- **Accepted — expose generic launch primitives that Copilot can call directly.**
  - The extension should be useful both to human operators and to higher-level agent workflows.

- **Deferred — rely on `session.rpc.fleet.start` as the primary orchestration engine.**
  - The SDK surface exists, but the behavior is not sufficiently documented yet.
  - It should be evaluated during implementation, not assumed at spec time.

- **Rejected — require bundled sample skills before the extension is useful.**
  - The extension should stand on its own as a reusable orchestration layer.
  - Skills can be added later without changing the extension's core responsibility.

## Architecture

### Component Overview

The project should consist of six cooperating pieces:

1. **Extension entrypoint**
   - Registers the extension with Copilot CLI.
   - Exposes the generic orchestration tools.
   - Loads configuration and runtime helpers.

2. **Multiplexer backend adapter**
   - Ports the backend abstraction currently represented by the reference implementation at `pi-interactive-subagents/pi-extension/subagents/cmux.ts`.
   - Detects `cmux`, `tmux`, or `zellij`.
   - Creates, renames, reads from, and closes panes.

3. **Agent launch service**
   - Validates the requested agent target.
   - Builds the child Copilot launch command or session-resume invocation.
   - Injects task/context payloads and captures process lifecycle state.
   - Exposes a generic launch primitive that higher-level Copilot workflows can call.

4. **Session-state store**
   - Persists launch manifests, session identifiers, pane metadata, summaries, and resume pointers.
   - Uses session workspace storage first.
   - Optionally publishes a project-local index for cross-session rediscovery.

5. **Summary and monitoring service**
   - Polls pane output or session signals for completion.
   - Extracts the final useful summary for the parent session.
   - Streams progress updates back into the main Copilot timeline.

6. **Skill-facing orchestration interface**
   - Defines the tools that future Agent Skills can call.
   - Supports direct user-driven subagent spawning as well as skill-authored workflows.

### Backend Selection and Attach/Start Policy

The backend decision path should be deterministic and testable:

1. If a launch request explicitly names a backend, use it or fail with a backend-specific error.
2. Otherwise, if the current environment already indicates an active supported backend, attach to that backend:
   - `CMUX_SOCKET_PATH` for `cmux`
   - `TMUX` for `tmux`
   - `ZELLIJ` or `ZELLIJ_SESSION_NAME` for `zellij`
3. Otherwise, if a supported backend binary is installed and the project supports starting it automatically, start a new session using a predictable session/workspace name.
4. Otherwise, fail with setup guidance and do not create launch metadata that looks resumable.

This policy should be shared by discovery, launch, and resume flows.

### Agent Target Resolution Policy

Agent targeting should remain explicit and predictable:

- Custom agents should be discovered through documented Copilot SDK / runtime mechanisms where available.
- Built-in agents should be addressable by explicit identifier even if the runtime cannot enumerate them.
- V1 should reject fuzzy matches, aliases, or role inference.
- Launch-time validation should return a structured error that includes the requested identifier, the validation method used, and any known available identifiers.

### Session State and Resume Model

The extension should persist a launch manifest in the Copilot session workspace and optionally index it in project-local storage.

Minimum launch-manifest schema:

```json
{
  "launchId": "uuid",
  "agentIdentifier": "exact-agent-name-or-built-in-id",
  "agentKind": "built-in|custom|unknown",
  "backend": "tmux|cmux|zellij",
  "paneId": "backend-specific-pane-id",
  "sessionId": "copilot-session-id-or-null",
  "requestedAt": "2026-03-19T00:00:00Z",
  "status": "pending|running|success|failure|cancelled|timeout",
  "summary": "final-summary-or-null",
  "exitCode": 0,
  "metadataVersion": 1
}
```

Resume is best-effort but structured:

- workspace-backed metadata is the primary source of truth
- project-local indexing is an optional cross-session lookup aid
- invalid or expired resume targets must return structured diagnostics rather than success-shaped fallbacks

### Completion Detection and Summary Contract

Completion detection should follow the pi extension's proven pattern:

- the child launch command emits an explicit exit sentinel such as `__SUBAGENT_DONE_<code>__`
- the monitoring service reads pane output to detect that sentinel
- backend-native completion hooks may be added later, but sentinel-based completion remains the portable baseline

Summary extraction order:

1. explicit persisted summary captured from the child session, if available
2. last reliable assistant summary message captured before completion
3. deterministic fallback summary derived from exit state and pane/session metadata

The extension must never return an empty summary.

### Data / Control Flow

1. The user or an Agent Skill requests a subagent launch.
2. The extension validates environment prerequisites:
   - supported multiplexer availability or attach/start path
   - requested agent availability
   - required session/workspace state
3. The extension creates a pane in the chosen multiplexer backend.
4. The extension launches a Copilot sub-session in that pane, targeting the requested built-in or custom agent.
5. The extension records launch metadata in the session workspace and, if enabled, updates a project-local index.
6. The extension monitors the child pane/session for output, progress, and completion.
7. When the child finishes or exits, the extension captures a summary and stores resume metadata.
8. The extension returns a structured result to the parent session and keeps enough state for later resume when possible.

### Integration Points

- **Copilot CLI extension SDK**
  - `joinSession()`
  - tool registration
  - hooks where useful
  - `session.workspacePath`
  - `session.rpc.workspace.*`
  - `session.rpc.agent.*`
  - `session.rpc.plan.*` when workflow skills want plan-aware behavior
  - `session.rpc.fleet.start` only if implementation validation proves it helps

- **Terminal multiplexers**
  - `cmux`
  - `tmux`
  - `zellij`

- **Copilot runtime**
  - child Copilot launches or resumes inside panes
  - built-in and custom agent selection
  - session IDs and any resumable state surfaced by Copilot

### Architecture Diagram

```text
Main Copilot Session
        |
        v
+---------------------------+
| Copilot CLI Extension     |
| - tool handlers           |
| - session-state helpers   |
| - summary/progress logic  |
+-------------+-------------+
              |
              v
+---------------------------+
| Multiplexer Adapter       |
| cmux | tmux | zellij      |
+-------------+-------------+
              |
              v
+---------------------------+
| Pane-launched Subsession  |
| Copilot agent invocation  |
| built-in or custom agent  |
+---------------------------+
```

### Key Interfaces

The exact tool names can change, but the project should support the following interface shape. Recommended names are namespaced to reduce collision risk.

- **`copilot_subagent_launch` — launch a single subagent**
  - inputs: `agentIdentifier`, `task`, `interactive`, optional `backend`, optional `modelOverride`, optional `contextRef`
  - outputs: `launchId`, `backend`, `paneId`, optional `sessionId`, `status`, `summary`, `exitCode`, optional `resumeRef`

- **`copilot_subagent_parallel` — launch parallel subagents**
  - inputs: `launches: Array<{ agentIdentifier, task, interactive?, backend?, modelOverride?, contextRef? }>`
  - outputs: `results: Array<{ launchId, backend, paneId, sessionId?, status, summary, exitCode, resumeRef? }>`, `aggregateStatus`

- **`copilot_subagent_list_agents` — list available agents**
  - inputs: optional filters such as `includeBuiltIns`, `includeCustom`, `backend`
  - outputs: discoverable agent identifiers plus metadata about how each was resolved or validated

- **`copilot_subagent_resume` — resume a prior subagent**
  - inputs: `launchId` or an equivalent stored launch reference
  - outputs: updated pane/session metadata, new status, new summary, updated resume pointer or structured failure

- **`copilot_subagent_set_title` — optional title/progress helper**
  - inputs: human-readable phase/title plus optional backend override
  - outputs: backend-specific title changes when supported

## What Changes

- Create a new project at `~/.projects/copilot-interactive-subagents`.
- Add canonical spec infrastructure under `specs/`.
- Implement a Copilot CLI extension entrypoint under `.github/extensions/...` during execution work.
- Port the multiplexer backend abstraction from the pi extension into a Copilot-compatible runtime.
- Replace pi-specific artifact/session assumptions with a generic Copilot session-state model.
- Add tools for single launch, parallel launch, listing available agents, and resume.
- Add documentation describing how external Agent Skills can layer workflow-specific behavior on top of the extension.

### Expected Project Layout

```text
.github/
  extensions/
    copilot-interactive-subagents/
      extension.mjs
      lib/
        mux.mjs
        agents.mjs
        launch.mjs
        parallel.mjs
        state.mjs
        summary.mjs
        resume.mjs
        titles.mjs
specs/
  README.md
  SPEC_TEMPLATE.md
  subagents/
    copilot-interactive-subagents.md
test/
  mux-discovery.test.mjs
  single-launch.test.mjs
  parallel-launch.test.mjs
  resume.test.mjs
  tool-interface.test.mjs
README.md
docs/
  skills-integration.md
```

## Success Criteria

- Pane layout behavior is deterministic and verified for every backend that has automated coverage; unsupported CI backends have explicit manual verification steps.
- Single-agent launch passes automated acceptance coverage and returns non-empty summaries.
- Parallel launch preserves per-agent attribution, deterministic result ordering, and accurate partial-failure reporting.
- Resume works whenever valid metadata exists and fails with structured diagnostics whenever it does not.
- Agent-agnostic design is preserved: the extension works without bundled prompts and can be called from other Copilot workflows.
- Skills can layer on top cleanly through the documented generic tool surface.

## Failure Modes / Risks

- Automatic multiplexer start/attach may not be equally reliable across all supported backends.
- The exact Copilot sub-session launch mechanism may not align cleanly with pane-managed child processes.
- Built-in agent selection and custom agent selection may require different launch pathways.
- Pane-screen scraping may be brittle if Copilot output format changes.
- Resume metadata may drift if workspace files are deleted or if session IDs become invalid.
- Multiplexer feature differences may force backend-specific edge-case handling.
- Cross-session discovery can become confusing if project-local indexing and session workspace state disagree.
- Parallel launches may increase git or filesystem contention if users point multiple write-capable agents at the same repository state.

## Testing Strategy

The project should use a layered test strategy rather than relying on one class of checks.

### 1. ATDD outer loop

Each deliverable should begin from its acceptance criteria and express at least one end-to-end acceptance test in GIVEN / WHEN / THEN form before production code is written.

Representative acceptance scenarios:

- GIVEN a supported backend and valid agent name WHEN a single launch is requested THEN a visible pane opens, the child session starts, and a structured summary is returned.
- GIVEN multiple valid launch requests WHEN parallel launch is requested THEN panes are created deterministically and per-agent progress/results remain separated.
- GIVEN stored metadata from an earlier session WHEN resume is requested THEN the extension restores or clearly fails the resume path with actionable diagnostics.

These ATDD scenarios are the proof objects for each deliverable and should align directly with the `tix` deliverable acceptance criteria. Each deliverable's `## Test Matrix` section defines which checks are required versus advisory for that slice.

### 2. Unit tests

Unit tests should cover deterministic logic with minimal runtime dependencies:

- backend detection and backend-priority selection
- command construction and shell escaping
- exact-name agent validation
- path safety
- session-state read/write helpers
- launch-manifest serialization and lookup
- summary extraction logic
- progress/result shaping

### 3. Integration tests

Integration tests should validate subsystem boundaries with real extension modules wired together:

- single-agent launch flow against each supported multiplexer where automation is possible
- parallel launch coordination
- resume behavior when metadata exists
- agent listing for built-in and custom agent targets
- automatic multiplexer start/attach behavior where supported
- interaction between launch, monitoring, summary, and state-store modules

### 4. End-to-end tests

Automated end-to-end smoke tests should exercise the extension as an installed Copilot CLI extension in a real project environment:

- install/load the extension
- invoke the generic launch tool from a parent Copilot session
- launch a built-in agent into a pane
- launch an installed custom agent into a pane
- complete a run and verify summary + resume metadata
- execute a resume across sessions when metadata exists

Where full automation is not practical for every backend, the project should still maintain at least one repeatable end-to-end path in CI or local verification scripts plus backend-specific manual checks.

### 5. Mutation testing

Mutation testing should be applied to the deterministic business-logic and API-contract parts of the extension, not indiscriminately to every shell-integration layer.

Primary mutation-testing candidates:

- backend selection logic
- agent validation and request normalization
- session-state serialization and lookup logic
- summary extraction and result mapping
- resume decision logic

Target:

- mutation score **>= 80%** for new business-logic / contract-oriented code

Guidance:

- mutation testing is **required** for deterministic logic modules
- mutation testing is **advisory or skipped** for thin infrastructure/glue code that mainly shells out to multiplexers or Copilot runtime commands

### 6. CRAP score evaluation

CRAP score should be used as a reviewability gate for new logic-heavy functions.

Target:

- **CRAP < 8** for new business-logic functions
- **CRAP 8-15** is acceptable only for documented reconciliation or decision-heavy functions, and requires an explicit refactoring note once CRAP reaches 9 or higher
- **CRAP >= 16** in legacy or glue-heavy infrastructure code is advisory unless the function is both central and growing
- **CRAP > 30** is always unacceptable and should trigger refactoring before merge

Primary CRAP-evaluation candidates:

- backend selection and attach/start decision logic
- launch planning / result mapping logic
- resume reconciliation logic
- summary extraction logic

### 7. Work-type scaling

Not every file in this project carries the same testing burden:

- **Business logic / contract code**: full RED -> GREEN -> REFACTOR, ATDD outer loop, mutation testing, CRAP gate
- **Integration SDK code**: unit + integration + end-to-end smoke coverage, mutation advisory
- **Infrastructure / shell glue**: behavior verification and integration checks first, mutation optional, CRAP advisory unless complexity grows

### 8. Manual workflow checks

Manual verification should remain part of release readiness:

- Copilot calls the generic launch tool during a larger workflow
- launch an installed custom agent into a pane
- launch a built-in agent into a pane
- verify pane titles and visible layout behavior
- close and resume across sessions
- validate that the extension remains useful without any bundled example skills
