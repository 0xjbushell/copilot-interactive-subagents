---
name: using-copilot-interactive-subagents
description: "Teach Copilot agents how to delegate work through the copilot-interactive-subagents extension. Use when you want visible pane-backed subagents, tmux or attached-zellij delegation, exact agent launching, parallel pane fan-out, or resume/handoff via copilot_subagent_* tools."
---

# Using copilot-interactive-subagents

Use this skill when the repository has the `copilot-interactive-subagents` extension available and the task benefits from visible pane-backed delegation instead of hidden background execution.

Follow this workflow:

1. Decide whether the extension is the right tool.
   - Use it for visible `tmux` or attached `zellij` subagents, exact agent targeting, parallel fan-out, or resumable pane-backed launches.
   - Do not use it when simple in-session work is enough.

2. Choose a backend deliberately.
   - Prefer `tmux` by default. It is the easiest path because it can attach or auto-start.
   - Use `zellij` only from inside an attached `zellij` session.
   - Do not assume `cmux` has default pane operations.

3. Discover runtime facts before launching.
   - Call `copilot_subagent_list_agents` first unless you already know the exact agent identifier and currently supported backends.
   - Treat `agentIdentifiers` as exact-name only.
   - `github-copilot` is the built-in identifier to use for the default Copilot agent.

4. Launch with the smallest tool that fits.
   - Use `copilot_subagent_launch` for one child.
   - Use `copilot_subagent_parallel` for multiple read-heavy children on one shared backend.
   - Use `copilot_subagent_resume` when you already have `launchId` or `resumePointer`.
   - Use `copilot_subagent_set_title` only for operator-visible phase labels.

5. Pick completion behavior intentionally.
   - Prefer `awaitCompletion: true` when the parent should monitor the child and return a final structured result.
   - Use `awaitCompletion: false` for long-running work you plan to revisit later.
   - Preserve `launchId` or the full `resumePointer` whenever follow-up may be needed.

6. Handle backend and validation failures by code, not prose.
   - `AGENT_NOT_FOUND`: re-run `copilot_subagent_list_agents` and use an exact identifier.
   - `BACKEND_UNAVAILABLE`: no usable backend is currently attached or startable.
   - `BACKEND_START_UNSUPPORTED`: the requested backend exists but cannot be auto-started in the current runtime.
   - `PARALLEL_BACKEND_CONFLICT`: all entries in one parallel request must share the same backend.
   - `RESUME_TARGET_INVALID` or `LAUNCH_NOT_FOUND`: the saved launch metadata is stale or missing.

Use these request shapes:

```json
{
  "tool": "copilot_subagent_list_agents",
  "args": {
    "builtInIdentifiers": ["github-copilot"]
  }
}
```

```json
{
  "tool": "copilot_subagent_launch",
  "args": {
    "agentIdentifier": "github-copilot",
    "task": "Review the current diff and summarize correctness risks.",
    "backend": "tmux",
    "awaitCompletion": true
  }
}
```

```json
{
  "tool": "copilot_subagent_parallel",
  "args": {
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
}
```

Important operating notes:

- Interactive Copilot CLI is the validated operating mode for this extension.
- Real child turns can take tens of seconds; allow the monitored launch to finish instead of assuming a fast failure.
- Parallel write-heavy work is not automatically isolated. Prefer separate checkouts or read-heavy fan-out.
- For deeper tool-by-tool examples, read `docs/skills-integration.md`.
