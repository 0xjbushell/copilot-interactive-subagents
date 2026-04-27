/**
 * Tool definitions, parameter schemas, and name mappings for the extension's public tools.
 * Pure data — no logic or external dependencies.
 */

export const PUBLIC_TOOL_NAMES = [
  "copilot_subagent_list_agents",
  "copilot_subagent_launch",
  "copilot_subagent_parallel",
  "copilot_subagent_resume",
  "copilot_subagent_set_title",
];

export const PUBLIC_TOOL_DEFINITIONS = [
  {
    name: "copilot_subagent_list_agents",
    description: "List exact agent identifiers and supported pane backends.",
    requestShape: {
      builtInIdentifiers: "string[] (optional explicit built-in identifiers)",
    },
    resultShape: {
      agentIdentifiers: "string[]",
      builtInIdentifiersAcceptedExplicitly: "string[]",
      exactNameOnly: "boolean",
      supportedBackends:
        "Array<{ backend, source: attached|startable, attachable, startSupported }>",
    },
  },
  {
    name: "copilot_subagent_launch",
    description: "Launch one exact-name agent in a visible pane.",
    requestShape: {
      agentIdentifier: "string",
      task: "string",
      model: "string (optional copilot model identifier, e.g. 'gpt-5.2'; forwarded as --model)",
      backend: "cmux|zellij|tmux (optional; defaults to zellij when available, falling back to tmux)",
      awaitCompletion: "boolean (optional, default true)",
      interactive: "boolean (optional, default false — use -i flag, pane stays open)",
      fork: "{ launchId: string } | { copilotSessionId: string } (optional — fork parent session before launch)",
      closePaneOnCompletion: "boolean (optional, default true for autonomous, false for interactive)",
    },
    resultShape: {
      launchId: "string",
      backend: "string",
      paneId: "string|null",
      sessionId: "string|null",
      status: "running|success|failure|cancelled|timeout|ping (TERMINAL: success|failure|timeout|cancelled|ping; IN_FLIGHT: pending|running|interactive)",
      summary: "string|null (null when status=ping)",
      exitCode: "number|null (always 0 when status=ping)",
      ping: "{ message: string } (present only when status=ping)",
      resumePointer: "object|null",
    },
  },
  {
    name: "copilot_subagent_parallel",
    description: "Launch multiple exact-name agents in one shared backend.",
    requestShape: {
      launches:
        "Array<{ agentIdentifier: string, task: string, model?: string, backend?: cmux|zellij|tmux, awaitCompletion?: boolean, interactive?: boolean, fork?: { launchId | copilotSessionId }, closePaneOnCompletion?: boolean }>",
      backend: "cmux|zellij|tmux (optional shared backend override; defaults to zellij when available)",
      awaitCompletion: "boolean (optional shared default)",
    },
    resultShape: {
      aggregateStatus: "running|success|partial-success|failure|timeout",
      results:
        "Array<{ launchId, backend, paneId, sessionId, status, summary, exitCode, ping?, resumePointer }>",
      progressByLaunchId: "Record<string, result>",
    },
  },
  {
    name: "copilot_subagent_resume",
    description: "Resume a prior pane-backed launch from stored metadata.",
    requestShape: {
      launchId: "string (or resumeReference/resumePointer)",
      awaitCompletion: "boolean (optional, default true)",
      task: "string (optional follow-up instruction; empty string === omitted, no extra prompt delivered)",
      model: "string (optional model override; defaults to the model recorded on the original launch)",
    },
    resultShape: {
      launchId: "string",
      backend: "string|null",
      paneId: "string|null",
      sessionId: "string|null",
      status: "running|success|failure|cancelled|timeout|ping",
      summary: "string|null",
      exitCode: "number|null",
      ping: "{ message: string } (present only when status=ping)",
      resumePointer: "object|null",
    },
  },
  {
    name: "copilot_subagent_set_title",
    description: "Update a pane title or operator-facing phase label when the backend supports it.",
    requestShape: {
      title: "string",
      backend: "cmux|zellij|tmux (or resumePointer.backend)",
      paneId: "string (or resumePointer.paneId)",
    },
    resultShape: {
      ok: "boolean",
      backend: "string",
      paneId: "string",
      title: "string",
      applied: "boolean",
      source: "backend-command|runtime",
    },
  },
];

export const PUBLIC_TOOL_PARAMETER_SCHEMAS = {
  copilot_subagent_list_agents: {
    type: "object",
    additionalProperties: false,
    properties: {
      builtInIdentifiers: {
        type: "array",
        items: { type: "string" },
        description: "Optional explicit built-in identifiers to accept at launch time.",
      },
    },
  },
  copilot_subagent_launch: {
    type: "object",
    additionalProperties: false,
    properties: {
      agentIdentifier: { type: "string", description: "Exact built-in or custom agent identifier." },
      task: { type: "string", description: "Task text for the child agent." },
      model: { type: "string", description: "Optional copilot model identifier (e.g. 'gpt-5.2', 'claude-opus-4.7'). Forwarded to the child as `--model <model>`. Defaults to whatever the child's copilot installation picks." },
      backend: { type: "string", enum: ["cmux", "zellij", "tmux"], description: "Pane backend; prefer zellij when available, falling back to tmux" },
      awaitCompletion: { type: "boolean" },
      interactive: { type: "boolean", description: "Launch in interactive mode (-i flag, pane stays open)." },
      fork: {
        type: "object",
        description: "Fork a parent session before launching. Provide launchId or copilotSessionId.",
        properties: {
          launchId: { type: "string", description: "Launch ID to look up parent session." },
          copilotSessionId: { type: "string", description: "Parent copilot session UUID to fork directly." },
        },
      },
      closePaneOnCompletion: { type: "boolean", description: "Close pane after completion (default: true for autonomous, false for interactive)." },
    },
    required: ["agentIdentifier", "task"],
  },
  copilot_subagent_parallel: {
    type: "object",
    additionalProperties: false,
    properties: {
      backend: { type: "string", enum: ["cmux", "zellij", "tmux"], description: "Pane backend; prefer zellij when available, falling back to tmux" },
      awaitCompletion: { type: "boolean" },
      launches: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            agentIdentifier: { type: "string" },
            task: { type: "string" },
            model: { type: "string", description: "Optional copilot model identifier; forwarded as --model to the child." },
            backend: { type: "string", enum: ["cmux", "zellij", "tmux"], description: "Pane backend; prefer zellij when available, falling back to tmux" },
            awaitCompletion: { type: "boolean" },
            interactive: { type: "boolean", description: "Launch in interactive mode (-i flag, pane stays open)." },
            fork: {
              type: "object",
              description: "Fork a parent session before launching.",
              properties: {
                launchId: { type: "string" },
                copilotSessionId: { type: "string" },
              },
            },
            closePaneOnCompletion: { type: "boolean", description: "Close pane after completion." },
          },
          required: ["agentIdentifier", "task"],
        },
      },
    },
    required: ["launches"],
  },
  copilot_subagent_resume: {
    type: "object",
    additionalProperties: false,
    properties: {
      launchId: { type: "string" },
      resumeReference: {
        oneOf: [
          { type: "string" },
          {
            type: "object",
            additionalProperties: false,
            properties: {
              launchId: { type: "string" },
            },
          },
        ],
      },
      resumePointer: {
        type: "object",
        additionalProperties: true,
        properties: {
          launchId: { type: "string" },
        },
      },
      awaitCompletion: { type: "boolean" },
      task: {
        type: "string",
        description: "Optional follow-up instruction delivered to the resumed child as a new launch prompt. Use this to respond to a caller_ping or to extend the child's work. Extension does NOT auto-prepend prior ping context — caller crafts the full task string.",
      },
      model: { type: "string", description: "Optional copilot model identifier override. Defaults to the model recorded on the original launch manifest." },
    },
  },
  copilot_subagent_set_title: {
    type: "object",
    additionalProperties: false,
    properties: {
      backend: { type: "string", enum: ["cmux", "zellij", "tmux"], description: "Pane backend; prefer zellij when available, falling back to tmux" },
      paneId: { type: "string" },
      title: { type: "string" },
      resumePointer: {
        type: "object",
        additionalProperties: true,
        properties: {
          backend: { type: "string" },
          paneId: { type: "string" },
        },
      },
    },
    required: ["title"],
  },
};

export const CAMELCASE_HANDLER_NAMES = {
  copilot_subagent_list_agents: "copilotSubagentListAgents",
  copilot_subagent_launch: "copilotSubagentLaunch",
  copilot_subagent_parallel: "copilotSubagentParallel",
  copilot_subagent_resume: "copilotSubagentResume",
  copilot_subagent_set_title: "copilotSubagentSetTitle",
};

// D4.1: explicit allow-list of tool names that MUST be stripped from a child's
// tools[] before joinSession (parent-only tools). Filtering happens AFTER alias
// expansion in registerExtensionSession.
export const PUBLIC_SPAWNING_TOOL_NAMES = new Set([
  "copilot_subagent_launch",
  "copilot_subagent_parallel",
  "copilot_subagent_resume",
  "copilot_subagent_set_title",
  "copilot_subagent_list_agents",
  "copilotSubagentLaunch",
  "copilotSubagentParallel",
  "copilotSubagentResume",
  "copilotSubagentSetTitle",
  "copilotSubagentListAgents",
]);

// D2.1: name constant only (runtime tool def lives inline in extension.mjs).
// Used by D4.1's child-only filter set.
export const CALLER_PING_TOOL_NAME = "caller_ping";
