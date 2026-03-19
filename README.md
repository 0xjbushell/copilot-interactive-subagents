# copilot-interactive-subagents

`copilot-interactive-subagents` is a GitHub Copilot CLI extension that launches Copilot subagents into visible terminal multiplexer panes and keeps enough state to monitor, resume, and report on those runs later.

The design goal is simple:

- keep subagent work visible in real panes instead of hiding it behind background tasks
- work with the agents you already have installed in Copilot CLI
- return structured results to the parent session
- preserve enough metadata to resume or inspect launches later

This project is inspired by the `pi-interactive-subagents` workflow, but adapted for Copilot CLI instead of Pi.

## Why you would use this

Use this extension when you want Copilot to delegate work to other Copilot agents without losing operator visibility.

Typical reasons to use it:

- you want subagents to run in `tmux` panes you can watch directly
- you want parallel agent fan-out with per-agent attribution
- you want exact-name agent targeting instead of fuzzy role guessing
- you want launch metadata and resumable state instead of one-shot fire-and-forget runs
- you want an extension that is agent-agnostic rather than bundling its own planner/worker/reviewer prompts

In practice, this lets a parent Copilot session orchestrate other Copilot sessions while you can still inspect the real pane output yourself.

## What the extension does

The extension registers five tools:

- `copilot_subagent_list_agents`
- `copilot_subagent_launch`
- `copilot_subagent_parallel`
- `copilot_subagent_resume`
- `copilot_subagent_set_title`

Existing camelCase aliases remain available for compatibility, but new integrations should use the namespaced tool names above.

At a high level:

1. The extension loads into Copilot CLI with `joinSession()`.
2. It discovers exact custom-agent identifiers from the active Copilot runtime.
3. It discovers supported multiplexers and chooses a backend.
4. It opens a pane and launches a child Copilot session in that pane.
5. It watches the pane for a completion sentinel and extracts a summary.
6. It writes launch manifests so the run can be resumed or inspected later.

## How it works internally

### 1. Runtime loading

Copilot CLI discovers the extension from one of these locations:

- project-scoped: `.github/extensions/copilot-interactive-subagents/`
- user-scoped/global: `~/.copilot/extensions/copilot-interactive-subagents/`

The entrypoint is:

```text
extension.mjs
```

That file registers the public tools with Copilot CLI and delegates the actual orchestration logic to helper modules under `lib/`.

### 2. Exact-name agent targeting

This extension deliberately does not do fuzzy matching.

If you ask it to launch an agent, the identifier must be an exact identifier that Copilot runtime recognizes.

That means:

- good: `my-reviewer-agent`
- rejected: `reviewer`, if that is only a human nickname and not the real installed identifier
- rejected: aliases, fuzzy text, role inference, or "close enough" names

The one explicitly supported built-in identifier is:

- `github-copilot`

That built-in path is special-cased so the child launch uses the default Copilot agent path instead of `--agent github-copilot`, which the CLI does not accept.

### 3. Multiplexer selection

The extension supports a pane-backed workflow through terminal multiplexers.

Current backend behavior:

- `tmux`
  - attached detection
  - auto-start support
  - default pane launch support
  - default pane capture support
  - default title update support
  - live-validated in this project
- `cmux`
  - detection and backend selection support
  - default pane operations are not fully implemented without runtime adapters
- `zellij`
  - detection and backend selection support
  - default pane operations are not fully implemented without runtime adapters

So today, `tmux` is the production path with concrete end-to-end validation.

### 4. Child launch model

For each launched subagent, the extension:

- opens or attaches to a backend session
- opens a pane
- runs a child `copilot` process inside that pane
- waits for the child to emit a completion sentinel
- captures pane output
- extracts either an explicit summary, assistant message, or fallback summary

The child session emits a sentinel shaped like:

```text
__SUBAGENT_DONE_<exit_code>__
```

The parent monitor watches for that sentinel to determine completion.

### 5. Persisted state and resume

Launch metadata is written primarily to the workspace under:

```text
.copilot-interactive-subagents/launches/
```

The workspace manifest is the primary source of truth.

An optional project-local index can also be written as a secondary lookup aid for cross-session resume. That index is intentionally treated as best-effort and does not override the authoritative workspace manifest.

Persisted state includes:

- `launchId`
- `agentIdentifier`
- `backend`
- `paneId`
- `sessionId`
- status
- summary
- exit code
- metadata version

This is what powers `copilot_subagent_resume`.

## Installation

There are two supported installation styles:

- project-scoped installation
- global/user-scoped installation

### Prerequisites

- GitHub Copilot CLI installed and working
- a Copilot plan that supports the CLI
- `tmux` installed if you want the default fully working pane backend
- optional: installed custom agents if you want to launch agents other than the default `github-copilot`

### Project-scoped installation

Use this when you want the extension to apply only to a specific repository.

Copy the entire extension directory into the target repository:

```text
<target-repo>/.github/extensions/copilot-interactive-subagents/
  extension.mjs
  lib/
```

If you are installing from this repository as the source, an example command is:

```bash
mkdir -p /path/to/target-repo/.github/extensions
cp -R .github/extensions/copilot-interactive-subagents /path/to/target-repo/.github/extensions/
```

Then restart Copilot CLI in that repository.

Copilot CLI will discover:

```text
/path/to/target-repo/.github/extensions/copilot-interactive-subagents/extension.mjs
```

### Global or user-scoped installation

Use this when you want the extension available across repositories.

Copy the entire extension directory to:

```text
~/.copilot/extensions/copilot-interactive-subagents/
  extension.mjs
  lib/
```

Example:

```bash
mkdir -p ~/.copilot/extensions
cp -R .github/extensions/copilot-interactive-subagents ~/.copilot/extensions/
```

Then restart Copilot CLI.

### Project vs global precedence

If both exist with the same extension name:

- the project-scoped extension wins
- the project extension shadows the global one

That makes it easy to keep a stable global install while testing a project-local version in one repository.

## Recommended setup after installation

1. Make sure the repo you are using is trusted by Copilot CLI.
2. Start Copilot in interactive mode inside the repository.
3. If possible, start Copilot from an attached `tmux` session.
4. Call `copilot_subagent_list_agents` first to discover exact agent names.
5. Use those exact identifiers for launch or parallel launch.

## Verified host behavior

This project was verified in a real interactive Copilot CLI session.

Verified:

- extension loaded in interactive Copilot CLI
- `copilot_subagent_launch` succeeded in a real session
- `tmux` auto-started when needed
- a child Copilot pane completed successfully
- the parent tool returned structured success

Important host-mode note:

- interactive Copilot CLI is the verified operating mode for this project
- in the environment used during validation, non-interactive `copilot --prompt` did not expose the project extension tools even though interactive mode did

So if you depend on non-interactive prompt-mode extension loading, test that explicitly in your own environment.

## Public tool reference

### `copilot_subagent_list_agents`

Lists exact agent identifiers and available pane backends.

Request:

```json
{
  "builtInIdentifiers": ["github-copilot"]
}
```

Example result:

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

Launches one exact-name agent in a pane.

Request:

```json
{
  "agentIdentifier": "reviewer",
  "task": "Inspect the failing tests and summarize the root cause.",
  "backend": "tmux",
  "awaitCompletion": true
}
```

Example result:

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
  "summary": "Inspected the failing tests and identified the root cause.",
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

### `copilot_subagent_parallel`

Launches multiple agents against one shared backend.

Request:

```json
{
  "backend": "tmux",
  "awaitCompletion": true,
  "launches": [
    {
      "agentIdentifier": "reviewer-a",
      "task": "Inspect alpha."
    },
    {
      "agentIdentifier": "reviewer-b",
      "task": "Inspect beta."
    }
  ]
}
```

Example result:

```json
{
  "aggregateStatus": "partial-success",
  "results": [
    {
      "launchId": "launch-001",
      "backend": "tmux",
      "paneId": "%1",
      "sessionId": "session-a",
      "status": "success",
      "summary": "Alpha review complete.",
      "exitCode": 0,
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
  "progressByLaunchId": {
    "launch-001": {
      "launchId": "launch-001",
      "backend": "tmux",
      "paneId": "%1",
      "sessionId": "session-a",
      "status": "success",
      "summary": "Alpha review complete.",
      "exitCode": 0,
      "resumePointer": {
        "launchId": "launch-001",
        "sessionId": "session-a",
        "agentIdentifier": "reviewer-a",
        "backend": "tmux",
        "paneId": "%1",
        "manifestPath": "/path/to/workspace/.copilot-interactive-subagents/launches/launch-001.json"
      }
    }
  }
}
```

Important constraint:

- all launches in a single parallel request must use the same backend

### `copilot_subagent_resume`

Resumes a previously launched pane-backed session using `launchId` or `resumePointer`.

Request:

```json
{
  "launchId": "launch-001",
  "awaitCompletion": false
}
```

Example result:

```json
{
  "ok": true,
  "launchId": "launch-001",
  "status": "running",
  "agentIdentifier": "reviewer",
  "agentKind": "custom",
  "backend": "tmux",
  "paneId": "%1",
  "paneVisible": true,
  "sessionId": "session-123",
  "summary": "Subagent reviewer is running in tmux pane %1.",
  "summarySource": "fallback",
  "exitCode": null,
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

### `copilot_subagent_set_title`

Updates a pane title or operator-facing label when supported by the backend.

Request:

```json
{
  "backend": "tmux",
  "paneId": "%1",
  "title": "Investigating failures"
}
```

Result:

```json
{
  "ok": true,
  "backend": "tmux",
  "paneId": "%1",
  "title": "Investigating failures",
  "applied": true,
  "source": "backend-command"
}
```

## Safety and behavior notes

- agent targeting is exact-name only
- launch identifiers are validated before filesystem access
- unsupported backend values are rejected during resume
- child launch commands avoid unsafe shell interpolation by passing values through encoded environment variables
- project-local index writes are best-effort and cannot override the authoritative workspace manifest

## Stable failure codes

Common machine-readable codes include:

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

## Limitations

- `tmux` is the only backend with default pane operations that were fully implemented and live-validated here
- `cmux` and `zellij` currently need runtime adapters for full pane operations
- prompt-mode extension availability may depend on Copilot CLI host behavior; interactive mode is the validated path
- parallel write-heavy tasks are not serialized for you; avoid overlapping writes in one checkout unless your workflow isolates them

## Development and verification

Repository verification commands:

```bash
npm test
npm run test:coverage
npm run test:crap
npm run test:mutation
```

These were used to validate the implementation along with a real interactive Copilot CLI plus `tmux` end-to-end run.

## Agent Skill integration

See `docs/skills-integration.md` for Agent Skill-oriented examples and handoff guidance.
