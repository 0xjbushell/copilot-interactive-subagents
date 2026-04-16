# Interactive Subagents v2 — Exploration

> **Status:** Active exploration. Not yet promoted to spec or decisions.

## Context

v1 (released as v1.0.0) provides fire-and-forget subagent orchestration: the parent launches a child in a terminal pane, waits for a "done" signal, reads a summary, and optionally resumes. Communication is limited to a plain signal file and pane screen scraping.

[pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents) v2.2.0 implements richer parent-child coordination: structured `.exit` sidecar files, `caller_ping` for help requests, artifact sharing, tool access control, and auto-exit. This exploration evaluates which patterns translate cleanly to Copilot CLI's architecture and which don't.

## Key Architectural Difference: pi vs Copilot CLI

pi's extension API provides `pi.sendMessage()` with `deliverAs: "steer"` — an in-process callback that injects messages directly into the parent agent's conversation loop. When a child completes or pings, pi delivers the result as a new turn asynchronously. The parent never blocks.

Copilot CLI has no equivalent. Each agent is an independent process in a terminal pane. The parent blocks inside a tool call, polling for completion. Communication is purely file-based. The parent cannot receive async notifications mid-conversation.

This means:
- Results are returned as tool call responses (blocking poll)
- Child-to-parent communication = "write file and exit" (parent detects on next poll cycle)
- No runtime access to child agent conversation loop
- No ability to inject messages into a running child session

## Research: How pi Implements Each Feature

### Structured exit sidecar (`.exit` file)
- Child calls `subagent_done` or `caller_ping` tool
- Tool writes JSON to `<sessionFile>.exit` (single file, not append-only)
- Tool calls `ctx.shutdown()` — child exits
- Parent's `pollForExit()` checks for `.exit` file each interval (1s)
- On detection: reads JSON, deletes file, returns result
- Schema: `{"type": "done"}` or `{"type": "ping", "name": "...", "message": "..."}`
- **Source:** `pi-extension/subagents/subagent-done.ts:151-204`, `cmux.ts:660-741`

### caller_ping
- Registered as a tool in the child's extension (`subagent-done.ts:151-183`)
- Writes `{"type": "ping", ...}` to `.exit` sidecar
- Calls `ctx.shutdown()` — child exits immediately
- Parent detects ping in `pollForExit`, returns `{reason: "ping", ping: {name, message}}`
- Parent's watcher sends result via `pi.sendMessage({deliverAs: "steer", triggerTurn: true})`
- Parent agent gets a new conversation turn with the ping details
- **Key insight:** The child does NOT block/wait for a response. It exits. The parent decides whether to resume.
- **Source:** `pi-extension/subagents/subagent-done.ts:151-183`, `index.ts:975-991`

### Tool access control
- Agent `.md` files have frontmatter: `deny-tools: tool1,tool2` and `spawning: false`
- `spawning: false` expands to deny all spawning tools (`subagent`, `subagents_list`, `subagent_resume`)
- Denied tools resolved in `resolveDenyTools()`, passed as `PI_DENY_TOOLS` env var
- Child extension reads env var on startup, gates `pi.registerTool()` with `shouldRegister(name)`
- **Source:** `index.ts:86-113`, `subagent-done.ts:99-106`

### Artifact system
- Separate extension (`session-artifacts/index.ts`) registers `write_artifact` and `read_artifact`
- Writes to `<sessionDir>/artifacts/<sessionId>/<name>`
- `read_artifact` searches current session first, then other sessions by mtime
- Path traversal protection: validates resolved path stays within artifact dir
- **Source:** `pi-extension/session-artifacts/index.ts:1-252`

### Auto-exit
- Enabled via `auto-exit: true` in agent frontmatter
- Extension listens to `pi.on("agent_end")` lifecycle event
- If agent completed normally (not aborted, user didn't take over), calls `ctx.shutdown()`
- User input after agent starts sets `userTookOver = true`, disabling auto-exit for that cycle
- **Source:** `pi-extension/subagents/subagent-done.ts:112-140`

## Feature Evaluation for Copilot CLI

### 1. Structured exit sidecar — YES, natural fit

**Current state:** v1 uses a plain signal file (presence = done) + pane screen scraping for exit codes and summaries. This is fragile and lossy.

**Copilot CLI adaptation:**
- Replace signal file with `<launchId>.exit.json`
- `subagent_done` tool writes structured JSON instead of touching signal file
- Parent poll loop reads sidecar instead of checking signal file presence
- Summary, exit code, and type (done/ping) in one atomic read

**Why it fits:** We already poll files. This just makes the file richer. No architectural change needed.

**Race condition note (from rubber-duck review):** pi uses a single `.exit` file, not append-only JSONL. This is fine because `caller_ping` and `subagent_done` both call `ctx.shutdown()` — only one can win. A child either pings-and-exits or completes-and-exits, never both. Same applies to our architecture.

### 2. caller_ping (exit-with-status) — YES, natural fit

**Copilot CLI adaptation:**
1. Child calls `caller_ping({message: "Need DB schema"})`
2. Tool writes `{"type":"ping","name":"...","message":"..."}` to exit sidecar
3. Tool triggers the same completion mechanism as `subagent_done` (child exits)
4. Parent poll detects sidecar, reads ping type
5. Parent returns tool result: "Agent X needs help: ..."
6. Caller can resume the session with additional context via `copilot_subagent_resume`

**Why it fits:** This is identical to pi's implementation. The child exits — no blocking, no response files, no active-session injection. The parent's existing poll loop handles it.

**Important:** `caller_ping` is only registered in child agents (gated by `COPILOT_SUBAGENT_SESSION` env var, same pattern pi uses with `PI_SUBAGENT_SESSION`).

### 3. Tool access control — YES, direct port

**Copilot CLI adaptation:**
- `denyTools` parameter on `copilot_subagent_launch`
- Stored in launch manifest
- Propagated as `COPILOT_SUBAGENT_DENY_TOOLS` env var to child process
- Extension reads env var in `registerExtensionSession()`, filters tools before SDK registration

**Scope (v2):** Prevent recursive spawning only (deny `copilot_subagent_launch`, `copilot_subagent_parallel`). True read-only sandboxing of built-in Copilot CLI tools is not feasible without CLI-level support.

### 4. Artifact system — NO, not needed

**Why not:** Copilot CLI agents have full filesystem access via built-in `create`, `view`, `edit`, and `bash` tools. They can already read and write files anywhere. A custom `write_artifact`/`read_artifact` tool would duplicate native capabilities.

pi needs artifacts because its extension API is the primary file management layer. Copilot CLI agents operate directly on the filesystem.

**Alternative:** Document a conventional path pattern (e.g., `.copilot-interactive-subagents/artifacts/<sessionId>/`) in task prompts if structured sharing is needed. No new tools required.

### 5. Auto-exit — NO, already have it

v1 already has `subagent_done` tool + sentinel pattern for autonomous completion. The child agent calls `subagent_done` when finished, which writes the signal file and the wrapper script emits the sentinel. The parent detects both.

pi's auto-exit is more nuanced (lifecycle hooks for user-takeover detection), but this requires `pi.on("agent_end")` and `pi.on("input")` lifecycle events that Copilot CLI's SDK doesn't expose.

### 6. Blocking caller_ping (child waits for response) — NO, architectural mismatch

Would require the child to block inside a tool call polling a response file. Copilot CLI agents aren't designed to sit idle waiting for external input — they're autonomous processes. No mechanism exists to inject a response into an active agent's conversation loop.

### 7. Context via file — DEFERRED

No evidence of size limits in practice with current base64 task encoding. Defer unless we hit actual issues.

### 8. WezTerm backend — DEFERRED

Low priority. tmux + zellij + cmux cover most users.

### 9. Live progress widget — NOT FEASIBLE

Requires Copilot SDK `sendMessage` equivalent for real-time updates. Not available.

## Proposed v2 Scope

Three features, implemented sequentially:

1. **Structured exit sidecar** — upgrade signal file to JSON with type/exitCode/summary
2. **caller_ping** — exit-with-status tool for child agents (depends on sidecar)
3. **Tool access control** — env var deny list for recursion prevention

### Implementation Order

```
1. Structured exit sidecar
   - Modify subagent_done to write JSON sidecar
   - Modify parent poll to read sidecar (dual-read for backward compat)
   - Bump manifest version to v3

2. caller_ping (depends on #1)
   - Register caller_ping tool in child agents
   - Add ping detection to parent poll
   - Return ping details in tool result

3. Tool access control (independent)
   - Add denyTools param to launch schema
   - Store in manifest, propagate via env var
   - Filter tools at extension registration
```

### Backward Compatibility

- **Signal file:** Dual-read for one release — check sidecar first, fall back to signal file
- **Manifests:** Resume accepts v2 + v3 manifests
- **Tool registration:** No breaking changes — new tools are additive

### Release

Ship as **v2.0.0** — new IPC mechanism warrants major version bump, even with backward compat.

## Files Likely Affected

| Feature | New Files | Modified Files |
|---------|-----------|----------------|
| Exit sidecar | — | `backend-ops.mjs`, `lib/launch.mjs`, `lib/summary.mjs`, `lib/resume.mjs`, `lib/state.mjs` |
| caller_ping | — | `backend-ops.mjs` (tool registration), `extension.mjs` (schema), `lib/launch.mjs` (detection) |
| Tool access control | — | `extension.mjs` (filter), `lib/launch.mjs` (manifest), `backend-ops.mjs` (env propagation) |

## References

- pi-interactive-subagents v2.2.0: `~/.projects/oss/pi-interactive-subagents/`
- v1 spec: `specs/subagents/interactive-subagents-v1.md`
- v1 exploration: `specs/explorations/interactive-subagents-v1.md`
