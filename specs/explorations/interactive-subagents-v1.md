# Interactive Subagents v1 — Exploration

> **Superseded by:** `specs/decisions/interactive-subagents-v1-decisions.md` (locked decisions) and `specs/extensions/interactive-subagents-v1.md` (formal spec). This exploration is retained as historical context. Where this document conflicts with decisions or spec, the spec is authoritative.

## Context

The current `copilot-interactive-subagents` extension launches subagents in tmux panes using `copilot -p "task"` (one-shot mode). After completion, panes linger with idle shells. There's no way to continue a conversation, resume a session, or reuse panes.

[pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents) demonstrates a more capable model: ephemeral panes, session-file persistence, interactive collaboration, session forking, and resume. We want to bring these capabilities to Copilot CLI, adapted to its architecture.

## Key Research Findings

### Copilot CLI Session System

- **Session storage**: `~/.copilot/session-state/<UUID>/` — each session gets a directory with `events.jsonl` (JSONL conversation log), `workspace.yaml` (metadata), checkpoints, and rewind snapshots.
- **Session IDs**: UUIDs (e.g. `ffa414b3-d165-46ac-8d00-691f9fb0673d`). The directory name IS the session ID.
- **Pre-generating session IDs**: `copilot --resume=<new-UUID>` creates a new session with that specific UUID. This means we can assign a known session ID to every child launch — no need to parse output.
- **Resume**: `copilot --resume=<session-id>` restores full conversation context from `events.jsonl`. This replaces pi's `--session <path>` approach.
- **No session env var**: No `COPILOT_SESSION_ID` environment variable exposed. Session ID must be passed via CLI flag.
- **Centralized index**: `~/.copilot/session-store.db` (SQLite) indexes all sessions with turns, checkpoints, refs, and files.

### Interactive Mode (`-i` flag)

- **`copilot -i "task"`**: Starts interactive session, executes the prompt, then stays alive for follow-up input.
- **`copilot -p "task"`**: Executes prompt and exits (current behavior).
- **Exit methods**: Ctrl+D, `/exit`, `/quit`. Process exits cleanly (exit code 0).
- **Session saved automatically**: Both `-i` and `-p` persist sessions to `~/.copilot/session-state/`.
- **Combinable**: `-i "task" --allow-all-tools -s --resume=<ID>` all work together.
- **No reliable "task complete" sentinel**: In interactive mode, copilot doesn't emit a distinct marker when the initial task finishes. Output monitoring (e.g. usage stats) is fragile.

### pi vs Copilot CLI Architectural Differences

| Aspect | pi-interactive-subagents | copilot-interactive-subagents |
|--------|--------------------------|-------------------------------|
| Multiplexers | cmux, tmux, zellij | tmux, zellij (zellij preferred) |
| Session persistence | `.jsonl` session files in a directory | `events.jsonl` + `workspace.yaml` per UUID |
| Session identity | File path | UUID (pre-generatable via `--resume=<UUID>`) |
| Resume mechanism | `pi --session <path>` | `copilot --resume=<UUID>` |
| Interactive mode | Native (default behavior) | `-i` flag (vs `-p` for one-shot) |
| Self-termination | `subagent_done` tool calls `ctx.shutdown()` | Sentinel pattern (`__SUBAGENT_DONE_<code>__`) via node wrapper |
| Pane lifecycle | `closeSurface()` kills pane after completion | Panes persist indefinitely (no cleanup) |
| Context sharing | `--fork <session-file>` copies full conversation | No equivalent — needs investigation |
| Agent definitions | `.md` files with frontmatter (model, tools, prompt) | `--agent <name>` flag (custom agents) |
| Extension API | `pi.registerTool()` with full control | SDK `joinSession({ tools })` with service injection |

## Design Decisions

### 0. Backend support: tmux and zellij (zellij preferred)

**Decision**: Support both tmux and zellij as first-class backends. Make zellij the preferred default when both are available.

**Rationale**: The extension already has full zellij support (pane creation, send-keys, output capture, close-pane via `zellij action close-pane`). Both backends support all the operations needed for v1: open pane, send command, read output, close pane, set title.

**Current priority** (extension.mjs line 28-32):
```javascript
const DEFAULT_SUPPORTED_STARTUP = {
  cmux: false,
  tmux: true,    // auto-startable
  zellij: false, // not auto-startable
};
```

**v1 change**: When both tmux and zellij are detected as attached, prefer zellij. The backend selection logic in `resolveLaunchBackend` should check zellij first. Auto-start support remains tmux-only (zellij sessions can't be started from outside).

**Pane cleanup equivalents**:
- tmux: `tmux kill-pane -t <paneId>`
- zellij: `zellij action close-pane` (with `ZELLIJ_PANE_ID` env var)

**All v1 features must work on both backends**: interactive mode, session persistence, resume, pane cleanup. No tmux-only features.

### 1. Close panes after completion (default)

**Decision**: Default to `closePaneOnCompletion: true` for autonomous launches.

**Rationale**: Matches pi behavior. Eliminates pane sprawl. The session persists in `~/.copilot/session-state/` regardless — the pane is just a view.

**Implementation**: After sentinel detection, call `tmux kill-pane -t <paneId>`. Add `closePaneOnCompletion` option to launch request (default `true`, overridable to `false` for debugging).

**Interactive mode exception**: When `interactive: true`, the pane stays open (the user is actively working in it). Pane closes when the user exits (Ctrl+D) and the copilot process terminates.

### 2. Pre-generated session IDs for persistence

**Decision**: Generate a UUID before launch, pass it as `--resume=<UUID>` to create a session with a known ID.

**Rationale**: Copilot CLI's `--resume=<new-UUID>` feature lets us assign session IDs upfront. No output parsing needed. The launch manifest stores the `copilotSessionId` alongside the existing `launchId`.

**Implementation**: In `createDefaultAgentLaunchCommand`, generate a UUID and add `--resume=<UUID>` to the args. Store the UUID in the launch manifest as `copilotSessionId`.

**Resume flow**: `copilot_subagent_resume` reads the stored `copilotSessionId` from the manifest, launches `copilot --resume=<copilotSessionId>` in a new pane.

### 3. Interactive mode support

**Decision**: Add `interactive: boolean` parameter to `copilot_subagent_launch`. When `true`, use `copilot -i "task"` instead of `copilot -p "task"`.

**Behavior changes in interactive mode**:
- Launch command uses `-i` instead of `-p`
- The node wrapper / sentinel pattern is **not used** — copilot stays alive
- `awaitCompletion` semantics change: instead of waiting for sentinel, we wait for process exit (Ctrl+D / `/exit`)
- Pane stays visible — user collaborates directly
- Summary extraction: read `workspace.yaml` summary field or last assistant message from `events.jsonl` after process exits

**Completion detection**: Poll for process termination in the pane (`tmux list-panes -F '#{pane_pid}'` and check if child process is still alive), rather than sentinel matching. Alternatively, just return immediately with `status: "interactive"` and let the user resume later.

**Open question**: Should interactive launches return immediately (fire-and-forget) or block until the user exits? Recommendation: return immediately with the pane/session metadata. The parent can resume later to get the summary.

### 4. Context sharing / fork

**Decision**: Implement fork by copying the session directory, then resuming the copy.

**Confirmed by LT2**: `copilot --resume=<ID>` mutates the original session (appends to `events.jsonl`). To fork without corrupting the parent:

1. Generate a new UUID for the fork
2. Copy `~/.copilot/session-state/<parent-UUID>/` to `~/.copilot/session-state/<fork-UUID>/`
3. Update `workspace.yaml` in the copy to reflect the new UUID
4. Launch `copilot --resume=<fork-UUID> -i "follow-up task"` (or `-p`)

**Confirmed by LT3**: The forked session retains full conversation context — tested with a "secret word" pattern where the child correctly recalled context from the parent session.

**When to use**: The `fork` parameter on `copilot_subagent_launch` would enable this. Useful for `/iterate`-style workflows where a subagent needs the parent's full context.

### 5. Self-termination tool

**Decision**: Add a `subagent_done` mechanism for autonomous agents.

**Current approach**: The node `-e` wrapper spawns copilot, waits for exit, then writes `__SUBAGENT_DONE_<code>__`. This works but is indirect.

**Enhanced approach**: Register a `subagent_done` extension that:
1. Writes a sentinel file (`.copilot-interactive-subagents/done/<launchId>`) with the summary
2. Exits the copilot process gracefully

**For interactive mode**: Not needed — the user exits naturally via Ctrl+D.

**For autonomous mode**: Keep the current sentinel pattern (it works). Optionally enhance with a sentinel file that the parent can read for richer summary data (beyond just exit code).

### 6. Resume via Copilot CLI sessions

**Decision**: Rework `copilot_subagent_resume` to use `copilot --resume=<copilotSessionId>`.

**Current resume**: Reads launch manifest, re-attaches to existing pane, polls for sentinel. This only works if the original pane is still alive.

**New resume**: 
1. Read launch manifest → get `copilotSessionId`
2. Create a new pane (the old one was closed after completion)
3. Launch `copilot --resume=<copilotSessionId> -i "continue"` in the new pane
4. Full conversation context is restored from the original session
5. Update the launch manifest with new pane ID

**This is the pi model**: panes are ephemeral, sessions are permanent. Resume creates a new view into an existing session.

### 7. Agent definitions (deferred)

**Decision**: Skip for v1. Copilot CLI has `--agent <name>` for custom agents. Can be added later with agent definition files (`.md` with frontmatter) similar to pi.

## Architecture: What Changes

### Launch Command Builder

Current (line 824 of extension.mjs):
```javascript
// Always one-shot mode
const args = ["-p", decode("COPILOT_SUBAGENT_TASK_B64"), "--allow-all-tools", ...];
```

v1:
```javascript
const copilotSessionId = crypto.randomUUID();
const mode = interactive ? "-i" : "-p";
const args = [
  mode, decode("COPILOT_SUBAGENT_TASK_B64"),
  "--resume", copilotSessionId,    // pre-assign session ID
  "--allow-all-tools", "--allow-all-paths", "--allow-all-urls",
  "--no-ask-user", "-s"
];
// For autonomous mode: still use node wrapper + sentinel
// For interactive mode: run copilot directly (no wrapper)
```

### Launch Manifest Schema

Current fields + new fields:
```javascript
{
  // existing
  launchId, agentIdentifier, agentKind, backend, paneId, sessionId,
  requestedAt, status, summary, exitCode, metadataVersion,
  
  // new in v1
  copilotSessionId: string,      // UUID for copilot --resume
  interactive: boolean,           // launched with -i vs -p
  closedPaneOnCompletion: boolean // whether pane was cleaned up
}
```

### Completion Detection

| Mode | Detection | Pane Cleanup |
|------|-----------|-------------|
| Autonomous (`-p`) | Sentinel (`__SUBAGENT_DONE_<code>__`) | Kill pane (tmux/zellij) |
| Interactive (`-i`) | Process exit (Ctrl+D / `/exit`) | Kill pane (tmux/zellij) |
| Interactive (fire-and-forget) | Return immediately | User manages pane |

**Pane cleanup commands**:
- tmux: `tmux kill-pane -t <paneId>`
- zellij: `zellij action close-pane` (with `ZELLIJ_PANE_ID=<paneId>` env)

### Resume Flow

```
resume(launchId)
  → read manifest → get copilotSessionId
  → create new pane (tmux split-window)
  → send: copilot --resume=<copilotSessionId> -i "continue"
  → return pane metadata (user interacts directly)
```

## Open Questions for Learning Tests

### Results

#### LT1: Pre-assigned session ID ✅ CONFIRMED
`copilot --resume=<new-UUID>` creates a session directory with that exact UUID.
- Must be a valid RFC 4122 UUID (no prefixes/suffixes)
- Directory created at `~/.copilot/session-state/<UUID>/`
- `workspace.yaml` contains `id: <UUID>` matching exactly

#### LT2: Resume mutation ⚠️ MUTATES ORIGINAL
`copilot --resume=<existing-ID> -p "task"` **appends to the original session's `events.jsonl`**. It does NOT create a new session.
- Original: 7 lines, 5521 bytes → After resume: 14 lines, 10622 bytes
- A `session.resume` event is appended, followed by the new turn
- **Implication for fork**: To fork without mutating the parent, we must copy the session directory to a new UUID first, then `--resume` the copy.

#### LT2b: Fork via directory copy ✅ CONFIRMED
Forking by copying the session directory works correctly:
1. Copy `~/.copilot/session-state/<parent>/` → `~/.copilot/session-state/<fork>/`
2. Update `workspace.yaml` `id:` field to the new UUID
3. `copilot --resume=<fork-UUID>` loads full parent context
- Tested: parent stored 3 facts (project Neptune, deadline March 15, lead Alice). Fork recalled all three correctly.
- Parent remained at 18 events (untouched). Fork grew to 36 events (new turn appended only to the copy).
- **No additional files need updating** — only `workspace.yaml` `id:` field needs the new UUID. The `events.jsonl` contains the original session ID in `session.start` but copilot handles the mismatch gracefully.

#### LT3: Interactive + resume ✅ CONFIRMED
`copilot --resume=<ID> -i "follow up"` works correctly:
- Full conversation context is restored (agent remembered "BANANA" from prior turn)
- Interactive prompt (`❯`) appears after responding
- User can continue typing follow-up messages
- Session file continues to accumulate events

#### LT4: Process exit detection ✅ CONFIRMED
Two reliable detection methods:
1. **`tmux list-panes -F '#{pane_current_command}'`**: Shows `copilot` while running, changes to `zsh` (or parent shell) after exit.
2. **Child PID monitoring**: `ps --ppid <shell-pid>` shows copilot's `MainThread` child process. When copilot exits, no children remain.
3. **Pane auto-close**: If the pane was created with a command (not a shell), it closes when copilot exits — this is the simplest approach for autonomous mode.

For zellij: `zellij action list-clients` and process monitoring work similarly.

#### LT5: Summary extraction ✅ CONFIRMED
Two sources for summary after session completes:
1. **`workspace.yaml`** → `summary:` field (auto-generated, sometimes just the prompt text)
2. **`events.jsonl`** → `assistant.message` events with `data.content` field containing the response text. Last `assistant.message` before `session.shutdown` is the final response.

Event structure: `{ type: "assistant.message", data: { content: "response text", messageId, ... } }`

Full event sequence per turn: `user.message → assistant.turn_start → assistant.message → assistant.turn_end`
Resume adds: `session.resume → session.model_change` before the new turn.

## Relationship to pi-interactive-subagents

| pi Feature | v1 Equivalent | Status |
|------------|---------------|--------|
| `closeSurface()` | `tmux kill-pane` / `zellij action close-pane` after completion | ✅ Include |
| Session file persistence | Pre-generated UUID + `events.jsonl` | ✅ Confirmed (LT1) |
| `interactive: true/false` | `-i` vs `-p` flag | ✅ Confirmed (LT3) |
| `fork: true` | Copy session dir + `--resume=<copy-UUID>` | ✅ Confirmed (LT2, LT3) |
| `subagent_done` tool | Sentinel pattern (enhanced) | ✅ Include |
| `subagent_resume` | `--resume=<copilotSessionId>` in new pane | ✅ Confirmed (LT3) |
| Agent definitions | `--agent` flag (deferred) | ⏭️ v2 |
| `/plan` workflow | Existing omc design skill | N/A |
| `/iterate` workflow | Interactive launch + fork | ✅ Include |
| Session artifacts | Extension-managed files dir | ⏭️ v2 |
