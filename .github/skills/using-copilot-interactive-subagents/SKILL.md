---
name: using-copilot-interactive-subagents
description: "Teach Copilot agents how to delegate work through the copilot-interactive-subagents extension. Use when you want visible pane-backed subagents, tmux or attached-zellij delegation, exact agent launching, parallel pane fan-out, resume/handoff, session forking, interactive collaboration, or child-to-parent pings via copilot_subagent_* tools."
---

# Using copilot-interactive-subagents (v2.0)

Use this skill when the repository has the `copilot-interactive-subagents` extension available and the task benefits from visible pane-backed delegation instead of hidden background execution.

> Spec: `specs/subagents/interactive-subagents-v2.md` (extension repo). Locked decisions: `specs/decisions/interactive-subagents-v2-decisions.md`.

## Capabilities

- **5 parent tools**: `list_agents`, `launch`, `parallel`, `resume`, `set_title`
- **2 child-only tools**: `subagent_done`, `caller_ping` (only available inside child sessions)
- **3 backends**: cmux, tmux, zellij
- **Persistent sessions**: every launch gets a Copilot session UUID, stored in a launch manifest (v3)
- **Interactive mode**: launch with `interactive: true` to keep the pane open for user collaboration
- **Resume**: continue a completed session with full context, optionally injecting a follow-up `task`
- **Fork**: branch a parent session's context into a new child launch
- **Ping**: child can pause itself and request parent input via `caller_ping`; parent resumes with a task
- **Ephemeral panes**: auto-close panes after autonomous completion (configurable)

## What's new in v2

- `caller_ping` — a child can end its turn and signal the parent that it needs input. Parent observes `status: "ping"` and resumes with a follow-up `task`.
- `resume({ task: "…" })` — inject a follow-up instruction when resuming; omit or pass `""` for a plain resume.
- `subagent_done({ summary: "…" })` — optional summary field; preferred over relying on the pane scrape.
- Parallel aggregation treats `ping` as non-failure: `[success, ping]` → `success`; `[failure, ping]` → `partial-success`.
- Child sessions only see `subagent_done` and `caller_ping` — the parent spawning tools are stripped to prevent runaway recursion.
- Manifest v3 is a **hard cutover**; v2 launches cannot be resumed. Re-launch instead.

## Workflow

1. **Discover before launching.** Call `copilot_subagent_list_agents` unless you already know the exact agent identifier and supported backends. `agentIdentifiers` are exact-name only; `github-copilot` is the built-in default.

2. **Choose a backend deliberately.** Prefer `tmux` by default — it can attach or auto-start a server. Use `zellij` only from inside an attached zellij session. `cmux` is supported but has no default pane operations.

3. **Launch with the smallest tool that fits.**
   - `copilot_subagent_launch` — one child agent
   - `copilot_subagent_parallel` — multiple children on one shared backend
   - `copilot_subagent_resume` — continue a prior session by `launchId` or `resumePointer`, with optional follow-up `task`
   - `copilot_subagent_set_title` — update pane title for operator visibility

4. **Pick the right launch mode.**
   - **Autonomous** (default): `awaitCompletion: true`, pane auto-closes on completion. Parent blocks until child finishes and gets a structured result.
   - **Fire-and-forget**: `awaitCompletion: false`. Parent returns immediately with `launchId` for later resume.
   - **Interactive**: `interactive: true`. Launches with `-i` flag, pane stays open for user input. Use for collaborative work.

5. **Handle the `status: "ping"` case.** When a child calls `caller_ping`, its launch completes with `status: "ping"`, `summary: null`, `exitCode: 0`, and a `ping: { message }` field. Decide what input the child needs, then call `copilot_subagent_resume` with `{ launchId, task: "<answer or directive>" }`. The same launchId can cycle ping→resume→ping multiple times.

6. **Use fork for context sharing.**
   - `fork: { launchId: "..." }` — fork a previous launch's session into the new child
   - `fork: { copilotSessionId: "..." }` — fork a specific Copilot session UUID
   - The child starts with the parent's full conversation context, then diverges.

7. **Resume completed sessions.** Save `launchId` or `resumePointer` from the launch result. Call `copilot_subagent_resume` with the ID (and optional `task`) to continue.

## Tool Reference

### copilot_subagent_list_agents

Returns: `agentIdentifiers`, `supportedBackends` (with `attached`/`startable` status), `builtInIdentifiers: ["github-copilot"]`.

### copilot_subagent_launch

```json
{
  "agentIdentifier": "github-copilot",
  "task": "Review the current diff and summarize correctness risks.",
  "backend": "tmux",
  "awaitCompletion": true
}
```

With interactive mode and fork:

```json
{
  "agentIdentifier": "github-copilot",
  "task": "Continue debugging the auth failure from the previous session.",
  "backend": "tmux",
  "interactive": true,
  "fork": { "launchId": "prev-launch-id" }
}
```

Result shape:

```
launchId, backend, paneId, sessionId,
status: "running" | "success" | "failure" | "cancelled" | "timeout" | "ping",
summary: string | null        // null when status === "ping"
exitCode: number | null       // 0 when status === "ping"
ping?: { message: string }    // present only when status === "ping"
resumePointer: object | null
```

### copilot_subagent_parallel

```json
{
  "backend": "tmux",
  "awaitCompletion": true,
  "launches": [
    { "agentIdentifier": "github-copilot", "task": "Inspect the API changes and summarize risks." },
    { "agentIdentifier": "github-copilot", "task": "Inspect the tests and summarize gaps." }
  ]
}
```

Aggregation rules:

| Individual statuses | aggregateStatus |
|---|---|
| all `success` and/or `ping` | `success` |
| at least one `success`/`ping` AND at least one `failure`/`timeout`/`cancelled` | `partial-success` |
| all `cancelled` (and no success/ping) | `cancelled` |
| all `timeout` (and no success/ping) | `timeout` |
| otherwise (e.g. all `failure`, mixed terminal failures) | `failure` |

Snapshot fields include `successCount`, `pingCount`, `failureCount` (failureCount excludes pending/running/interactive/success/ping).

### copilot_subagent_resume

Plain resume:

```json
{ "launchId": "abc-123-def", "awaitCompletion": true }
```

Resume with a follow-up task (respond to a ping, or steer a completed session):

```json
{
  "launchId": "abc-123-def",
  "task": "The API key lives in env.STAGING_KEY. Continue and verify the auth flow.",
  "awaitCompletion": true
}
```

`task: ""` and `task` omitted are equivalent — no extra prompt is delivered. The resume result shape matches `launch`, including the `ping` field when the resumed session pings again.

### copilot_subagent_set_title

```json
{ "title": "Phase 2: Testing", "backend": "tmux", "paneId": "%5" }
```

## Child-Only Tools

These tools only exist inside a child session (spawned by this extension). The parent never sees them, and children cannot call any of the `copilot_subagent_*` parent tools — the parent tool list is filtered at registration time.

### subagent_done

Signal the end of the child's work. Prefer passing a summary directly rather than relying on pane-scrape.

```json
{ "summary": "Implemented retry logic in lib/http.js. Added 3 unit tests; all green." }
```

- `summary` is optional. Empty or whitespace-only strings normalize to `null` and fall back to pane scrape.
- After calling, **end your turn**. Do not call further tools.

### caller_ping

Pause work and notify the parent that you need input. After calling, end your turn — the session terminates and the parent will resume you with a follow-up task.

```json
{ "message": "I need the staging API key to continue the auth integration test." }
```

- `message` is required.
- Parent observes `status: "ping"`, `ping: { message }`, and can call `resume({ launchId, task: "<answer>" })` to continue you with the answer injected as a follow-up instruction.
- Same `launchId` supports ping→resume cycles more than once.

## Error Codes

| Code | Meaning | Action |
|------|---------|--------|
| `AGENT_NOT_FOUND` | Invalid agent identifier | Re-run `list_agents`, use exact name |
| `BACKEND_UNAVAILABLE` | No usable backend attached or startable | Check tmux/zellij is running |
| `BACKEND_START_UNSUPPORTED` | Backend exists but can't auto-start | Start the backend manually |
| `PARALLEL_BACKEND_CONFLICT` | Mixed backends in parallel request | Use same backend for all entries |
| `RESUME_TARGET_INVALID` | Launch metadata stale or missing | Check launchId is correct |
| `RESUME_UNSUPPORTED` | Pre-v2 launch (no copilotSessionId) | Re-launch; cannot resume |
| `LAUNCH_NOT_FOUND` | No manifest for this launchId | Session may have been cleaned up |
| `SESSION_ACTIVE` | Session is still running or locked | Wait for completion or use a new launch |
| `FORK_SOURCE_NOT_FOUND` | Fork source session doesn't exist | Check launchId/copilotSessionId |
| `MANIFEST_VERSION_UNSUPPORTED` | Launch manifest is not v3 | Hard cutover; re-launch |
| `STATE_DIR_MISSING` | Child tool ran without `COPILOT_SUBAGENT_STATE_DIR` | Don't invoke children outside this extension's launch path |
| `TOOL_TIMEOUT` | Tool exceeded 90s | Retry; investigate if recurrent |

## Operating Notes

- Real child turns can take tens of seconds — allow monitored launches to finish.
- Parallel write-heavy work is not automatically isolated. Prefer separate checkouts or read-heavy fan-out.
- Launch manifests live at `<workspace>/.copilot-interactive-subagents/launches/<launchId>.json`.
- Exit sidecars (the v2 IPC primitive) live at `<workspace>/.copilot-interactive-subagents/exit/<launchId>.json`.
- Each launch gets a pre-generated Copilot session UUID — no parsing needed.
- Pane cleanup is automatic for autonomous launches (`closePaneOnCompletion` defaults to `true`).
- Interactive launches keep the pane open (`closePaneOnCompletion` defaults to `false`).
- Children cannot spawn further children — the parent spawning tools are filtered out of child tool lists.

