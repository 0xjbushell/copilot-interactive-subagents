# Interactive Subagents v1 — Decisions

Locked design decisions for the interactive subagents v1 extension, derived from exploration and learning tests against Copilot CLI v1.0.22.

## Decision Index

### D1: Default pane lifecycle → Ephemeral (close after completion) `[decision]` `[research]`
Panes are disposable views into persistent sessions. After an autonomous subagent completes (sentinel detected), the pane is closed via `tmux kill-pane` / `zellij action close-pane`. Interactive panes close when the user exits (Ctrl+D / `/exit`) and the copilot process terminates.

Override: `closePaneOnCompletion: false` keeps the pane alive (useful for debugging).

Rationale: Matches pi-interactive-subagents behavior. Eliminates pane sprawl. Session state persists in `~/.copilot/session-state/` regardless of pane lifecycle.

### D2: Session identity → Pre-generated UUIDs via `--resume=<UUID>` `[research]`
Generate a UUID before launch and pass it as `copilot --resume=<UUID>` to create a session with a known ID. Store the UUID as `copilotSessionId` in the launch manifest.

Confirmed by LT1: `copilot --resume=<new-UUID>` creates a session directory at `~/.copilot/session-state/<UUID>/` with the exact ID. Must be a valid RFC 4122 UUID.

### D3: Interactive mode → `-i` flag with fire-and-forget return `[user]` `[research]`
`interactive: true` on launch uses `copilot -i "task"` instead of `copilot -p "task"`. The copilot process stays alive for user collaboration.

Interactive launches return immediately with `status: "interactive"` and pane metadata. The parent does not block waiting for completion. The user works directly in the pane and exits via Ctrl+D. Summary is extracted on resume or explicit status check.

Confirmed by LT3: Interactive + resume retains full conversation context.

### D4: Fork → Copy session directory + resume the copy `[research]`
Fork creates an isolated child session with full parent context:
1. Generate new UUID for the fork
2. Copy `~/.copilot/session-state/<parent>/` to `~/.copilot/session-state/<fork>/`
3. Update `workspace.yaml` `id:` field to the fork UUID
4. Launch `copilot --resume=<fork-UUID>` in a new pane

Confirmed by LT2b: Fork recalled all parent context. Parent session untouched (18 events before/after). Fork appended new events only to its own copy.

### D5: Resume → New pane + `--resume=<copilotSessionId>` `[decision]` `[research]`
Resume creates a new pane and launches `copilot --resume=<copilotSessionId>` to restore full conversation context. The old pane was already closed (D1). Sessions are the persistence layer, not panes.

Confirmed by LT3: Resume with `-i` flag for interactive follow-up works correctly.

### D6: Autonomous completion → Sentinel pattern (unchanged) `[codebase]`
Keep the existing `__SUBAGENT_DONE_<exitCode>__` sentinel for autonomous (`-p`) launches. The node wrapper script remains unchanged. This is proven, tested, and works with both tmux and zellij.

### D7: Summary extraction → `events.jsonl` assistant messages + `workspace.yaml` `[research]`
After session completion, extract summary from:
1. **Primary**: Last `assistant.message` event's `data.content` field from `events.jsonl`
2. **Fallback**: `workspace.yaml` `summary:` field

Confirmed by LT5: Both sources are reliable and available after session shutdown.

### D8: Backend preference → Zellij preferred when both available `[user]`
When both tmux and zellij are detected as attached, prefer zellij. Backend selection in `resolveLaunchBackend` checks zellij first. All features must work identically on both backends.

### D9: Manifest schema → v2 (clean break) `[codebase]` `[user]`
Bump `metadataVersion` to 2. No backward compatibility with v1 needed — there are no existing users. New fields: `copilotSessionId`, `interactive`, `fork`, `closedPaneOnCompletion`, `eventsBaseline`.

### D10: Self-termination tool → Included in v1 `[user]` `[codebase]`
Register a `subagent_done` tool in child sessions. When the child agent calls it, the process exits cleanly (exit code 0). The sentinel wrapper captures this as `__SUBAGENT_DONE_0__`. The last assistant message before the tool call becomes the extractable summary. This provides an explicit completion signal for both autonomous and interactive sessions, matching pi's pattern.
