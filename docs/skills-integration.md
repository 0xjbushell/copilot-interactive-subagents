# Agent Skills integration guide

This project exposes a generic orchestration layer. Agent Skills should add workflow-specific planning and prompts **outside** the extension, then call the namespaced tools below with exact agent identifiers and plain task text.

If you want a ready-made project skill that teaches agents how to use this extension, start with:

```text
packages/copilot-interactive-subagents/skill/SKILL.md
```

To install both the extension and this starter skill into either `~/.copilot/` or a target repository, use `node scripts/install.mjs`.

## Generic tool contract

### `copilot_subagent_list_agents`

Use this first to discover valid exact agent identifiers and supported backends.

```json
{
  "builtInIdentifiers": ["github-copilot"]
}
```

Returns:

```json
{
  "agentIdentifiers": ["reviewer", "worker"],
  "builtInIdentifiersAcceptedExplicitly": ["github-copilot"],
  "exactNameOnly": true,
  "supportedBackends": [
    {
      "backend": "tmux",
      "source": "attached",
      "attachable": true,
      "startSupported": true
    }
  ]
}
```

### `copilot_subagent_launch`

Call with an exact `agentIdentifier` and the task text you want the child to execute.

```json
{
  "agentIdentifier": "reviewer",
  "task": "Review the API contract changes and summarize correctness risks.",
  "backend": "tmux",
  "awaitCompletion": true,
  "interactive": false,
  "fork": { "copilotSessionId": "parent-uuid" },
  "closePaneOnCompletion": true
}
```

Returns launch metadata that Agent Skills can hand off or store:

```json
{
  "ok": true,
  "launchId": "launch-001",
  "status": "success",
  "agentIdentifier": "reviewer",
  "agentKind": "custom",
  "backend": "tmux",
  "launchAction": "attach",
  "paneId": "%1",
  "paneVisible": true,
  "sessionId": "session-123",
  "summary": "Reviewed the API contract changes and summarized correctness risks.",
  "summarySource": "assistant-message",
  "exitCode": 0,
  "metadataVersion": 1,
  "resumePointer": {
    "launchId": "launch-001",
    "sessionId": "session-123",
    "agentIdentifier": "reviewer",
    "backend": "tmux",
    "paneId": "%1",
    "manifestPath": "/path/to/workspace/.copilot-interactive-subagents/launches/launch-001.json"
  }
}
```

When the child writes a `caller_ping` exit sidecar, the result carries `status: "ping"`, `summary: null`, `exitCode: 0`, and a `ping: { message }` payload. `ok` remains `true` (ping is a non-failure terminal state). Respond by calling `copilot_subagent_resume` with a `task` describing how to proceed.

### `copilot_subagent_parallel`

Use a single backend for the entire batch.

```json
{
  "backend": "tmux",
  "awaitCompletion": true,
  "launches": [
    {
      "agentIdentifier": "reviewer-a",
      "task": "Inspect alpha and summarize findings."
    },
    {
      "agentIdentifier": "reviewer-b",
      "task": "Inspect beta and summarize findings."
    }
  ]
}
```

Returns per-child result objects plus `aggregateStatus`:

```json
{
  "aggregateStatus": "success",
  "results": [
    {
      "ok": true,
      "launchId": "launch-001",
      "status": "success",
      "agentIdentifier": "reviewer-a",
      "agentKind": "custom",
      "backend": "tmux",
      "launchAction": "attach",
      "paneId": "%1",
      "paneVisible": true,
      "sessionId": "session-a",
      "summary": "Alpha findings ready.",
      "summarySource": "assistant-message",
      "exitCode": 0,
      "metadataVersion": 1,
      "resumePointer": {
        "launchId": "launch-001",
        "sessionId": "session-a",
        "agentIdentifier": "reviewer-a",
        "backend": "tmux",
        "paneId": "%1",
        "manifestPath": "/path/to/workspace/.copilot-interactive-subagents/launches/launch-001.json"
      }
    }
  ],
  "progressByLaunchId": {}
}
```

### `copilot_subagent_resume`

Resume from `launchId`, `resumeReference`, or `resumePointer`. Optional `task` delivers a follow-up instruction to the resumed child as a launch prompt (use this to respond to a `caller_ping`). Empty string is treated as omitted.

```json
{
  "resumeReference": {
    "launchId": "launch-001"
  },
  "awaitCompletion": false,
  "task": "please continue with the next step"
}
```

Returns the same stable metadata envelope, including `launchId`, `backend`, `paneId`, `sessionId`, `status`, `summary`, `exitCode`, and `resumePointer`.

### `copilot_subagent_set_title`

Use this optional helper for operator-visible handoff state.

```json
{
  "backend": "tmux",
  "paneId": "%1",
  "title": "Waiting for validation"
}
```

Returns:

```json
{
  "ok": true,
  "backend": "tmux",
  "paneId": "%1",
  "title": "Waiting for validation",
  "applied": true,
  "source": "backend-command"
}
```

## Handoff guidance for skills

- Keep prompts generic: the extension only needs an exact agent identifier and task text.
- Do not assume bundled planner/worker/reviewer prompts inside the extension.
- Persist `launchId` or the full `resumePointer` whenever a workflow may need to return later.
- If you need fan-out, prefer read-heavy work in `copilot_subagent_parallel`; document any parallel write-heavy caveats to operators.
- If the operator is likely to re-enter later, keep the same Copilot session workspace or preserve the project-local index for fallback resume.

## Error handling expectations

Agent Skills should branch on stable codes, not prose. Important codes include:

- `INVALID_ARGUMENT`
- `PARALLEL_BACKEND_CONFLICT`
- `AGENT_NOT_FOUND`
- `AGENT_VALIDATION_UNAVAILABLE`
- `BACKEND_UNAVAILABLE`
- `BACKEND_START_UNSUPPORTED`
- `LAUNCH_NOT_FOUND`
- `RESUME_UNSUPPORTED`
- `RESUME_TARGET_INVALID`
- `RESUME_ATTACH_FAILED`
- `TITLE_TARGET_INVALID`
- `TITLE_UNSUPPORTED`

Every validation failure includes human-readable `guidance` so skills can surface actionable operator handoff text without inventing their own remediation copy.
