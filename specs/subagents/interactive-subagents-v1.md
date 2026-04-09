# Interactive Subagents v1

Persistent, interactive, and resumable subagent sessions for Copilot CLI in tmux and zellij panes.

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
- Resume of a cmux-launched session falls back to legacy reattach behavior
- No cmux-specific tests are added or removed

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

## Specific Ideas Disposition

| Idea (from pi-interactive-subagents) | Disposition | Notes |
|-------|-------------|-------|
| `closeSurface()` after completion | Preserved | D1 — close pane after autonomous/interactive exit |
| Session file persistence | Adapted | D2 — use Copilot CLI's native session system (`--resume=<UUID>`) instead of pi's raw `.jsonl` files |
| `interactive: true/false` mode | Preserved | D3 — maps to `-i` vs `-p` Copilot CLI flags |
| `fork: true` session forking | Adapted | D4 — directory copy instead of pi's `--fork <file>` flag |
| `subagent_done` tool | Preserved | D10 — child agent calls this to signal completion; last assistant message before call becomes the summary |
| `subagent_resume` tool | Adapted | D5 — uses `copilot --resume` instead of `pi --session <path>` |
| Agent definitions (scout, worker, etc.) | Set Aside | Deferred to v2; `--agent` flag available when needed |
| Session artifacts (write/read) | Set Aside | Deferred to v2 |
| `/plan` command | Set Aside | Already handled by omc design skill |
| `/iterate` command | Adapted | Interactive launch + fork covers this use case |

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

### Data / Control Flow

**Autonomous launch (`interactive: false`, default):**
1. Generate `copilotSessionId` (UUID)
2. Open pane via backend (`tmux split-window` / `zellij action new-pane`)
3. Build launch command: preserve all existing flags from `createDefaultAgentLaunchCommand()` (including `--allow-all-tools`, `--allow-all-paths`, `--allow-all-urls`, `--no-ask-user`, `-s`), and add `--resume=<copilotSessionId>` and `-p "task"`. **Task transport must use the existing safe encoding pattern** (base64 env var or equivalent) — never raw shell interpolation of user-provided task strings.
4. Wrap in node sentinel script, send to pane
5. Write launch manifest (status: "running")
6. Poll `readPaneOutput` for `__SUBAGENT_DONE_<code>__`
7. Extract summary from session state files
8. Update manifest (status: "success"/"failure", summary, exitCode)
9. Close pane (`tmux kill-pane` / `zellij action close-pane`)
10. Return result with `resumePointer`

**Interactive launch (`interactive: true`):**
1. Generate `copilotSessionId` (UUID)
2. Open pane via backend
3. Build launch command: preserve all existing flags, add `--resume=<copilotSessionId>` and `-i "task"` (replace `-p` with `-i`, omit `-s` for interactive). **Same safe transport rules apply** — task content must not be interpolated raw into the shell command.
4. Send to pane directly (no sentinel wrapper)
5. Write launch manifest (status: "interactive")
6. Return immediately with pane metadata and `resumePointer`
7. User works in pane, exits via Ctrl+D
8. On resume or status check: extract summary from session state

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
5. If no `task`: send `copilot --resume=<copilotSessionId> -i` (prompt-less resume; copilot opens with prior context, user types interactively)
6. Record `eventsBaseline` (current event count in session's events.jsonl) for delta summary
7. Update manifest (status: "interactive", paneId: new pane, eventsBaseline)
7. If `awaitCompletion`: monitor for process exit, extract summary
8. If fire-and-forget: return pane metadata immediately

### Integration Points

- **Copilot CLI**: `--resume=<UUID>`, `-i`/`-p` flags, `--allow-all-tools`, `--agent`, `-s`
- **Copilot session state**: `~/.copilot/session-state/<UUID>/` directory structure
- **tmux**: `split-window`, `send-keys`, `capture-pane`, `kill-pane`, `list-panes`
- **zellij**: `action new-pane`, `action write-chars`, `action dump-screen`, `action close-pane`
- **Extension SDK**: `joinSession({ tools })` for tool registration
- **Launch manifest store**: `.copilot-interactive-subagents/launches/<launchId>.json`

### Key Interfaces

**Launch request (new parameters alongside existing):**
```javascript
{
  // existing
  agentIdentifier: string,    // "github-copilot" or custom agent name
  task: string,               // prompt text
  backend: "tmux" | "zellij", // optional, auto-detected
  awaitCompletion: boolean,   // default: true for autonomous, false for interactive

  // new in v1
  interactive: boolean,       // default: false. true = use -i flag, stay alive
  fork: {                     // optional — fork from an existing session
    launchId: string,         // look up copilotSessionId from this launch manifest
  } | {
    copilotSessionId: string, // fork directly from a known copilot session UUID
  } | undefined,
  closePaneOnCompletion: boolean, // default: true. false = keep pane alive
}

// Note: fork from the *current parent* session is not supported in v1 because
// Copilot CLI does not expose its own session ID via environment variable or API.
// The parent must provide a specific launchId or copilotSessionId to fork from.
```

**Launch manifest v2:**
```javascript
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
  copilotSessionId: string,   // UUID for copilot --resume
  interactive: boolean,       // true if launched with -i
  fork: {                     // present if forked
    parentCopilotSessionId: string,
    parentLaunchId: string | null,
  } | null,
  closedPaneOnCompletion: boolean,
  eventsBaseline: number | null, // event count at launch/resume time, for delta summary extraction
}
```

**Resume request (v2 — new contract replacing legacy reattach):**
```javascript
// Request
{
  launchId: string,           // or via resumePointer/resumeReference
  task: string | undefined,   // optional follow-up prompt. If omitted, opens prompt-less interactive session
  awaitCompletion: boolean,   // default: false (resume is interactive by default)
}

// Response (success)
{
  launchId: string,
  copilotSessionId: string,
  backend: string,
  paneId: string,
  status: "interactive",      // always interactive for resumed sessions
  resumePointer: { launchId, copilotSessionId, backend, paneId }
}

// Response (error — session currently active)
{
  launchId: string,
  status: "error",
  error: "SESSION_ACTIVE",
  message: "Session is currently active in another pane. Close or wait for completion before resuming."
}
```

**Close pane service (new injectable):**
```javascript
// tmux
closePane({ backend: "tmux", paneId }) →
  tmux kill-pane -t <paneId>

// zellij
closePane({ backend: "zellij", paneId }) →
  ZELLIJ_PANE_ID=<paneId> zellij action close-pane
```

**Summary extraction (new service):**
```javascript
extractSessionSummary({ copilotSessionId, sinceEventIndex }) → {
  summary: string | null,
  source: "events.jsonl" | "workspace.yaml" | "fallback",
  lastEventIndex: number     // for delta tracking on subsequent calls
}

// Implementation:
// 1. Read ~/.copilot/session-state/<UUID>/events.jsonl
// 2. If sinceEventIndex provided, skip events before that index (delta extraction)
// 3. Find last assistant.message event (after sinceEventIndex if provided)
// 4. Return data.content + current event count as lastEventIndex
// 5. If no new assistant.message found, return summary: null (do NOT reuse old summary)
// 6. Fallback: workspace.yaml summary field (only when sinceEventIndex is not set)
// 7. If session dir doesn't exist or events.jsonl is unreadable, return null gracefully
```

Delta tracking rationale: after resume, we must only extract summary from NEW
assistant messages. The launch/resume manifest records `eventsBaseline` (event count
at launch/resume time) and passes it as `sinceEventIndex` during extraction.

**Fork service (new):**
```javascript
forkSession({ parentCopilotSessionId }) → {
  forkCopilotSessionId: string,  // new UUID
  sessionPath: string,           // path to forked session dir
}

// Implementation:
// 1. Generate new UUID
// 2. cp -r ~/.copilot/session-state/<parent>/ → <fork>/
// 3. Update workspace.yaml id field
// 4. Return fork UUID
```

**`subagent_done` tool (new — registered in child sessions):**
```javascript
// Registered as a Copilot CLI tool available to child agents.
// When the child agent calls this tool, it signals task completion.
// The last assistant message BEFORE this tool call becomes the summary.
{
  name: "subagent_done",
  description: "Call when you have completed your task. Your last assistant message becomes the summary returned to the caller.",
  parameters: {},  // no parameters
  execute: () => {
    // 1. Signal completion (process exits cleanly)
    // 2. Sentinel wrapper detects exit code 0
    // 3. Parent extracts last assistant message as summary
    process.exit(0);
  }
}

// Integration: The subagent_done tool is injected into the child copilot
// session via extension loading. When called, it triggers a clean process
// exit which the sentinel wrapper captures as __SUBAGENT_DONE_0__.
// For interactive sessions, it provides an explicit "I'm done" signal
// instead of relying on the user to Ctrl+D.
```

## What Changes

### New Artifacts
- `specs/decisions/interactive-subagents-v1-decisions.md` — locked decisions
- `specs/subagents/interactive-subagents-v1.md` — this spec
- New injectable service: `closePane` (tmux + zellij)
- New injectable service: `extractSessionSummary` (with delta support)
- New injectable service: `forkSession`
- New injectable service: `sessionLock` (per-copilotSessionId lockfile management)
- New tool: `subagent_done` (registered in child sessions for explicit completion)
- Lock directory: `.copilot-interactive-subagents/locks/`

### Updated Artifacts
- `extension.mjs` — launch command builder (add `--resume`, `-i`/`-p` selection), pane lifecycle (add closePane after completion), backend preference (zellij first)
- `lib/state.mjs` — manifest schema v2 (new fields, version bump, v1 defaults)
- `lib/state-index.mjs` — metadata propagation for new manifest fields
- `lib/launch.mjs` — integrate closePane, session ID generation, fork
- `lib/resume.mjs` — new resume flow (new pane + `--resume=<copilotSessionId>`, error responses)
- `lib/summary.mjs` — add session-file-based summary extraction alongside sentinel
- `lib/mux.mjs` — backend preference ordering (zellij first when both available)
- `lib/parallel.mjs` — launch result/status shape changes for v2 manifest
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

**Locking:** All operations that read/mutate a session (resume, fork, summary extraction, manifest terminal transition) must acquire a per-`copilotSessionId` lockfile before proceeding. The lockfile lives at `.copilot-interactive-subagents/locks/<copilotSessionId>.lock`. Use atomic `O_CREAT | O_EXCL` creation; release on operation completion (or process exit via cleanup handler). This prevents TOCTOU races where two concurrent resume/fork calls both pass quiescence checks.

**Detection method:** After acquiring the lock, check manifest `status`. If `"running"`, `"interactive"`, `"timeout"`, or `"cancelled"`, verify the `paneId` still exists and has an active copilot process. If pane is gone or process exited, update manifest to a terminal state (`"success"` if exit code 0, `"failure"` otherwise) and attempt best-effort summary extraction. Sessions in `"timeout"` or `"cancelled"` status must also be verified as quiescent — the child copilot may still be running.

**Stale manifest reconciliation:** Before any operation that checks manifest status, reconcile stale states. If status is non-terminal but the pane no longer exists or the copilot process has exited, transition the manifest to a terminal state and attempt best-effort summary extraction. This prevents orphaned `"running"` manifests from blocking future operations.

## Autonomous Pane Policy

Autonomous panes (`interactive: false`) are **non-interactive**. User input in an autonomous pane is unsupported and behavior is undefined. The pane exists solely for observation — the user can watch progress but should not type. This simplifies the lifecycle: there is no "user takeover" state transition to handle.

If the user wants to interact with a subagent, they should use `interactive: true` on launch, or resume a completed session.

## Timeout / Cancellation / Stalled Launch

Autonomous launches can fail to produce a sentinel. These are the terminal failure paths:

| Scenario | Detection | Manifest Status | Pane | Session |
|----------|-----------|----------------|------|---------|
| Sentinel received normally | `__SUBAGENT_DONE_<code>__` in pane output | `success` / `failure` (by exit code) | Closed | Preserved for resume |
| Pane disappeared before sentinel | Pane existence check fails during poll | `failure` (exitCode: null) | Already gone | Best-effort summary extraction |
| Tool timeout (90s default) fires | Outer tool timeout handler | `timeout` | Left alive — child copilot may still be running | Preserved; resume is valid |
| Parent abort / cancellation | AbortSignal from SDK | `cancelled` | Closed (best-effort kill) | Preserved; resume is valid |
| Output capture fails during poll | Read error from backend | Continue polling; if persistent, treat as pane-disappeared | — | — |

**On tool timeout:** The child copilot process is **not killed** — it may still be doing useful work. The manifest records `timeout` status. The session remains valid for later resume. The pane stays alive so the user can observe or interact. This matches pi's behavior where abort doesn't destroy the session.

**On cancellation:** Best-effort pane close. If the pane can't be closed (already gone), that's fine. Manifest records `cancelled`. Session remains valid for resume.

**Interactive mode timeout:** Interactive launches have no sentinel and no tool-level timeout (they return immediately). The only terminal event is the user exiting copilot (Ctrl+D). Status transitions from `"interactive"` to a terminal state happen during stale manifest reconciliation (see above).

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
  "test": "node --test test/*.test.mjs",
  "test:unit": "node --test test/unit/*.test.mjs",
  "test:integration": "node --test test/integration/*.test.mjs",
  "test:e2e": "node --test test/e2e/*.test.mjs",
  "test:coverage": "c8 --reporter=text --reporter=json-summary node --test test/*.test.mjs",
  "test:crap": "node scripts/test-crap.mjs",
  "test:mutation": "node scripts/test-mutation.mjs"
}
```

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
- **Interactive mode**: `awaitCompletion` defaults false, no sentinel wrapper, status = "interactive"
- **closePaneOnCompletion: false**: Pane preserved after autonomous completion
- **cmux passthrough**: Interactive/fork params ignored with warning
- **Stale manifest reconciliation**: `running` with dead pane → terminal state
- **Timeout/cancellation**: Correct manifest status, pane behavior per timeout table
- **Fork parameter validation**: `{ launchId }` resolves, `{ copilotSessionId }` used directly, invalid shapes rejected
- **subagent_done tool**: Registered in child session, triggers clean exit, last assistant message becomes summary

### End-to-End Tests

E2E tests validate the full extension with **real Copilot CLI sessions** and **real multiplexer panes**. These are the definitive proof that the extension works — coding agents must run these as part of their development feedback loop.

**Prerequisites**: `copilot` CLI available, at least one of tmux/zellij installed.

**Harness design** (4 phases):

```
1. SETUP
   ├── Create isolated tmux session: tmux new-session -d -s "e2e-test-<UUID>"
   ├── Install extension to temp copilot config dir
   └── Generate pre-assigned copilotSessionId (UUID)

2. EXECUTE
   ├── Run: copilot -p "task" --allow-all-tools -s --resume=<UUID>
   ├── Extension creates subagent pane inside test tmux session
   └── Wait for sentinel / process exit

3. VERIFY
   ├── Launch manifest exists with correct copilotSessionId
   ├── Session state dir exists: ~/.copilot/session-state/<UUID>/
   ├── events.jsonl contains: session.start → user.message → assistant.message
   ├── Manifest status is terminal (success/failure)
   ├── Pane was closed (if closePaneOnCompletion: true)
   └── Summary extracted matches last assistant message

4. CLEANUP
   ├── Kill test tmux session: tmux kill-session -t "e2e-test-<UUID>"
   ├── Remove temp workspace
   └── Optionally remove test session state
```

**E2E test cases** (`test/e2e/`):

| Test | Validates |
|------|-----------|
| Autonomous launch + completion | Pane created → sentinel detected → pane closed → session persists → summary extracted |
| Interactive launch | Pane created → status "interactive" → pane stays alive → copilot process running |
| Resume completed session | New pane opens → `--resume=<UUID>` → full context restored (verify via events.jsonl) |
| Fork + launch | Parent session copied → child has new UUID → parent events.jsonl untouched |
| Parallel launch (2 agents) | Two panes created → both complete → both manifests in terminal state |
| Backend: tmux | Full flow on tmux backend |
| Backend: zellij | Full flow on zellij backend (if available) |

**E2E execution rules for coding agents:**
- Run `test:e2e` after any change to launch command builder, pane lifecycle, resume flow, or fork service
- E2E failures are blocking — do not commit if e2e fails
- E2E tests use isolated tmux/zellij sessions — never touch the user's active session
- Timeout: 60s per test (copilot sessions are real and take time)
- Skip gracefully if copilot CLI or multiplexer is not available (CI without tmux)

## Validation Lenses

| Lens | Status | Notes |
|------|--------|-------|
| product-fit | ✅ Pass | Solves pane sprawl, session loss, and collaboration gap. No scope creep — agent definitions and session artifacts explicitly deferred. |
| architecture-fit | ✅ Pass | Uses existing injectable service pattern, manifest store, backend abstraction. cmux compatibility explicitly defined. All existing flags preserved. |
| operability | ✅ Pass | Lifecycle guards with lockfile prevent concurrent access. Fork uses temp+rename for atomicity. Summary extraction degrades gracefully. `subagent_done` tool provides explicit completion signal. |
| traceability | ✅ Pass | Every decision (D1–D10) traced to source tags. Shared key `interactive-subagents-v1` links spec → decisions → exploration. |
| change-impact | ✅ Pass | All impacted files enumerated including lib/mux.mjs, lib/parallel.mjs, lib/state-index.mjs, and affected test files. cmux degradation path defined. Resume contract fully specified with error responses. |
