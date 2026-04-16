---
name: using-copilot-interactive-subagents
description: "Teach Copilot agents how to delegate work through the copilot-interactive-subagents extension. Use when you want visible pane-backed subagents, tmux or attached-zellij delegation, exact agent launching, parallel pane fan-out, resume/handoff, session forking, or interactive collaboration via copilot_subagent_* tools."
---

# Using copilot-interactive-subagents (v1.0)

Use this skill when the repository has the `copilot-interactive-subagents` extension available and the task benefits from visible pane-backed delegation instead of hidden background execution.

## Capabilities

- **5 tools**: list_agents, launch, parallel, resume, set_title
- **3 backends**: cmux, tmux, zellij
- **Persistent sessions**: Every launch gets a Copilot session UUID, stored in a launch manifest
- **Interactive mode**: Launch with `-i` flag so the pane stays open for user collaboration
- **Resume**: Continue a completed session with full conversation context
- **Fork**: Branch a parent session's context into a new child launch
- **Ephemeral panes**: Auto-close panes after autonomous completion (configurable)

## Workflow

1. **Discover before launching.**
   - Call `copilot_subagent_list_agents` first unless you already know the exact agent identifier and supported backends.
   - `agentIdentifiers` are exact-name only. `github-copilot` is the built-in default.

2. **Choose a backend deliberately.**
   - Prefer `tmux` by default — it can attach or auto-start a server.
   - Use `zellij` only from inside an attached zellij session.
   - `cmux` is supported but has no default pane operations.

3. **Launch with the smallest tool that fits.**
   - `copilot_subagent_launch` — one child agent
   - `copilot_subagent_parallel` — multiple children on one shared backend
   - `copilot_subagent_resume` — continue a prior session by `launchId` or `resumePointer`
   - `copilot_subagent_set_title` — update pane title for operator visibility

4. **Pick the right launch mode.**
   - **Autonomous** (default): `awaitCompletion: true`, pane auto-closes on completion. Parent blocks until child finishes and gets structured result.
   - **Fire-and-forget**: `awaitCompletion: false`. Parent returns immediately with `launchId` for later resume.
   - **Interactive**: `interactive: true`. Launches with `-i` flag, pane stays open for user input. Use for collaborative work.

5. **Use fork for context sharing.**
   - `fork: { launchId: "..." }` — fork a previous launch's session into the new child
   - `fork: { copilotSessionId: "..." }` — fork a specific Copilot session UUID
   - The child starts with the parent's full conversation context, then diverges.

6. **Resume completed sessions.**
   - Save `launchId` or `resumePointer` from the launch result.
   - Call `copilot_subagent_resume` with the ID to continue the conversation.
   - Resume opens a new pane, loads the session, and optionally awaits completion.

## Tool Reference

### copilot_subagent_list_agents

```json
{
  "builtInIdentifiers": ["github-copilot"]
}
```

Returns: `agentIdentifiers`, `supportedBackends` (with `attached`/`startable` status).

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

Returns: `launchId`, `backend`, `paneId`, `sessionId`, `status`, `summary`, `exitCode`, `resumePointer`.

### copilot_subagent_parallel

```json
{
  "backend": "tmux",
  "awaitCompletion": true,
  "launches": [
    {
      "agentIdentifier": "github-copilot",
      "task": "Inspect the API changes and summarize risks."
    },
    {
      "agentIdentifier": "github-copilot",
      "task": "Inspect the tests and summarize gaps."
    }
  ]
}
```

Returns: `aggregateStatus`, `results[]` (one per launch), `progressByLaunchId`.

### copilot_subagent_resume

```json
{
  "launchId": "abc-123-def",
  "awaitCompletion": true
}
```

Or via resumePointer (returned from prior launch):

```json
{
  "resumePointer": { "launchId": "abc-123-def" },
  "awaitCompletion": true
}
```

### copilot_subagent_set_title

```json
{
  "title": "Phase 2: Testing",
  "backend": "tmux",
  "paneId": "%5"
}
```

## Error Codes

| Code | Meaning | Action |
|------|---------|--------|
| `AGENT_NOT_FOUND` | Invalid agent identifier | Re-run `list_agents`, use exact name |
| `BACKEND_UNAVAILABLE` | No usable backend attached or startable | Check tmux/zellij is running |
| `BACKEND_START_UNSUPPORTED` | Backend exists but can't auto-start | Start the backend manually |
| `PARALLEL_BACKEND_CONFLICT` | Mixed backends in parallel request | Use same backend for all entries |
| `RESUME_TARGET_INVALID` | Launch metadata stale or missing | Check launchId is correct |
| `LAUNCH_NOT_FOUND` | No manifest for this launchId | Session may have been cleaned up |
| `SESSION_ACTIVE` | Session is still running (resume rejected) | Wait for completion or use a new launch |
| `FORK_SOURCE_NOT_FOUND` | Fork source session doesn't exist | Check launchId/copilotSessionId |

## Operating Notes

- Real child turns can take tens of seconds — allow monitored launches to finish.
- Parallel write-heavy work is not automatically isolated. Prefer separate checkouts or read-heavy fan-out.
- Launch manifests are stored in `~/.copilot-interactive-subagents/launches/`.
- Each launch gets a pre-generated Copilot session UUID — no parsing needed.
- Pane cleanup is automatic for autonomous launches (`closePaneOnCompletion` defaults to `true`).
- Interactive launches keep the pane open (`closePaneOnCompletion` defaults to `false`).
