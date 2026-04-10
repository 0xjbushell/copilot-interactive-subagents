# Interactive Subagents v1

Persistent, interactive, and resumable subagent sessions for Copilot CLI in tmux and zellij panes.

## Start Here

> **If you read nothing else, read this section and "Data / Control Flow".**

This spec adds 6 capabilities to the existing extension: **ephemeral panes** (auto-close after completion), **persistent sessions** (tracked by UUID), **interactive mode** (user collaborates in pane), **resume** (continue a completed session), **fork** (copy a session's context into a new child), and **explicit completion** (`subagent_done` tool).

### How to Use This Spec

**Don't read the whole spec.** Use your ticket's Quick Start to find the sections you need:
- **Lines 30-44**: Wave table — which services exist, their files, and dependencies
- **Lines 47-63**: Touchpoint map — which files each feature touches
- **Lines 155-177**: Cross-cutting invariants — rules that apply to ALL code paths
- **Lines 275-322**: DI pattern — copy this for any new service
- **Lines 326-670**: Service-by-service contracts (find yours by wave number)
- **Lines 785-945**: Testing strategy, E2E harness, scenario matrix

Your ticket tells you exactly which lines to read. Start there, not here.

### What to Build (Implementation Waves)

**Wave 0 (prerequisite):** Create test directory structure before writing any new test files:
```bash
mkdir -p test/unit test/integration test/e2e
```

| Wave | Service | File | Action | Depends On | Test File |
|------|---------|------|--------|------------|-----------|
| 0 | Test directory structure | `test/unit/`, `test/integration/`, `test/e2e/` | **Create dirs** | — | — |
| 0 | Shared fixtures | `test/helpers/fixtures.mjs` | **New** | — | — |
| 1 | Manifest v2 schema | `lib/state.mjs` | Update | — | `test/state-store.test.mjs` (update) |
| 1 | Launch command builder | `extension.mjs` | Update | — | `test/unit/launch-command.test.mjs` (new) |
| 2 | `sessionLock` | `lib/session-lock.mjs` | **New** | — | `test/unit/session-lock.test.mjs` (new) |
| 2 | `closePane` | `lib/close-pane.mjs` | **New** | — | `test/unit/close-pane.test.mjs` (new) |
| 2 | `extractSessionSummary` | `lib/summary.mjs` | Update | — | `test/unit/summary-extraction.test.mjs` (new) |
| 3 | `forkSession` | `lib/fork-session.mjs` | **New** | sessionLock | `test/unit/fork-session.test.mjs` (new) |
| 3 | `subagent_done` tool | `extension.mjs` | Update | — | `test/unit/subagent-done.test.mjs` (new) |
| 4 | Resume flow | `lib/resume.mjs` | Update | sessionLock, extractSessionSummary | `test/resume.test.mjs` (update) |
| 4 | Launch orchestration | `lib/launch.mjs` | Update | closePane, sessionLock, forkSession | `test/single-launch.test.mjs` (update) |
| 5 | Integration + E2E | — | — | Waves 1-4 | `test/e2e/*.test.mjs` (new) |

**Waves 1-2 are parallelizable.** Wave 3 depends on sessionLock from Wave 2. Wave 4 integrates everything. Wave 5 validates end-to-end.

### Touchpoint Map (Feature → Files to Edit)

| Feature | Files to Create/Edit |
|---------|---------------------|
| Pre-generated session IDs | `extension.mjs` (launch command builder), `lib/state.mjs` (manifest v2) |
| Interactive mode (`-i` flag) | `extension.mjs` (command builder: `-i` vs `-p`), `lib/launch.mjs` (skip sentinel for interactive) |
| Ephemeral panes | `lib/close-pane.mjs` (new), `lib/launch.mjs` (call closePane after completion) |
| Session fork | `lib/fork-session.mjs` (new), `lib/launch.mjs` (fork before launch) |
| Resume | `lib/resume.mjs` (new pane + `--resume`), `lib/session-lock.mjs` (new) |
| Summary extraction | `lib/summary.mjs` (add `extractSessionSummary`), `lib/launch.mjs` (call after completion) |
| `subagent_done` tool | `extension.mjs` (register tool — loaded via extension sidecar in child sessions with TTY). Writes signal file to `.copilot-interactive-subagents/done/<copilotSessionId>`. Returns result (does NOT call `process.exit` — sidecar ≠ copilot process). |
| Backend preference | `lib/mux.mjs` (zellij first when both available) |
| Session liveness probing | `lib/mux.mjs` (backend-specific: `probeSessionLiveness`), `lib/launch.mjs` (backend-agnostic wrapper) |
| Manifest v2 | `lib/state.mjs` (schema), `lib/state-index.mjs` (propagation), all tests with `metadataVersion: 1` |
| Parallel passthrough | `lib/parallel.mjs` (pass new v1 params `interactive`, `fork`, `closePaneOnCompletion` to individual launches) |
| Quality targets | `scripts/quality/targets.mjs` (add new v1 modules to CRAP/mutation targets) |
| Test scripts | `package.json` (add `test:unit`, `test:integration`, `test:e2e` scripts) |

### Verified Commands

```bash
# Dev inner loop
npm test                           # all tests (~3s)
npm run test:crap                  # CRAP < 8 for all targets
npm run test:mutation              # mutation kill rate ≥ 80%

# Deploy to test live
cp -r .github/extensions/copilot-interactive-subagents ~/.copilot/extensions/copilot-interactive-subagents

# Verify copilot sees the extension (start a new copilot session — extensions load at startup)
copilot -i "list your available tools"
```

## Traceability

- **Shared Key**: `interactive-subagents-v1`
- **Spec Path**: `specs/subagents/interactive-subagents-v1.md`
- **Decision Refs**: `specs/decisions/interactive-subagents-v1-decisions.md`
- **Exploration**: `specs/explorations/interactive-subagents-v1.md`

## Problem Statement

The current `copilot-interactive-subagents` extension launches subagents in multiplexer panes using `copilot -p "task"` (one-shot mode). After the task completes, panes linger with idle shells — creating pane sprawl with no way to reuse, resume, or continue conversations. Session context is lost when the copilot process exits.

Users need: ephemeral panes that clean up automatically, persistent sessions that survive pane death, interactive collaboration in subagent panes, the ability to resume a subagent's conversation later, and the ability to fork a session to give a subagent full parent context.

## Scope

### In Scope
- Ephemeral pane lifecycle (close after completion, configurable)
- Pre-generated session IDs for deterministic session tracking
- Interactive mode (`-i` flag) for user collaboration in subagent panes
- Session resume via `copilot --resume=<copilotSessionId>` in new panes
- Session fork via directory copy for context sharing
- Summary extraction from `events.jsonl` and `workspace.yaml`
- First-class support for both tmux and zellij (zellij preferred)
- `subagent_done` tool for explicit self-termination from child sessions
- Launch manifest schema v2 (replaces v1 — no backward compatibility needed, no existing users)

### Out of Scope
- Bundled agent definitions (deferred; `--agent` flag exists for custom agents)
- Session artifacts / file storage extension
- Automatic pane reuse / pane pooling (sessions make this unnecessary)
- Parent-child session linking beyond fork metadata
- Manifest v1 backward compatibility (no users on v1 schema)

### cmux Backend Compatibility

cmux remains in the public tool interface and backend discovery but **does not receive v1 session features**. Specifically:
- cmux launches continue to work as they do today (one-shot, no session ID, no pane cleanup)
- `interactive`, `fork`, and `closePaneOnCompletion` parameters are ignored for cmux launches (logged as warning)
- Resume of a cmux-launched session returns `RESUME_NOT_SUPPORTED` error (cmux manifests have `copilotSessionId: null` — no session to resume)
- No cmux-specific tests are added or removed
- **Manifest v2 fields for cmux**: `copilotSessionId: null`, `interactive: false`, `fork: null`, `closePaneOnCompletion: false`, `eventsBaseline: null`. The v2 schema applies to ALL launches (cmux included) — cmux simply gets null/false defaults for session-related fields.

## Design Decisions

See `specs/decisions/interactive-subagents-v1-decisions.md` for the full decision log with evidence from learning tests.

Summary:

| ID | Decision | Source |
|----|----------|--------|
| D1 | Panes are ephemeral — closed after completion by default | `[decision]` `[research]` |
| D2 | Pre-generate session UUIDs via `--resume=<UUID>` | `[research]` LT1 |
| D3 | Interactive mode uses `-i` flag, returns immediately | `[user]` `[research]` LT3 |
| D4 | Fork = copy session dir + update yaml + resume copy | `[research]` LT2b |
| D5 | Resume = new pane + `--resume=<copilotSessionId>` | `[decision]` `[research]` LT3 |
| D6 | Autonomous completion uses existing sentinel pattern | `[codebase]` |
| D7 | Summary from `events.jsonl` last assistant message | `[research]` LT5 |
| D8 | Zellij preferred when both backends available | `[user]` |
| D9 | Manifest schema v2 (clean break, no v1 compat needed) | `[codebase]` `[user]` |
| D10 | `subagent_done` tool for explicit self-termination | `[user]` `[codebase]` |

## Validated Assumptions

Every assumption below was verified by a learning test (LT) before this spec was written. If any assumption becomes false in a future Copilot CLI version, the linked feature must be re-evaluated.

| Assumption | Evidence | Status | If False |
|-----------|----------|--------|----------|
| `copilot --resume=<new-UUID>` creates a session dir at `~/.copilot/session-state/<UUID>/` | LT1: confirmed, UUID must be RFC 4122 | ✅ Proven | Session identity model breaks — must find alternative |
| Fork via `cp -r session-state/<parent>/ <fork>/` + yaml id update preserves full context | LT2b: fork recalled all parent context, parent untouched (18 events before/after) | ✅ Proven | Fork feature breaks — need Copilot CLI fork API |
| `-i "task"` + `--resume=<UUID>` work together for interactive resume | LT3: confirmed, full context retained | ✅ Proven | Interactive resume breaks — must use `-p` with sentinel |
| Bare `--resume=<UUID>` (no `-i`, no `-p`) starts copilot in interactive mode | LT-B7: confirmed; bare `--resume` opens interactive session. Bare `-i` without prompt fails ("argument missing"). | ✅ Proven | Prompt-less resume would need alternative approach |
| `events.jsonl` contains `assistant.message` events with `data.content` for summary | LT5: confirmed, reliable across session types | ✅ Proven | Summary extraction breaks — fall back to workspace.yaml only |
| Sentinel pattern (`__SUBAGENT_DONE_<code>__`) works unchanged with `--resume` | Existing codebase: sentinel is shell-level, independent of session flags | ✅ Proven | Autonomous completion detection breaks |
| Extension tools only load when copilot has a real TTY (tmux pane, terminal) — not when stdout is piped | LT: confirmed; `copilot -i` in tmux pane → extensions loaded; same command piped → no extensions. TTY detection controls extension sidecar forking. | ✅ Proven | E2E harness must use tmux panes (real PTY), not piped invocations |
| `extensions_reload` kills extension sidecars without restarting them | LT: confirmed; reload is destructive and non-recoverable within the session | ✅ Proven | Hot-reload development workflow breaks — new session required after extension changes |

## Cross-Cutting Invariants

These rules apply to ALL services and ALL code paths. Violating any of these is a bug.

1. **Safe task transport**: NEVER interpolate user-provided task strings directly into shell commands. Use the existing base64 env var pattern (`COPILOT_SUBAGENT_TASK_B64`). This prevents shell injection.

2. **Panes are ephemeral, sessions are persistent**: A pane is a disposable view. A session lives in the Copilot session-state directory (resolved at startup — see invariant 12) and survives pane death. Destroying a pane does NOT destroy a session.

3. **Manifest is the single source of launch state**: Every launch/resume/fork operation reads and writes the manifest at `.copilot-interactive-subagents/launches/<launchId>.json`. No in-memory-only state.

4. **Lockfile before mutation**: Any operation that **mutates** session state (resume, fork, terminal manifest transition) MUST acquire the per-`copilotSessionId` lockfile first. Atomic `O_CREAT | O_EXCL`. Release on completion. **Pure reads** (summary extraction that only returns data) are exempt — `events.jsonl` is append-only by copilot, so reads are safe without locking. **But**: any code path that reads AND then transitions state (e.g., extract summary → update manifest → close pane) MUST hold the lock for the entire sequence.

5. **Sequence: extract → manifest → close**: After autonomous completion, ALWAYS extract summary BEFORE closing the pane. The sequence is: detect sentinel → extract summary → update manifest to terminal → close pane.

6. **Autonomous panes are non-interactive**: User input in an autonomous (`-p`) pane is unsupported. No "user takeover" state transition exists. If the user wants to interact, they resume the session.

7. **Existing flags preserved**: The launch command builder MUST preserve all flags from `createDefaultAgentLaunchCommand()` (`--allow-all-tools`, `--allow-all-paths`, `--allow-all-urls`, `--no-ask-user`). v1 adds `--resume=<UUID>` and selects `-i`/`-p`. For autonomous mode (`-p`), also keep `-s` (suppress stats in output, useful for scripting). For interactive mode (`-i`), omit `-s` so the user sees copilot's full UI. **cmux backend**: skip `--resume` and v1 flags — cmux launches use legacy behavior (see cmux Compatibility).

8. **Graceful degradation on missing data**: Summary extraction returns `null` (not crash) on missing session dir, empty events.jsonl, or truncated JSONL. Fork returns structured error (not crash) on disk full or permission errors.

9. **Extension tools require a real TTY**: Extension sidecars are only forked when copilot detects a real TTY (e.g., tmux pane, terminal). Piped invocations and subshells do NOT load extensions. Subagent child sessions launched in tmux panes DO get extension tools (tmux provides a PTY). E2E tests must run copilot in tmux panes, not piped commands. **Note**: This is observed behavior, not a documented API contract. The actual trigger appears to be the `SESSION_ID` environment variable set by copilot's runtime. If this behavior changes, E2E testing strategy must be re-evaluated.

10. **Caller-owned locks**: The caller that acquires a lock is responsible for releasing it. Locks are NOT automatically released on operation completion — the caller must explicitly call `release()`. Process exit cleanup is a safety net for graceful shutdown only — **SIGKILL and hard crashes will leave stale locks** (see stale lock recovery in sessionLock contract).

11. **Atomic file writes**: All manifest and index writes MUST use the temp-file + `rename()` pattern. Write to `<path>.tmp.<pid>`, then `fs.renameSync()` to the final path. This prevents concurrent readers from seeing truncated JSON. `rename()` is atomic on the same filesystem (POSIX guarantee, verified by learning test).

12. **Path resolution**: Never hardcode `~/.copilot/`. Resolve the Copilot home directory at startup: check `COPILOT_HOME` env → `--config-dir` if passed → default `path.join(os.homedir(), '.copilot')`. Store the resolved path in a module-level constant. All session state paths derive from this.

13. **Sync-first, async when proven needed**: The existing codebase uses `spawnSync` for all shell commands (tmux/zellij). This is correct — tool invocations block the Copilot model anyway. Do NOT refactor to async/await unless a concrete perf bottleneck is measured. `awaitCompletion` polling is the exception — it uses `setTimeout` loops to avoid blocking the tool timeout mechanism.

## Architecture

### Component Overview

```
┌─────────────────────────────────────────────────────────────┐
│  Parent Copilot Session (orchestrator)                      │
│                                                             │
│  ┌──────────────────────┐  ┌──────────────────────────────┐ │
│  │ Tool: launch         │  │ Tool: resume                 │ │
│  │  • interactive/auto  │  │  • new pane                  │ │
│  │  • fork context      │  │  • --resume=<sessionId>      │ │
│  │  • pre-gen sessionId │  │  • summary extraction        │ │
│  └──────┬───────────────┘  └──────┬───────────────────────┘ │
│         │                         │                         │
│  ┌──────┴─────────────────────────┴───────────────────────┐ │
│  │ Launch Manifest Store (.copilot-interactive-subagents/) │ │
│  │  • launchId → {copilotSessionId, paneId, backend, ...} │ │
│  └──────┬─────────────────────────────────────────────────┘ │
│         │                                                   │
│  ┌──────┴─────────────────────────────────────────────────┐ │
│  │ Backend Services (tmux / zellij)                       │ │
│  │  • openPane → split-window / new-pane                  │ │
│  │  • closePane → kill-pane / close-pane                  │ │
│  │  • sendCommand → send-keys / write-chars               │ │
│  │  • readOutput → capture-pane / dump-screen             │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
┌─────────────────────┐  ┌──────────────────────────────────┐
│ Multiplexer Pane    │  │ Copilot Session State            │
│ (ephemeral view)    │  │ ~/.copilot/session-state/<UUID>/ │
│                     │  │  • events.jsonl                  │
│ copilot -i/-p task  │  │  • workspace.yaml                │
│ ...working...       │  │  • checkpoints/                  │
│ [pane closed]       │  │  (persists after pane death)     │
└─────────────────────┘  └──────────────────────────────────┘
```

### Parameter Flow — How `copilotSessionId` Threads Through the Call Chain

Understanding this flow is essential for implementing v1. The existing codebase uses a **plan → persist → execute** pipeline. v1 adds `copilotSessionId` to the plan and threads it through all layers.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ handleLaunch(request, services)  [extension.mjs]                            │
│   request.interactive, request.fork, request.closePaneOnCompletion          │
│                                                                              │
│   ↓ normalizes request, resolves agent + backend                             │
│                                                                              │
│ launchSingleSubagent({request, agentValidation, backendResolution, services})│
│   [lib/launch.mjs]                                                           │
│                                                                              │
│   ↓ planSingleLaunch() — generates copilotSessionId HERE                     │
│                                                                              │
│ Plan object: { launchId, copilotSessionId, interactive, fork,                │
│                closePaneOnCompletion, ...existing fields }                    │
│                                                                              │
│   ↓ openPaneAndPersist() — spreads plan into createLaunchRecord()            │
│                                                                              │
│ createLaunchRecord({...plan, paneId, status: "pending"})  [lib/state.mjs]    │
│   → writes manifest with metadataVersion: 2                                 │
│                                                                              │
│   ↓ runChildLaunch() — calls launchAgentInPane() with plan + paneId          │
│                                                                              │
│ defaultLaunchAgentInPane({backend, paneId, task, ...context})                │
│   [extension.mjs]                                                            │
│   context NOW includes: copilotSessionId, launchId, interactive              │
│                                                                              │
│   ↓ calls createDefaultAgentLaunchCommand(request, runtimeServices, context) │
│                                                                              │
│ createDefaultAgentLaunchCommand(request, runtimeServices,                    │
│   { agentIdentifier, task, copilotSessionId, launchId, interactive, backend})│
│   → builds shell string with --resume=<copilotSessionId>,                    │
│     -i/-p selection, env vars COPILOT_SUBAGENT_SESSION_ID + _LAUNCH_ID       │
│   → cmux backend: skips --resume and v1 flags entirely                       │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Concrete changes per layer:**

| Layer | File | Current Signature | What to Add |
|-------|------|-------------------|-------------|
| `planSingleLaunch()` | `lib/launch.mjs` | `({request, agentValidation, backendResolution, createLaunchId, now})` | Add `createCopilotSessionId = () => randomUUID()`. Extract `request.interactive` (default `false`), `request.fork` (default `null`), `request.closePaneOnCompletion` (default `!interactive`). Generate `copilotSessionId` via `createCopilotSessionId()` for tmux/zellij, `null` for cmux. Add all to returned plan. |
| `createLaunchRecord()` | `lib/state.mjs` | `({launchId, agentIdentifier, ..., metadataVersion})` | Add params: `copilotSessionId = null`, `interactive = false`, `fork = null`, `closePaneOnCompletion = true`, `eventsBaseline = null`. Include in returned object. Bump `METADATA_VERSION` to `2`. |
| `defaultLaunchAgentInPane()` | `extension.mjs` | `({backend, request, runtimeServices, ...context})` | Pass `context.copilotSessionId`, `context.launchId`, `context.interactive`, `context.backend` through to `createDefaultAgentLaunchCommand()`. |
| `createDefaultAgentLaunchCommand()` | `extension.mjs` | `(request, runtimeServices, {agentIdentifier, task})` | Destructure `copilotSessionId`, `launchId`, `interactive`, `backend` from 3rd arg. If cmux: return existing command unchanged. Otherwise: add `--resume=<copilotSessionId>`, select `-i`/`-p`, set env vars, omit `-s` when interactive. |

**How to test (mock pattern):**

```javascript
// Tests intercept via createExtensionHandlers() overrides — same as existing tests.
// To verify command builder output, mock launchAgentInPane and capture the context:

const handlers = await createExtensionHandlers({
  // ... existing mocks for openPane, resolveLaunchBackend, etc.
  launchAgentInPane: async (context) => {
    // context now includes copilotSessionId, launchId, interactive, backend
    capturedContext = context;
    return { sessionId: "session-123" };
  },
});

// To verify the actual shell command string, override createAgentLaunchCommand:
const handlers = await createExtensionHandlers({
  createAgentLaunchCommand: (request, runtimeServices, context) => {
    capturedCommand = { request, context };
    return "echo test-command";
  },
});
```

### Data / Control Flow

**Autonomous launch (`interactive: false`, default):**
1. Generate `copilotSessionId` (UUID)
2. Open pane via backend (`tmux split-window` / `zellij action new-pane`)
3. Write launch manifest (status: **"pending"**) — persist BEFORE sending command so crash recovery can find orphaned panes
4. Build launch command: preserve all existing flags from `createDefaultAgentLaunchCommand()` (including `--allow-all-tools`, `--allow-all-paths`, `--allow-all-urls`, `--no-ask-user`, `-s`), and add `--resume=<copilotSessionId>` and `-p "task"`. **Task transport must use the existing safe encoding pattern** (base64 env var or equivalent) — never raw shell interpolation of user-provided task strings. **cmux backend**: skip `--resume`, `-i`/`-p` selection, session ID env vars, and `-s` — use the legacy command builder path unchanged (see invariant 7).
5. Wrap in node sentinel script, send to pane
6. Update manifest (status: "running")
7. Poll for sentinel (`__SUBAGENT_DONE_<code>__`) OR done signal file — whichever first
8. Acquire lock → extract summary from session state files → update manifest (status: "success"/"failure", summary, exitCode) → close pane → release lock
9. Return result with `resumePointer`

**Interactive launch (`interactive: true`):**
1. Generate `copilotSessionId` (UUID)
2. Open pane via backend
3. Write launch manifest (status: **"pending"**)
4. Build launch command: preserve all existing flags, add `--resume=<copilotSessionId>` and `-i "task"` (replace `-p` with `-i`, omit `-s` for interactive). **Same safe transport rules apply** — task content must not be interpolated raw into the shell command.
5. Send to pane directly (no sentinel wrapper needed — user may interact)
6. Update manifest (status: "interactive")
7. If `awaitCompletion: false` (default for interactive): return immediately with pane metadata
8. If `awaitCompletion: true`: monitor pane for process exit (same polling as autonomous, but no sentinel — rely on pane death + signal file). On completion: extract summary → update manifest → return result. Timeout still applies.
9. User works in pane, exits via Ctrl+D or model concludes
10. On resume or status check: extract summary from session state

**Fork launch (`fork: { launchId }` or `fork: { copilotSessionId }`):**
1. Resolve parent's `copilotSessionId` (from manifest if `launchId` provided, or use directly)
2. Verify parent session is quiescent (see Lifecycle Guards)
3. Generate new `copilotSessionId` for fork
3. Copy `~/.copilot/session-state/<parent>/` → `~/.copilot/session-state/<fork>/`
4. Update `workspace.yaml` `id:` field in the copy
5. Proceed with autonomous or interactive launch using `--resume=<fork-UUID>`

**Resume:**
1. Read launch manifest → get `copilotSessionId`
2. Verify session is quiescent (see Lifecycle Guards below); reject if active
3. Open new pane via backend
4. If `task` provided: send `copilot --resume=<copilotSessionId> -i "task"` (using safe transport)
5. If no `task`: send `copilot --resume=<copilotSessionId>` (bare `--resume` without `-i`; copilot opens with prior context in interactive mode. **Learning test confirmed**: bare `-i` without a prompt argument fails with "argument missing"; bare `--resume` without `-i` starts interactive mode successfully.)
6. Record `eventsBaseline` **BEFORE step 3** (current event count in session's events.jsonl) for delta summary — must be captured under lock before the child starts writing events
7. Update manifest (status: "interactive", paneId: new pane, eventsBaseline)
8. Release lock (pane is now running — lock held only during setup)
9. If `awaitCompletion`: monitor for process exit, extract summary (re-acquire lock for terminal transition)
10. If fire-and-forget: return pane metadata immediately

### Integration Points

- **Copilot CLI**: `--resume=<UUID>`, `-i`/`-p` flags, `--allow-all-tools`, `--agent`, `-s` (suppress stats, not all output)
- **Copilot session state**: Resolved Copilot home directory (default `~/.copilot/`) + `session-state/<UUID>/`
- **tmux**: `split-window`, `send-keys`, `capture-pane`, `kill-pane`, `list-panes`
- **zellij**: `action new-pane`, `action write-chars`, `action dump-screen`, `action close-pane`. **Known gap**: Zellij pane liveness probe is less mature than tmux — `zellij action list-clients` may not reliably indicate pane state. If liveness checking is unreliable during implementation, document it and fall back to `zellij action dump-screen` (which errors on dead panes).
- **Extension SDK**: `joinSession({ tools })` for tool registration
- **Launch manifest store**: `.copilot-interactive-subagents/launches/<launchId>.json`

### Service-by-Service Reference

Each service below includes its interface contract, file location, inline rationale, and acceptance criteria. Implement in the wave order from "Start Here".

#### Dependency Injection Pattern (follow this for all new services)

This codebase uses **constructor-style DI via plain async functions** — no classes, no DI framework. Dependencies are passed as a `services` object, with fallback to defaults imported at the top of the file. Tests inject mocks via the same `services` parameter.

```javascript
// === Pattern for NEW services (e.g., lib/close-pane.mjs) ===

import { spawnSync as defaultSpawnSync } from "node:child_process";

// Export a pure function. Dependencies come in via the services object.
export async function closePane({ backend, paneId, services = {} }) {
  const spawnSync = services.spawnSync ?? defaultSpawnSync;
  // ... implementation using spawnSync ...
}

// === How tests inject mocks ===

import { closePane } from "../../.github/extensions/copilot-interactive-subagents/lib/close-pane.mjs";

it("GIVEN tmux backend WHEN closePane called THEN runs kill-pane", async () => {
  const calls = [];
  await closePane({
    backend: "tmux",
    paneId: "%1",
    services: {
      spawnSync: (cmd, args) => { calls.push({ cmd, args }); return { status: 0 }; },
    },
  });
  assert.deepStrictEqual(calls[0], { cmd: "tmux", args: ["kill-pane", "-t", "%1"] });
});

// === Pattern for EXISTING services (e.g., lib/launch.mjs) ===
// These use a resolve* helper to find deps from request, then services, then defaults:

function resolveStateStore({ request, services = {} }) {
  return request.stateStore ?? services.stateStore
    ?? (request.createStateStore ?? services.createStateStore ?? defaultCreateStateStore)({
      workspacePath: request.workspacePath,
    });
}

// When updating existing services, add new deps to the existing resolve pattern:
function resolveClosePane({ request, services = {} }) {
  return request.closePane ?? services.closePane ?? defaultClosePane;
}
```

**Key rule**: every external dependency (fs, child_process, other services) must be injectable via `services`. This is what makes the codebase testable without mock libraries.

---

#### Launch Command Builder (Wave 1) — Update `extension.mjs`

Modifies `createDefaultAgentLaunchCommand()` to add `--resume=<UUID>` and select `-i`/`-p`.

```javascript
// Input: existing launch args + new v1 params + backend
// Output: single shell command string (NOT an array) — same contract as current code

// Key behaviors:
// - For tmux/zellij: adds --resume=<copilotSessionId> (pre-generated UUID)
// - For cmux: skips --resume and v1 flags (legacy path, copilotSessionId null in manifest)
// - interactive: true  → use -i "task", omit -s
// - interactive: false → use -p "task", keep -s (suppress stats, existing behavior)
// - Prompt-less (no task): use bare --resume=<UUID> without -i or -p (copilot defaults to interactive)
// - All existing flags preserved: --allow-all-tools, --allow-all-paths, --allow-all-urls, --no-ask-user
// - Task content via base64 env var (COPILOT_SUBAGENT_TASK_B64) — NEVER raw interpolation
// - MUST set env vars: COPILOT_SUBAGENT_SESSION_ID=<copilotSessionId> and COPILOT_SUBAGENT_LAUNCH_ID=<launchId>
```

**Rationale**: `-i` vs `-p` determines whether copilot stays alive for interaction (LT3 confirmed). `--resume=<UUID>` creates a session with a known ID so we can track, resume, and fork it (LT1 confirmed).

**Test file**: `test/unit/launch-command.test.mjs` (new)

**Acceptance criteria**:
- `-i` flag present when `interactive: true`, `-p` flag present when `interactive: false`
- `--resume=<UUID>` always present with valid RFC 4122 UUID
- All existing flags from `createDefaultAgentLaunchCommand()` preserved
- Task content survives shell metacharacters (quotes, newlines, `$`, backticks)
- `-s` flag omitted when interactive (user needs to see output)

---

#### Manifest v2 Schema (Wave 1) — Update `lib/state.mjs`

Adds new fields to the launch manifest. Bumps `metadataVersion` to 2.

**Concrete change**: In `lib/state.mjs`, change `export const METADATA_VERSION = 1;` → `export const METADATA_VERSION = 2;` and add new fields to the existing `createLaunchRecord()` function (do NOT rename it — all existing call sites use this name). Update all tests that assert `metadataVersion: 1` (search: `grep -rn 'metadataVersion.*1' test/`). The spec's acceptance criterion `createManifestV2()` refers to this same function producing v2-shaped records.

**v2 field defaults** (add to `createLaunchRecord()` parameter destructuring):

```javascript
export function createLaunchRecord({
  // ... existing params unchanged ...
  // NEW v2 params with defaults:
  copilotSessionId = null,        // null for cmux, UUID for tmux/zellij
  interactive = false,            // true if launched with -i flag
  fork = null,                    // { parentCopilotSessionId, parentLaunchId } or null
  closePaneOnCompletion = true,   // caller overrides to false for interactive
  eventsBaseline = null,          // event count at launch time, for delta summary
  metadataVersion = METADATA_VERSION,  // now 2
} = {}) {
  // ... existing validation/normalization ...
  // Add new fields to returned object alongside existing ones
}
```

**Important**: `closePaneOnCompletion` defaults to `true` in the factory because `planSingleLaunch()` is responsible for setting the context-dependent default (`!interactive`). The factory is a dumb record builder — it does not infer defaults from other fields.

```javascript
// Launch manifest v2 shape:
{
  // existing (preserved)
  launchId: string,
  agentIdentifier: string,
  agentKind: string,          // "built-in" | "custom"
  backend: string,
  paneId: string | null,
  sessionId: string | null,   // tmux session name (not copilot session)
  requestedAt: string,        // ISO 8601
  status: string,             // "pending" | "running" | "interactive" | "success" | "failure" | "timeout" | "cancelled"
  summary: string | null,
  exitCode: number | null,
  metadataVersion: 2,         // bumped from 1

  // new fields
  copilotSessionId: string | null, // UUID for copilot --resume; null for cmux backend
  interactive: boolean,       // true if launched with -i
  fork: {                     // present if forked
    parentCopilotSessionId: string,
    parentLaunchId: string | null,
  } | null,
  closePaneOnCompletion: boolean,
  eventsBaseline: number | null, // event count at launch/resume time, for delta summary extraction
}
```

**Rationale**: Clean break to v2 — no backward compatibility needed (no existing users). New fields track session identity and fork lineage for resume/fork operations.

**Atomic writes**: ALL manifest writes (create, update, merge) MUST use the temp+rename pattern: `fs.writeFileSync(path + '.tmp.' + process.pid, data)` then `fs.renameSync(tmpPath, path)`. This prevents concurrent readers from seeing truncated JSON. `rename()` is atomic on the same filesystem (POSIX guarantee, confirmed by learning test).

**Test file**: `test/state-store.test.mjs` (update existing)

**Acceptance criteria**:
- `metadataVersion: 2` in all new manifests
- New fields serialize/deserialize correctly via JSON round-trip
- Existing `createLaunchRecord()` updated to produce v2-shaped records (do NOT create a separate `createManifestV2()` function — AC references below use this name as shorthand for the updated factory)

---

#### `sessionLock` (Wave 2) — New `lib/session-lock.mjs`

Per-`copilotSessionId` lockfile preventing concurrent access (TOCTOU races).

```javascript
// acquireLock({ copilotSessionId, services? }) → { release: () => void }
//   - Creates .copilot-interactive-subagents/locks/<copilotSessionId>.lock
//   - Uses O_CREAT | O_EXCL for atomic creation
//   - Lockfile contents: JSON { pid: number, startedAt: number } (for stale detection)
//   - If lock file exists:
//     1. Read contents, check if owner PID is still alive (process.kill(pid, 0))
//     2. If owner is dead → stale lock → delete and retry acquire
//     3. If owner is alive → throw SESSION_ACTIVE
//   - Registers process.on("exit") cleanup as SAFETY NET ONLY
//     (SIGKILL/hard crash WILL leave stale locks — that's why PID-based recovery exists)
//   - release() removes lockfile — idempotent (no error if already released)
//   - There is NO separate releaseLock export — caller uses the returned release function
```

**Rationale**: Without locking, two concurrent resume calls could both pass the "is session active?" check and create two panes for the same session, corrupting events.jsonl. Stale lock recovery via PID check handles the SIGKILL/crash case (confirmed by learning test: `process.on("exit")` does NOT fire on SIGKILL).

**Test file**: `test/unit/session-lock.test.mjs` (new)

**Acceptance criteria**:
- First `acquireLock()` succeeds, second throws `SESSION_ACTIVE`
- `release()` allows subsequent `acquireLock()` to succeed
- Stale lock (PID dead) is automatically recovered — acquire succeeds
- Lockfile contains `{ pid, startedAt }` JSON
- Lock directory created automatically if missing
- Process exit cleanup removes lockfile (graceful shutdown only — SIGKILL leaves stale lock, which is recovered by PID check)

---

#### `closePane` (Wave 2) — New `lib/close-pane.mjs`

Closes a multiplexer pane by backend type.

```javascript
// closePane({ backend, paneId }) → void
//
// tmux:   spawnSync("tmux", ["kill-pane", "-t", paneId])
// zellij: spawnSync("zellij", ["action", "close-pane"], { env: { ZELLIJ_PANE_ID: paneId } })
//
// Errors: throws on unknown backend, ignores "pane not found" (already gone)
```

**Rationale**: Panes are ephemeral (D1). After autonomous completion, close the pane to prevent sprawl. Session state persists at `~/.copilot/session-state/` regardless.

**Test file**: `test/unit/close-pane.test.mjs` (new)

**Acceptance criteria**:
- Correct shell command for tmux backend
- Correct shell command + env var for zellij backend
- "Pane not found" errors are swallowed (idempotent close)
- Unknown backend throws structured error

---

#### `extractSessionSummary` (Wave 2) — Update `lib/summary.mjs`

Extracts summary from Copilot session state files, with delta support for resume. This is a **new export** that coexists with the existing `extractLaunchSummary` (which reads pane output). The two serve different purposes:

- `extractLaunchSummary` (existing) — reads pane output text, used during sentinel detection
- `extractSessionSummary` (new) — reads session state files (`events.jsonl`), used after sentinel for persistent summary
- `waitForLaunchCompletion` (existing) — orchestrates sentinel polling, unchanged
- `mapExitState` (existing) — maps exit codes to status strings, unchanged

```javascript
extractSessionSummary({ copilotSessionId, sinceEventIndex }) → {
  summary: string | null,
  source: "events.jsonl" | "workspace.yaml" | "fallback",
  lastEventIndex: number     // for delta tracking on subsequent calls
}

// Implementation steps:
// 1. Build path: use resolved Copilot home directory (see invariant 12) + 'session-state/<copilotSessionId>/events.jsonl'
//    NOTE: Do NOT use '~/' — it is not expanded by Node path APIs.
// 2. Parse JSONL tolerantly (ignore truncated trailing lines)
// 3. If sinceEventIndex provided, skip events before that index (delta extraction)
//    sinceEventIndex is a zero-based count of successfully parsed complete events already seen.
//    lastEventIndex is the total count of successfully parsed complete events in the file.
// 4. Find last assistant.message event (after sinceEventIndex if provided)
// 5. Return data.content + current event count as lastEventIndex
// 6. If no new assistant.message found → return summary: null (do NOT reuse old summary)
// 7. Fallback: workspace.yaml — extract top-level `summary:` field via regex (do NOT add a YAML parser dependency)
//    Only used when sinceEventIndex is not set (initial extraction, not delta)
// 8. If session dir doesn't exist or events.jsonl is unreadable → return null gracefully
```

**Rationale**: After resume, we must only extract summary from NEW assistant messages. The manifest records `eventsBaseline` at launch/resume time and passes it as `sinceEventIndex` to avoid returning stale summaries (D7, LT5 confirmed).

**Quiescence concern**: `events.jsonl` is written by copilot while the parent may read it. Since copilot writes complete JSON lines atomically (one `write()` per event), partial lines only occur if copilot crashes mid-write. The tolerant JSONL parser handles this by ignoring unparseable trailing lines. For the **final** summary extraction (in the completion pipeline, after sentinel/signal fires), copilot has already exited — the file is stable. For **mid-session** reads (status checks), partial data is acceptable since these are informational.

**Test file**: `test/unit/summary-extraction.test.mjs` (new)

**Acceptance criteria**:
- Returns last `assistant.message` content from events.jsonl
- Delta mode: only considers events after `sinceEventIndex`
- Returns `null` (not crash) when session dir missing
- Returns `null` (not crash) when events.jsonl is empty
- Handles truncated JSONL (partial trailing line ignored)
- Falls back to workspace.yaml when `sinceEventIndex` not set and no assistant.message found

---

#### `forkSession` (Wave 3) — New `lib/fork-session.mjs`

Copies a parent session directory to create an isolated child with full context.

```javascript
forkSession({ parentCopilotSessionId }) → {
  forkCopilotSessionId: string,  // new UUID
  sessionPath: string,           // path to forked session dir
}

// Implementation steps:
// 1. Generate new UUID via crypto.randomUUID()
// 2. Copy to temp dir first: cp -r <parent>/ <temp>/
// 3. Update workspace.yaml id field in the temp copy
// 4. Rename temp → final path (atomic on same filesystem)
// 5. Return fork UUID and path
//
// On failure: remove temp dir, return structured error
```

**Rationale**: Fork gives a child agent full parent context without mutating the parent (D4, LT2b confirmed: parent had 18 events before/after, fork appended only to its own copy). Temp+rename prevents partial copies on disk-full.

**Test file**: `test/unit/fork-session.test.mjs` (new)

**Acceptance criteria**:
- Fork directory contains copy of parent's events.jsonl
- Fork's workspace.yaml has the NEW UUID as id
- Parent's events.jsonl and workspace.yaml are untouched
- Partial copy cleaned up on disk-full / permission error
- UUID collision with existing session dir is handled

---

#### `subagent_done` Tool (Wave 3) — Update `extension.mjs`

Tool registered in child sessions for explicit completion signaling.

**How it works**: Child copilot sessions launched in tmux panes have a real TTY, which means extensions load and `subagent_done` is registered via `joinSession({ tools })` in the child's extension sidecar.

**IMPORTANT: The extension sidecar is a SEPARATE process from the copilot parent.** `process.exit(0)` in the sidecar kills the sidecar, NOT copilot. The tool is a **durable marker**, not a termination mechanism:

1. Model calls `subagent_done` → tool writes a signal file (`.copilot-interactive-subagents/done/<copilotSessionId>`) and returns a result telling the model the task is complete.
2. The tool's description instructs the model to put its summary in the last assistant message BEFORE calling this tool.
3. **The tool CANNOT force copilot to exit.** After the tool returns, the model may naturally end the conversation — but this is nondeterministic. The tool is one completion signal source, not the only one.
4. **Autonomous mode**: Parent monitors BOTH sentinel wrapper AND signal file. Whichever fires first triggers the completion pipeline. The sentinel (copilot process exit → wrapper writes exit code) is the authoritative source for exit code.
5. **Interactive mode**: Copilot exits when user Ctrl+D's or model concludes. Reconciliation handles terminal transition.
6. **Fallback**: If the model ignores the signal and continues, the parent's monitoring can detect the signal file during status checks and note it, but should NOT force-terminate solely based on the signal file while the pane/process is still alive.

```javascript
// Registered automatically by the extension in any copilot session with a TTY
// (tmux panes provide a TTY, so child subagents get this tool)
{
  name: "subagent_done",
  description: "Call when you have completed your task. Put your final summary in your last message BEFORE calling this tool. Your session will end after this call.",
  parameters: {},  // no parameters needed
  execute: ({ copilotSessionId }) => {
    // copilotSessionId is injected into child env as COPILOT_SUBAGENT_SESSION_ID
    // launchId is injected as COPILOT_SUBAGENT_LAUNCH_ID
    // (both set by the parent's launch command builder)
    const launchId = process.env.COPILOT_SUBAGENT_LAUNCH_ID || "unknown";
    const signalDir = path.join(STATE_DIR, "done");
    fs.mkdirSync(signalDir, { recursive: true });
    fs.writeFileSync(path.join(signalDir, copilotSessionId), `${Date.now()}|${launchId}`);
    return { ok: true, message: "Task marked complete. Session ending." };
    // Model reads this result and may conclude the conversation.
    // Sentinel remains the authoritative completion/exit-code source for autonomous mode.
  }
}
```

**Session ID injection**: The parent's launch command builder MUST set two environment variables in the pane command: (1) `COPILOT_SUBAGENT_SESSION_ID=<copilotSessionId>` and (2) `COPILOT_SUBAGENT_LAUNCH_ID=<launchId>`. The child extension reads these to know which session to write the signal file for and which launch generation it belongs to. (Note: Copilot CLI does not expose its own session ID via env or API — see Scope/Out.)

**Stale signal file cleanup**: On resume, delete any existing signal file for the session BEFORE launching the child. This prevents a stale signal from a prior run triggering immediate false completion. The parent also injects a `COPILOT_SUBAGENT_LAUNCH_ID=<launchId>` env var alongside the session ID. The signal file content includes the launchId so the parent can verify the signal matches the current launch (not a leftover from a prior run that raced with cleanup). Content format: `<timestamp>|<launchId>`.

**Multi-source completion model**: Subagent completion can be detected from multiple independent sources: (1) sentinel wrapper exit code (autonomous mode), (2) signal file from `subagent_done`, (3) pane death/process exit detected by probe, (4) reconciliation discovering terminal manifest + dead pane. The completion pipeline is idempotent — whichever source fires first triggers extract→manifest→close, and subsequent triggers are no-ops (manifest already terminal). This redundancy is intentional; no single source is a SPOF.

**Rationale**: Provides an explicit "I'm done" signal for both autonomous and interactive sessions (D10). The signal file provides a durable marker that survives pane/process death. The tool description is the primary mechanism — it instructs the model to conclude. **The tool is a hint, not a guarantee** — the sentinel wrapper and pane monitoring remain the authoritative completion sources. Works because tmux panes provide a real TTY, and copilot forks extension sidecars when it detects a TTY (see Validated Assumptions).

**Test file**: `test/unit/subagent-done.test.mjs` (new)

**Acceptance criteria**:
- Tool is registered with correct name and empty parameters
- Calling execute writes signal file to `.copilot-interactive-subagents/done/<copilotSessionId>` with content `<timestamp>|<launchId>`
- Execute returns `{ ok: true, message: "..." }` — does NOT call process.exit()
- Tool reads COPILOT_SUBAGENT_SESSION_ID and COPILOT_SUBAGENT_LAUNCH_ID from env
- Tool description instructs agent to put summary in last message before calling
- Signal file is detectable by parent's monitoring/status checks
- Stale signal files from prior runs are cleaned up on resume (before child launch)

---

#### Resume Flow (Wave 4) — Update `lib/resume.mjs`

Replaces legacy pane-reattach with new-pane + `--resume=<copilotSessionId>`.

```javascript
// Request
{
  launchId: string,           // identifies which launch manifest to resume
  task: string | undefined,   // optional follow-up prompt
  awaitCompletion: boolean,   // default: false
}

// Response (success — fire-and-forget, awaitCompletion: false)
{
  launchId: string,
  copilotSessionId: string,
  backend: string,
  paneId: string,             // NEW pane
  status: "interactive",
  resumePointer: { launchId, copilotSessionId, backend, paneId }
}

// Response (success — awaited, awaitCompletion: true)
{
  launchId: string,
  copilotSessionId: string,
  backend: string,
  paneId: string | null,      // null if pane closed on completion
  status: "success" | "failure" | "timeout",
  exitCode: number | null,
  summary: string | null,
  resumePointer: { launchId, copilotSessionId, backend, paneId: null }
}

// Response (error)
{
  ok: false,
  code: "SESSION_ACTIVE",
  message: "Session is currently active in another pane. Close or wait for completion before resuming."
}
```

**Implementation flow**:
1. Read manifest → get `copilotSessionId`
2. Acquire sessionLock (reject with `SESSION_ACTIVE` if held — includes stale lock recovery via PID check)
3. Verify session is quiescent (pane gone or process exited)
4. Record `eventsBaseline` (current event count for delta summary) — **MUST capture BEFORE launching child** to avoid missing early events
5. Clean up stale signal file: delete `.copilot-interactive-subagents/done/<copilotSessionId>` if exists (prevents false completion from prior run)
6. Open new pane via backend
7. If `task`: send `copilot --resume=<copilotSessionId> -i "task"` (safe transport)
8. If no `task`: send `copilot --resume=<copilotSessionId>` (bare `--resume` — copilot defaults to interactive. **Do NOT use bare `-i` without a prompt** — it fails with "argument missing".)
9. Update manifest (status: "interactive", new paneId, eventsBaseline)
10. Release lock (pane is now running — lock held only during setup)
11. If `awaitCompletion`: monitor pane for process exit (polling, no lock held). On exit: re-acquire lock → extract summary → transition manifest to terminal → release lock → return awaited response. This two-phase locking prevents blocking other status queries during the (potentially long) copilot execution.
12. If fire-and-forget: return pane metadata immediately

**Architecture note**: This is a **full replacement** of the current pane-reattach model in `lib/resume.mjs`, not a patch. Current resume validates existing paneId and reattaches. New resume creates a NEW pane and uses `copilot --resume` to restore context. The old code path is removed.

**Rationale**: Sessions are the persistence layer, not panes (D5). Old pane was already closed (D1). Resume creates a fresh pane and restores full conversation context via `--resume` (LT3 confirmed).

**Test file**: `test/resume.test.mjs` (update existing)

**Acceptance criteria**:
- New pane created (not reattached to old one) — this is a full replacement of legacy reattach
- `--resume=<copilotSessionId>` in launch command
- Prompt-less resume uses bare `--resume` (no `-i` flag) — NOT `--resume -i`
- Resume with task uses `--resume=<id> -i "task"`
- `SESSION_ACTIVE` error when session is still running (including stale lock recovery)
- `eventsBaseline` recorded in manifest BEFORE child launch for accurate delta summary
- Stale signal file cleaned up before child launch
- Lock acquired before pane creation, released after

---

#### Launch Parameters (Tool Schema)

New parameters added to the `copilot_subagent_launch` tool alongside existing ones:

```javascript
{
  // existing
  agentIdentifier: string,    // "github-copilot" or custom agent name
  task: string,               // prompt text
  backend: "tmux" | "zellij", // optional, auto-detected
  awaitCompletion: boolean,   // default: true for autonomous, false for interactive

  // new in v1
  interactive: boolean,       // default: false. true = -i flag, stay alive
  fork: {                     // optional — fork from an existing session
    launchId: string,         // look up copilotSessionId from this launch manifest
  } | {
    copilotSessionId: string, // fork directly from a known copilot session UUID
  } | undefined,
  closePaneOnCompletion: boolean, // default: true for autonomous, false for interactive
}

// Note: fork from the *current parent* session is not supported in v1 because
// Copilot CLI does not expose its own session ID via environment variable or API.
```

## Consolidated Error Codes

All structured errors use the envelope `{ ok: false, code: "<ERROR_CODE>", message: "<user-facing>" }`. This matches the existing codebase pattern (`INVALID_ARGUMENT`, `LAUNCH_NOT_FOUND`, etc.).

| Error Code | Returned By | Condition | User-Facing Message |
|-----------|------------|-----------|---------------------|
| `SESSION_ACTIVE` | resume, fork | Session has an active copilot process | "Session is currently active in another pane. Close or wait for completion before resuming." |
| `LAUNCH_NOT_FOUND` | resume, fork | No manifest found for launchId | "No launch record found for this ID." |
| `FORK_FAILED` | fork | Disk full, permissions, or copy error | "Failed to fork session: {reason}. No partial files left." |
| `BACKEND_UNAVAILABLE` | launch, resume | Requested backend not detected | "Backend '{name}' is not available." |
| `INVALID_FORK_TARGET` | launch | Fork parameter shape invalid | "Fork requires { launchId } or { copilotSessionId }." |
| `PANE_OPEN_FAILED` | launch, resume | Backend refused to create pane | "Failed to open pane: {reason}." |
| `RESUME_NOT_SUPPORTED` | resume | Manifest has `copilotSessionId: null` (cmux launch) | "This launch does not support resume (no session ID)." |

## What Changes

### New Artifacts
- `specs/decisions/interactive-subagents-v1-decisions.md` — locked decisions
- `specs/subagents/interactive-subagents-v1.md` — this spec
- New injectable service: `closePane` (tmux + zellij)
- New injectable service: `extractSessionSummary` (with delta support)
- New injectable service: `forkSession`
- New injectable service: `sessionLock` (per-copilotSessionId lockfile management)
- New tool: `subagent_done` (registered in child sessions for explicit completion)
- Lock directory: `.copilot-interactive-subagents/locks/` (workspace-local — same directory as launches. **Design note**: If multiple Copilot parent sessions share the same working directory, locks are naturally shared. If each parent uses a separate working directory, locks are implicitly per-parent. This is the simpler model and correct for v1. A user-global lock directory could be considered in v2 if cross-workspace coordination becomes needed.)

### Updated Artifacts
- `extension.mjs` — launch command builder (add `--resume`, `-i`/`-p` selection), pane lifecycle (add closePane after completion), backend preference (zellij first)
- `lib/state.mjs` — manifest schema v2 (new fields, version bump, v1 defaults)
- `lib/state-index.mjs` — metadata propagation for new manifest fields. **CRITICAL**: The launch index (`launch-index.json`) must use atomic writes (temp+rename) AND a single-writer mutex to prevent lost-update races during parallel launches. Without this, parallel launches A and B can both read the index, each add their entry, and overwrite each other. Options: (a) per-launch shard files instead of a single index, (b) file lock (flock/O_EXCL) around read-modify-write, (c) append-only JSONL index.
- `lib/launch.mjs` — integrate closePane, session ID generation, fork
- `lib/resume.mjs` — new resume flow (new pane + `--resume=<copilotSessionId>`, error responses)
- `lib/summary.mjs` — add session-file-based summary extraction alongside sentinel
- `lib/mux.mjs` — backend preference ordering (zellij first when both available)
- `lib/parallel.mjs` — pass new v1 params (`interactive`, `fork`, `closePaneOnCompletion`) through to individual launches; update result/status shape for v2 manifest. `copilot_subagent_parallel` delegates to `copilot_subagent_launch` for each agent — it does not implement its own launch logic.
- Tool parameter schemas — add `interactive`, `fork`, `closePaneOnCompletion` to launch; update resume contract
- `README.md` / `docs/skills-integration.md` — document new parameters and behavior
- Tests hardcoding `metadataVersion: 1` — update to v2 (`state-store`, `resume`, `single-launch`, `tool-interface`)

### Workflow / Operational Changes
- Subagent panes no longer persist after completion (default)
- `copilot_subagent_resume` creates new panes instead of re-attaching to old ones
- Users can interact directly in subagent panes when `interactive: true`
- Fork enables context-aware subagent spawning

### Test Structure Changes
- Reorganize `test/` into `test/unit/`, `test/integration/`, `test/e2e/`
- Add `test/helpers/fixtures.mjs` with shared factories for v2 manifests, session dirs, events.jsonl
- Add `test:unit`, `test:integration`, `test:e2e` scripts to `package.json`
- Add new service test files: `close-pane`, `fork-session`, `summary-extraction`, `session-lock`, `subagent-done`, `launch-command`
- Add v1 modules to CRAP/mutation quality targets in `scripts/quality/targets.mjs`
- Add e2e test harness with real copilot CLI + tmux/zellij sessions

## Lifecycle Guards

Before resume, fork, or summary extraction, the session must be **quiescent** (no active copilot process writing to it). Enforcement rules:

| Operation | Guard | Failure Response |
|-----------|-------|-----------------|
| Resume | Acquire lock + verify no active copilot process | `SESSION_ACTIVE` error |
| Fork | Acquire lock + verify parent is quiescent | `SESSION_ACTIVE` error with "wait for parent to complete" |
| Multiple resumes | Only one resume at a time per `copilotSessionId` — enforced by lock | `SESSION_ACTIVE` error |
| Close pane during extraction | Extraction must complete before closePane is called | Enforced by sequencing (extract → manifest → close) |
| Fork during parent writes | Parent pane must be closed or copilot process exited | `SESSION_ACTIVE` error |

**Locking:** Operations that **mutate** session state (resume, fork, terminal manifest transition including the completion pipeline) must acquire a per-`copilotSessionId` lockfile before proceeding. Pure read-only operations (summary extraction that only returns data without updating manifest) are exempt. The lockfile lives at `.copilot-interactive-subagents/locks/<copilotSessionId>.lock`. Contains `{ pid, startedAt }` for stale recovery. Use atomic `O_CREAT | O_EXCL` creation; release on operation completion. Stale locks (owner PID dead) are automatically recovered on next acquire attempt. This prevents TOCTOU races where two concurrent resume/fork calls both pass quiescence checks.

**Detection method:** After acquiring the lock, check manifest `status`. If `"running"`, `"interactive"`, `"timeout"`, or `"cancelled"`, verify the `paneId` still exists and has an active copilot process. If pane is gone or process exited, update manifest to a terminal state (`"success"` if exit code 0, `"failure"` otherwise) and attempt best-effort summary extraction. Sessions in `"timeout"` or `"cancelled"` status must also be verified as quiescent — the child copilot may still be running.

**Probe service contract** — new injectable: `probeSessionLiveness(manifest) → { alive: boolean, exitCode: number | null }`:
1. Check pane exists: `tmux display-message -p -t <paneId> "#{pane_id}"` (returns pane ID if exists, errors if not). For zellij: use `zellij action list-clients` or equivalent with `--pane-id`. If pane gone → `{ alive: false, exitCode: null }`.
2. If pane exists, check for copilot process: `tmux list-panes -t <paneId> -F "#{pane_current_command}"`. Note: with the sentinel wrapper, command may show `node` not `copilot`. Check for the node sentinel process specifically, or verify pane has an active foreground process.
3. If copilot process is running → `{ alive: true, exitCode: null }`.
4. Exit code is `null` when probing (no reliable way to get it from a dead tmux process). For autonomous mode, exit code comes from the sentinel (`__SUBAGENT_DONE_<code>__`). For interactive mode, exit code is always `null` — terminal status is `"success"` if events.jsonl has content, `"failure"` otherwise.

This service is used by lifecycle guards and `awaitCompletion` polling. Implementation lives in `lib/mux.mjs` (backend-specific) with a backend-agnostic wrapper in `lib/launch.mjs`.

**Stale manifest reconciliation:** Before any operation that checks manifest status, reconcile stale states. If status is non-terminal but the pane no longer exists or the copilot process has exited, transition the manifest to a terminal state and attempt best-effort summary extraction. **Also reconcile terminal manifests with live panes**: if status is terminal ("success", "failure", etc.) but the pane still exists with an active process, this indicates a crash between manifest update and pane close — close the pane now. This prevents orphaned `"running"` manifests from blocking future operations and stale panes from persisting.

## Timeout / Cancellation / Stalled Launch

Autonomous launches can fail to produce a sentinel. These are the terminal failure paths:

| Scenario | Detection | Manifest Status | Pane | Session |
|----------|-----------|----------------|------|---------|
| Sentinel received normally | `__SUBAGENT_DONE_<code>__` in pane output | `success` / `failure` (by exit code) | Closed | Preserved for resume |
| Pane disappeared before sentinel | Pane existence check fails during poll | `failure` (exitCode: null) | Already gone | Best-effort summary extraction |
| Tool timeout (90s default) fires | Outer tool timeout handler | `timeout` | Left alive — child copilot may still be running | Preserved; resume is valid |
| Parent abort / cancellation | AbortSignal from SDK | `cancelled` | Closed (best-effort kill) | Preserved; resume is valid |
| Output capture fails during poll | Read error from backend | Continue polling; if persistent, treat as pane-disappeared | — | — |

**On tool timeout:** The child copilot process is **not killed** — it may still be doing useful work. The manifest records `timeout` status. The session remains valid for later resume. The pane stays alive so the user can observe or interact. **CRITICAL**: The timeout MUST cancel the background monitoring (sentinel polling, signal file watching, pane liveness checks). Thread an `AbortSignal` through the launch/wait logic. When `withToolTimeout()` fires: (1) signal abort to stop all polling loops, (2) update manifest to `timeout`, (3) return TOOL_TIMEOUT result. Without this, the background monitoring continues indefinitely after timeout, potentially closing the pane later when the sentinel fires — violating the "pane stays alive on timeout" contract.

**On cancellation:** Best-effort pane close. If the pane can't be closed (already gone), that's fine. Manifest records `cancelled`. Session remains valid for resume.

**Polling interval**: Sentinel polling and pane liveness checks should use a base interval (e.g., 500ms) with ±20% jitter to prevent thundering herd when multiple subagents are launched in parallel. `const delay = base * (0.8 + Math.random() * 0.4)`. This is an implementation advisory, not a behavioral requirement.

**Interactive mode timeout:** Interactive launches have no sentinel and no tool-level timeout (they return immediately). The terminal events are: (a) user exiting copilot (Ctrl+D), (b) `subagent_done` tool writing signal file + model naturally concluding, or (c) copilot crashing. Status transitions from `"interactive"` to a terminal state happen during stale manifest reconciliation (see above) or when the signal file is detected. **Exit code for interactive sessions is always `null`** — there is no sentinel wrapper to capture it. Terminal status is determined by best-effort heuristic: if signal file exists OR `events.jsonl` contains at least one assistant message, status is `"success"`; otherwise `"failure"`.

## Failure Modes / Risks

- **Session directory copy fails** (disk full, permissions): Fork should fail gracefully with a structured error. Do not leave partial copies — use temp directory + rename pattern.
- **Pane close races with output capture**: Ensure summary extraction completes before `closePane`. Sequence: extract → update manifest → close pane.
- **Copilot CLI session format changes**: The spec depends on `events.jsonl` structure and `workspace.yaml` fields. Changes in Copilot CLI versions could break summary extraction. Mitigate with fallback summary sources and graceful degradation (return `null` summary, not crash).
- **UUID collision**: Astronomically unlikely with `crypto.randomUUID()` but guard against existing directory when generating fork UUIDs.
- **Interactive session resource usage**: Long-running interactive sessions consume memory. This is acceptable — the user is actively working. No automatic timeout for interactive sessions.
- **Backend parity gaps**: zellij `dump-screen` and tmux `capture-pane` have different output formats. Existing extension code handles this; verify new features maintain parity.
- **Manifest schema**: v2 is a clean break. All manifests use v2 fields (`copilotSessionId`, `interactive`, `fork`, `eventsBaseline`). No v1 backward compatibility needed — there are no existing users.
- **Concurrent resume attempts**: Rejected with `SESSION_ACTIVE` error (see Lifecycle Guards).
- **Startup failure** (pane opens but copilot fails to start): If sentinel wrapper detects immediate non-zero exit, manifest transitions to `failure` with the exit code. If command send itself fails (backend error), close the pane, set manifest to `failure`, and return structured error. No orphan panes or stuck manifests.
- **Truncated events.jsonl**: Copilot may not fully flush on crash/kill. Summary extraction must use tolerant JSONL parsing — ignore trailing partial lines and missing `session.shutdown` events. Return best-effort summary from whatever valid events exist.
- **Fork from current parent session**: Not supported in v1 — Copilot CLI does not expose its own session ID via environment variable or API. Fork requires an explicit `launchId` or `copilotSessionId`. Attempting to fork without one returns a structured error.
- **Stalled autonomous launch**: Pane disappears or sentinel never arrives — handled by timeout/cancellation table above. Manifest always reaches a terminal state.
- **Resume with no new output**: If user opens a resumed session and exits without generating a new assistant message, summary extraction returns `null` (delta tracking via `eventsBaseline` prevents reusing stale summary).
- **Unsafe task content**: Multiline prompts, shell metacharacters, or quotes in task strings — mitigated by mandatory safe transport (base64 env var pattern inherited from current implementation). Never interpolate task content directly into shell commands.

## Testing Strategy

### Test Infrastructure Improvements

**Split test categories** — add separate npm scripts for fast feedback loops:
```json
{
  "test": "node --test test/*.test.mjs test/unit/*.test.mjs test/integration/*.test.mjs",
  "test:unit": "node --test test/unit/*.test.mjs",
  "test:integration": "node --test test/integration/*.test.mjs",
  "test:e2e": "node --test test/e2e/*.test.mjs",
  "test:coverage": "c8 --reporter=text --reporter=json-summary node --test test/*.test.mjs test/unit/*.test.mjs",
  "test:crap": "node scripts/test-crap.mjs",
  "test:mutation": "node scripts/test-mutation.mjs"
}
```

**Note**: Existing tests live at `test/*.test.mjs` (flat). New v1 tests go in `test/unit/`. The `test` script must include BOTH globs so existing tests keep running. Existing tests stay where they are — do NOT move them.

Coding agents run `test:unit` during development (~1s), `test` before committing (~3s), `test:e2e` for validation (~30-60s). Directory structure:
```
test/
├── unit/               # Pure logic, mocked backends, fast
├── integration/        # Multi-layer, still mocked backends
├── e2e/                # Real copilot CLI + real tmux/zellij
└── helpers/
    ├── red-harness.mjs # Existing module import utility
    └── fixtures.mjs    # NEW: shared factories for v2 concepts
```

**Shared fixture factories** (`test/helpers/fixtures.mjs`) — prevent agents from re-inventing test data:
```javascript
export function createSessionDir(t, { copilotSessionId, events }) → tmpdir with events.jsonl + workspace.yaml
export function createEventsJsonl(events) → JSONL string from event objects
export function createManifestV2(overrides) → complete v2 manifest with sensible defaults
export function createLockfile(copilotSessionId) → lockfile path in temp dir
```

**Quality gates** — all new v1 modules must be added to CRAP and mutation targets in `scripts/quality/targets.mjs` when created. No exceptions.

### One Test File Per Service

Each new injectable service gets its own unit test file. This gives coding agents precise failure signals — when `fork-session.test.mjs` fails, the agent knows exactly what broke without reading 1,000+ lines of orchestration tests.

| Service | Test File | Focus |
|---------|-----------|-------|
| `closePane` | `test/unit/close-pane.test.mjs` | Backend command correctness (tmux/zellij), error handling |
| `forkSession` | `test/unit/fork-session.test.mjs` | Dir copy, yaml update, cleanup on failure, parent untouched |
| `extractSessionSummary` | `test/unit/summary-extraction.test.mjs` | Delta extraction, fallback, tolerant parsing, missing dir |
| `sessionLock` | `test/unit/session-lock.test.mjs` | Acquire/release, contention, cleanup on crash |
| `subagent_done` | `test/unit/subagent-done.test.mjs` | Tool registration, clean exit trigger |
| Launch command builder | `test/unit/launch-command.test.mjs` | `-i`/`-p` selection, `--resume`, safe transport, flag preservation |

Existing orchestration tests (`single-launch`, `resume`, `parallel-launch`) remain for multi-layer integration coverage.

### Error Path Convention

Every test file includes a `describe("error handling", ...)` block covering failure modes:

```javascript
describe("error handling", () => {
  it("GIVEN disk full WHEN forking session THEN cleans up partial copy and returns structured error", ...);
  it("GIVEN pane disappeared WHEN polling for sentinel THEN transitions manifest to failure", ...);
  it("GIVEN lockfile held WHEN second resume attempts THEN returns SESSION_ACTIVE error", ...);
  it("GIVEN truncated events.jsonl WHEN extracting summary THEN ignores partial line", ...);
});
```

### Unit Tests

- **Launch command builder**: `-i` vs `-p` flag selection, `--resume=<UUID>` always present, existing flags preserved, safe transport (base64 env var round-trip), shell metacharacter survival
- **Fork service**: Copy creates new directory, updates workspace.yaml id, preserves events.jsonl, original unmodified, partial copy cleanup on failure
- **Close pane service**: Correct backend command (tmux vs zellij), error on unknown backend
- **Summary extraction**: Last `assistant.message` from events.jsonl, workspace.yaml fallback, null on missing dir, delta mode (sinceEventIndex), null when no new messages, tolerant JSONL parsing (truncated trailing line)
- **Session lock**: Acquire/release lifecycle, concurrent acquire rejected, cleanup on process exit
- **Manifest v2**: New fields serialize/deserialize correctly (including `eventsBaseline`), `createManifestV2` factory produces valid records
- **Resume flow**: New pane created, `--resume=<copilotSessionId>` launched, `SESSION_ACTIVE` on active session, `eventsBaseline` recorded
- **Backend preference**: Zellij selected when both available
- **Interactive mode**: `awaitCompletion` defaults false, no sentinel wrapper, status = "interactive". If `interactive: true` AND `awaitCompletion: true` both specified, the call waits for the interactive session to end (via child exiting or `subagent_done`) — this is a valid combination for "launch interactive, then block until done." The only invalid combination is `interactive: true` with `closePaneOnCompletion: true` (pane must stay open for interactive use).
- **closePaneOnCompletion: false**: Pane preserved after autonomous completion
- **cmux passthrough**: Interactive/fork params ignored with warning
- **Stale manifest reconciliation**: `running` with dead pane → terminal state
- **Timeout/cancellation**: Correct manifest status, pane behavior per timeout table
- **Fork parameter validation**: `{ launchId }` resolves, `{ copilotSessionId }` used directly, invalid shapes rejected
- **subagent_done tool**: Registered in child session, triggers clean exit, last assistant message becomes summary

### End-to-End Tests

E2E tests validate the full extension with **real Copilot CLI sessions** and **real multiplexer panes**. These are the definitive proof that the extension works — coding agents must run these as part of their development feedback loop.

**Prerequisites**: `copilot` CLI available, at least one of tmux/zellij installed.

**Critical constraint**: Extension tools only load when copilot has a real TTY. Tmux panes provide a PTY, so copilot launched in a tmux pane gets extensions. Piped invocations do NOT. See Validated Assumptions.

**Harness design** (4 phases):

```
1. SETUP
   ├── Copy updated extension to ~/.copilot/extensions/copilot-interactive-subagents/
   ├── Create isolated tmux session: tmux new-session -d -s "e2e-test-<UUID>"
   └── Prepare test prompt that exercises extension tools

2. EXECUTE
   ├── Launch copilot in the tmux pane (TTY required for extensions):
   │   tmux send-keys -t "e2e-test-<UUID>" \
   │     'copilot -i "<test-prompt>" --allow-all-tools --allow-all-paths --allow-all-urls --model <cheap-model> --no-ask-user' Enter
   ├── Extensions load automatically (TTY-dependent, not mode-dependent)
   ├── Test prompt instructs copilot to call extension tools (launch, resume, etc.)
   └── Poll for completion: tmux capture-pane + grep for done marker

3. VERIFY (primary oracles — NOT screen text)
   ├── Launch manifest exists at .copilot-interactive-subagents/launches/<launchId>.json
   ├── Manifest fields: copilotSessionId, status, metadataVersion: 2
   ├── Session state dir exists: ~/.copilot/session-state/<UUID>/
   ├── events.jsonl contains expected event sequence
   ├── Pane lifecycle correct (created, closed per closePaneOnCompletion)
   └── Summary extracted matches last assistant.message in events.jsonl

4. CLEANUP
   ├── tmux kill-session -t "e2e-test-<UUID>"
   └── Remove test workspace and session state artifacts
```

**Primary verification oracles** (ranked by reliability):
1. **Launch manifest JSON** — structured, deterministic, machine-readable
2. **Session state files** — events.jsonl, workspace.yaml
3. **Tmux pane existence** — `tmux list-panes` for lifecycle checks
4. **Tmux capture-pane text** — last resort for liveness/debugging only (brittle)

**E2E test cases** (`test/e2e/`):

| Test | Validates |
|------|-----------|
| Autonomous launch + completion | Pane created → sentinel detected → pane closed → session persists → summary extracted |
| Interactive launch | Pane created → status "interactive" → pane stays alive → copilot process running |
| Resume completed session | New pane opens → `--resume=<UUID>` → full context restored (verify via events.jsonl) |
| Fork + launch | Parent session copied → child has new UUID → parent events.jsonl untouched |
| Parallel launch (2 agents) | Two panes created → both complete → both manifests in terminal state |
| Backend: tmux | Full flow on tmux backend |
| Backend: zellij | Full flow on zellij backend (**conditional** — skip if zellij not installed; zellij is opt-in, not default) |

**E2E execution rules for coding agents:**
- Run `test:e2e` after any change to launch command builder, pane lifecycle, resume flow, or fork service
- E2E failures are blocking — do not commit if e2e fails
- E2E tests use isolated tmux/zellij sessions — never touch the user's active session
- Timeout: 60s per test (copilot sessions are real and take time)
- Skip gracefully if copilot CLI or multiplexer is not available (CI without tmux)
- **Do NOT use `extensions_reload`** — it kills extension sidecars permanently. Deploy extension changes to `~/.copilot/extensions/` and start a fresh copilot session in a new tmux pane instead.

### Cross-Service Scenario Matrix

These scenarios span multiple services and validate their integration. Each row is a test case for integration or e2e tests.

| Scenario | Services Involved | Expected Outcome |
|----------|-------------------|------------------|
| Autonomous launch → completion → close → resume | launch, closePane, extractSessionSummary, resume, sessionLock | Pane opens → sentinel detected → summary extracted → pane closed → resume opens new pane → context restored |
| Interactive launch → user exit → resume with task | launch, resume, sessionLock | Pane opens (no sentinel) → user Ctrl+D → resume with follow-up prompt → new pane with full context |
| Fork → autonomous child → summary | forkSession, launch, extractSessionSummary, sessionLock | Parent copied → child launches → completes → summary from child only → parent events.jsonl unchanged |
| Concurrent resume rejected | resume, sessionLock | First resume acquires lock → second resume gets `SESSION_ACTIVE` → first completes → second retry succeeds |
| Launch with `closePaneOnCompletion: false` | launch, extractSessionSummary | Sentinel detected → summary extracted → pane NOT closed → manifest terminal |
| Stale manifest reconciliation | launch, resume | Launch completed but manifest stuck as "running" → resume detects dead pane → reconciles to terminal → resume succeeds |
| Pane disappears mid-autonomous | launch, extractSessionSummary | Pane existence check fails during poll → manifest → "failure" → best-effort summary extraction |
| Timeout → later resume | launch, resume, sessionLock | Tool timeout fires → manifest "timeout" → pane stays alive → later resume creates new pane |
| `subagent_done` → clean exit | subagent_done, extractSessionSummary | Child calls tool → signal file written → model may end conversation → sentinel detects copilot exit → last assistant message = summary |

## Golden Path Examples

### Example 1: Autonomous Launch (most common)

```
Parent agent calls copilot_subagent_launch({
  agentIdentifier: "github-copilot",
  task: "Write unit tests for the auth module",
  backend: "tmux"
})

→ Extension generates copilotSessionId: "a1b2c3d4-..."
→ Opens tmux pane, sends: node -e '...' (sentinel wrapper)
   → Inside wrapper: COPILOT_SUBAGENT_TASK_B64=<base64> copilot -p "$(echo $COPILOT_SUBAGENT_TASK_B64 | base64 -d)" --resume=a1b2c3d4-... --allow-all-tools -s
   (task content transported via base64 env var — never raw interpolation)
→ Writes manifest: { status: "running", copilotSessionId: "a1b2c3d4-...", ... }
→ Polls pane output for __SUBAGENT_DONE_<code>__
→ Sentinel found: __SUBAGENT_DONE_0__
→ Reads ~/.copilot/session-state/a1b2c3d4-.../events.jsonl
   → Last assistant.message: "I've created 5 unit tests in test/auth.test.js..."
→ Updates manifest: { status: "success", summary: "I've created 5 unit tests...", exitCode: 0 }
→ Closes tmux pane (kill-pane)
→ Returns: { launchId: "xyz", status: "success", summary: "I've created 5 unit tests...",
             resumePointer: { launchId: "xyz", copilotSessionId: "a1b2c3d4-..." } }
```

### Example 2: Fork + Interactive Resume

```
Parent agent calls copilot_subagent_launch({
  agentIdentifier: "github-copilot",
  task: "Continue improving the auth module with full context from previous work",
  fork: { launchId: "xyz" },       ← fork from Example 1's session
  interactive: true
})

→ Reads manifest "xyz" → copilotSessionId: "a1b2c3d4-..."
→ Acquires lock on "a1b2c3d4-..."
→ Copies ~/.copilot/session-state/a1b2c3d4-.../ → ~/.copilot/session-state/e5f6g7h8-.../
→ Updates workspace.yaml id to "e5f6g7h8-..."
→ Releases lock on "a1b2c3d4-..."
→ Opens tmux pane, sends: COPILOT_SUBAGENT_TASK_B64=<base64> copilot -i "$(echo $COPILOT_SUBAGENT_TASK_B64 | base64 -d)" --resume=e5f6g7h8-... --allow-all-tools
   (no sentinel wrapper — interactive mode; task via safe transport)
→ Writes manifest: { status: "interactive", copilotSessionId: "e5f6g7h8-...",
                      fork: { parentCopilotSessionId: "a1b2c3d4-..." } }
→ Returns immediately: { launchId: "abc", status: "interactive", ... }
→ User works in pane. Original session "a1b2c3d4-..." is untouched.
```
