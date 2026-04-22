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

### 3. Tool access control — YES, scope narrowed to recursion block

**Scope:** Prevent child subagents from spawning further subagents. Only the top-level/parent session may call the extension's public subagent tools (`copilot_subagent_launch`, `copilot_subagent_parallel`, `copilot_subagent_resume`, `copilot_subagent_set_title`, `copilot_subagent_list_agents`). Children retain `subagent_done` (and the forthcoming `caller_ping`) — those are child-only lifecycle tools.

**Copilot CLI adaptation:**
- The extension already detects child sessions via `process.env.COPILOT_SUBAGENT_SESSION_ID`, set by the parent's launch command builder (`backend-ops.mjs:242`) for every spawned pane.
- When that env var is set, filter the public subagent tool names out of the array returned by `buildSdkTools(handlers)` before SDK registration.
- Symmetric to how `subagent_done` is conditionally registered today (`extension.mjs:496-510`), only inverted — set = child, so omit the spawning tools.

**What is NOT in scope for v2:**
- No per-launch `denyTools` parameter, no manifest field, no config UI.
- No filtering of built-in CLI tools (`bash`, `view`, `edit`, `create`, `ask_user`, etc.). The Copilot SDK does expose `availableTools`/`excludedTools` via `JoinSessionConfig` (see `copilot-sdk/types.d.ts:905-912`) for broader sandboxing, but that is deferred. The current goal is recursion prevention only.
- No denying spawn tools in the parent session — parent keeps full access.

**Why it fits:**
- Zero new state — the env var is already set authoritatively by the parent.
- Zero new protocol — tools simply aren't registered, so the child model has no knowledge they exist.
- No runtime error paths — registration-time filtering means calls never reach a handler.
- Matches the existing gated-registration pattern used for `subagent_done`.

**Security model:** A child cannot clear or override `COPILOT_SUBAGENT_SESSION_ID` against itself — the parent owns the child's command line and environment. If the env var is present at registration, the extension treats the session as a child and strips the spawning tools.

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
3. **Tool access control** — gate public subagent tools behind `COPILOT_SUBAGENT_SESSION_ID` absence (children cannot spawn further children)

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

3. Tool access control (independent — trivial, can ship first or alongside 1–2)
   - Define SPAWNING_TOOL_NAMES constant in extension.mjs
   - In registerExtensionSession, filter the tools array when COPILOT_SUBAGENT_SESSION_ID is set
   - Add symmetric unit test next to the existing subagent_done gating tests
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
| Tool access control | — | `extension.mjs` (registration-time filter only) |

## SDK Learning-Test Findings (2026-04-17)

Captured via `specs/learning-tests/v2-sdk-probe.mjs` (throwaway probe). Raw log: `specs/learning-tests/v2-sdk-probe.log`.

### Confirmed

- **Per-session extension forks.** Each Copilot session forks its own extension process. `joinSession()` resolves a `sessionId` before the session actually "starts". First-prompt hook ordering: `extension.load` → `joinSession.resolved` → `probe.ready` → `hook.onUserPromptSubmitted` → `hook.onSessionStart` (with `source:"new"`, `initialPrompt`). `onUserPromptSubmitted` firing **before** `onSessionStart` for the first prompt is counter-intuitive; do per-session init at module top level, not in `onSessionStart`.
- **`user.message` event schema.** `data` keys: `content`, `source?`, `interactionId`. Skills inject with `source="skill-<name>"` and content prefixed with `<skill-context name="…">…`. `MessageOptions` has no `source` field, so extension-injected `session.send` turns cannot be distinguished from real user typing via source alone.
- **`assistant.turn_start/turn_end/message` events fire**, carrying `turnId`, `interactionId`, `messageId`, `content`, `toolRequests`, `reasoningOpaque`/`reasoningText`, `outputTokens`, `requestId`.
- **`extensions_reload` disposes all active extension connections.** Existing sessions lose their tools until they fork new extension processes. Newly-installed extensions only attach to sessions that start or reload **after** install.

### Implications for v2 design

None of these findings change the pi-aligned scope above. Concretely:

1. **The single `.exit.json` file is correct for our use case**, precisely because it is *not* a mailbox. `subagent_done` and `caller_ping` both write once and then shut the child down (`ctx.shutdown()` in pi, pane-close + sentinel in ours). There is exactly one write per child-session lifetime, so the overwrite/queue/ack hazards a mailbox would have simply do not apply:

   | Mailbox hazard | Exit-with-status (our design) |
   |---|---|
   | Writer overwrites its own earlier events | Cannot happen — child terminates after the one write |
   | Parent crashes after read before processing | Poll is synchronous inside the launch tool call; if the tool call itself crashes, the launch has already failed and the user sees it |
   | Multiple writers racing | One child, one sidecar path per launchId |
   | Child emits progress/ping *while still running* | Out of scope — would require async injection (deferred indefinitely, see below) |

2. **Async parent-ping / bidirectional channel is deferred indefinitely.** It would require either `session.send({mode:"enqueue"})` injection into the parent (which pollutes conversation history as a synthetic user turn and cannot be tagged via `source`) or a separate in-session watcher extension (reload-hostile — `/clear` kills its `setInterval`). Neither is justified by the current use cases. `caller_ping` as exit-with-status + existing `subagent_resume` already covers the "child needs help" flow.

3. **User-takeover detection is deferred indefinitely.** Depends on reliably distinguishing injected prompts from real user input via `user.message.source`, which is not possible for extensions today. Moot anyway without Feature #0.

4. **Tool access control (Feature #3) is unaffected by these findings.** Registration-time filter on `COPILOT_SUBAGENT_SESSION_ID` runs at module top level — before any hook ordering or reload concerns apply.

## References

- pi-interactive-subagents v2.2.0: `~/.projects/oss/pi-interactive-subagents/`
- v1 spec: `specs/subagents/interactive-subagents-v1.md`
- Learning-test probe: `~/.copilot/extensions/v2-sdk-probe/extension.mjs` (throwaway)
- v1 exploration: `specs/explorations/interactive-subagents-v1.md`
