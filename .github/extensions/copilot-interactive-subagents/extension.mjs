import path from "node:path";

import {
  listRuntimeAgents as defaultListRuntimeAgents,
  validateAgentIdentifier as defaultValidateAgentIdentifier,
  validateAgentIdentifierAgainstCatalog,
} from "./lib/agents.mjs";
import {
  discoverLaunchBackends as defaultDiscoverLaunchBackends,
  isAttached as isAttachedBackend,
  resolveLaunchBackend as defaultResolveLaunchBackend,
} from "./lib/mux.mjs";
import { launchSingleSubagent as defaultContinueLaunch } from "./lib/launch.mjs";
import { launchParallelSubagents as defaultContinueParallelLaunch } from "./lib/parallel.mjs";
import { resumeSubagent as defaultContinueResume } from "./lib/resume.mjs";
import {
  createStateStore as buildDefaultStateStore,
  isValidLaunchId,
} from "./lib/state.mjs";
import { createStateIndex as buildDefaultStateIndex } from "./lib/state-index.mjs";
import { setSubagentTitle as defaultContinueSetTitle } from "./lib/titles.mjs";
import { normalizeNonEmptyString, uniqueStable } from "./lib/utils.mjs";
import {
  resolveCommandPath,
  createDefaultAgentLaunchCommand,
  writeSignalFile,
  defaultOpenPane,
  defaultLaunchAgentInPane,
  defaultReadPaneOutput,
  defaultReadChildSessionState,
  defaultAttachBackendForRuntime,
  defaultStartBackendForRuntime,
} from "./lib/backend-ops.mjs";

// Re-export for backward compatibility (tests import these from extension.mjs)
export { createDefaultAgentLaunchCommand, writeSignalFile };

const DEFAULT_EXPLICIT_BUILT_IN_IDENTIFIERS = ["github-copilot"];
const DEFAULT_SUPPORTED_STARTUP = {
  cmux: false,
  tmux: true,
  zellij: false,
};

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
      backend: "cmux|tmux|zellij (optional)",
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
      status: "running|success|failure|cancelled|timeout",
      summary: "string",
      exitCode: "number|null",
      resumePointer: "object|null",
    },
  },
  {
    name: "copilot_subagent_parallel",
    description: "Launch multiple exact-name agents in one shared backend.",
    requestShape: {
      launches:
        "Array<{ agentIdentifier: string, task: string, backend?: cmux|tmux|zellij, awaitCompletion?: boolean, interactive?: boolean, fork?: { launchId | copilotSessionId }, closePaneOnCompletion?: boolean }>",
      backend: "cmux|tmux|zellij (optional shared backend override)",
      awaitCompletion: "boolean (optional shared default)",
    },
    resultShape: {
      aggregateStatus: "running|success|partial-success|failure|timeout",
      results:
        "Array<{ launchId, backend, paneId, sessionId, status, summary, exitCode, resumePointer }>",
      progressByLaunchId: "Record<string, result>",
    },
  },
  {
    name: "copilot_subagent_resume",
    description: "Resume a prior pane-backed launch from stored metadata.",
    requestShape: {
      launchId: "string (or resumeReference/resumePointer)",
      awaitCompletion: "boolean (optional, default true)",
    },
    resultShape: {
      launchId: "string",
      backend: "string|null",
      paneId: "string|null",
      sessionId: "string|null",
      status: "running|success|failure|cancelled|timeout",
      summary: "string",
      exitCode: "number|null",
      resumePointer: "object|null",
    },
  },
  {
    name: "copilot_subagent_set_title",
    description: "Update a pane title or operator-facing phase label when the backend supports it.",
    requestShape: {
      title: "string",
      backend: "cmux|tmux|zellij (or resumePointer.backend)",
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
      backend: { type: "string", enum: ["cmux", "tmux", "zellij"] },
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
      backend: { type: "string", enum: ["cmux", "tmux", "zellij"] },
      awaitCompletion: { type: "boolean" },
      launches: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            agentIdentifier: { type: "string" },
            task: { type: "string" },
            backend: { type: "string", enum: ["cmux", "tmux", "zellij"] },
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
    },
  },
  copilot_subagent_set_title: {
    type: "object",
    additionalProperties: false,
    properties: {
      backend: { type: "string", enum: ["cmux", "tmux", "zellij"] },
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

const CAMELCASE_HANDLER_NAMES = {
  copilot_subagent_list_agents: "copilotSubagentListAgents",
  copilot_subagent_launch: "copilotSubagentLaunch",
  copilot_subagent_parallel: "copilotSubagentParallel",
  copilot_subagent_resume: "copilotSubagentResume",
  copilot_subagent_set_title: "copilotSubagentSetTitle",
};

function resolveServiceValue(valueOrFactory) {
  return typeof valueOrFactory === "function" ? valueOrFactory() : valueOrFactory;
}

function mergeBuiltInIdentifiers(request = {}, services = {}) {
  return uniqueStable([
    ...DEFAULT_EXPLICIT_BUILT_IN_IDENTIFIERS,
    ...(services.builtInIdentifiers ?? []),
    ...(request.builtInIdentifiers ?? []),
  ]).filter((identifier) => DEFAULT_EXPLICIT_BUILT_IN_IDENTIFIERS.includes(identifier));
}

function buildTrustedRequest(request = {}, services = {}) {
  const sessionWorkspacePath = resolveServiceValue(services.sessionWorkspacePath);
  const trustedWorkspacePath = sessionWorkspacePath ?? request.workspacePath;
  const trustedProjectRoot = resolveServiceValue(services.projectRoot) ?? request.projectRoot ?? process.cwd();

  const trusted = {
    ...request,
    ...(trustedWorkspacePath ? { workspacePath: trustedWorkspacePath } : {}),
    projectRoot: trustedProjectRoot,
    cwd: request.cwd ?? resolveServiceValue(services.cwd) ?? trustedProjectRoot,
    builtInIdentifiers: mergeBuiltInIdentifiers(request, services),
  };

  if (!request.enumerateCustomAgents && typeof services.enumerateCustomAgents === "function") {
    trusted.enumerateCustomAgents = services.enumerateCustomAgents;
  }

  return trusted;
}

function runtimeHasAdapter(request = {}, backend, operation) {
  const runtime = request.launchRuntime ?? {};
  return (
    typeof runtime[operation] === "function"
    || typeof runtime?.backends?.[backend]?.[operation] === "function"
  );
}

function supportedRuntimeBackends(request = {}) {
  const supportsRuntimeOps = (backend) => ["openPane", "launchAgentInPane", "readPaneOutput"].every(
    (operation) => runtimeHasAdapter(request, backend, operation),
  );

  return {
    cmux: supportsRuntimeOps("cmux"),
    tmux: true,
    zellij: supportsRuntimeOps("zellij"),
  };
}

function sanitizeBackendEnvironment(env = {}, runtimeSupport = {}) {
  const sanitized = { ...env };

  if (!runtimeSupport.cmux) {
    delete sanitized.CMUX_SOCKET_PATH;
  }

  if (!runtimeSupport.zellij && !isAttachedBackend("zellij", env)) {
    delete sanitized.ZELLIJ;
    delete sanitized.ZELLIJ_SESSION_NAME;
  }

  return sanitized;
}

function buildBackendRequest(request = {}, services = {}) {
  const trustedRequest = buildTrustedRequest(request, services);
  const runtimeSupport = supportedRuntimeBackends(trustedRequest);
  const env = sanitizeBackendEnvironment(
    {
      ...process.env,
      ...(services.env ?? {}),
      ...(request.env ?? {}),
    },
    runtimeSupport,
  );

  return {
    ...trustedRequest,
    env,
    runtimeSupport,
  };
}

function createArgumentFailure({
  field,
  message,
  guidance,
  code = "INVALID_ARGUMENT",
  ...extras
}) {
  return {
    ok: false,
    code,
    message,
    field,
    guidance,
    ...extras,
  };
}

const AGENT_VALIDATION_GUIDANCE = {
  AGENT_NOT_FOUND:
    "Provide the exact runtime-recognized agent identifier. Use copilot_subagent_list_agents to discover valid names.",
  AGENT_VALIDATION_UNAVAILABLE:
    "Retry agent discovery or target an explicitly allowed built-in identifier if your workflow already knows it.",
  AGENT_DISCOVERY_UNAVAILABLE:
    "Agent discovery is temporarily unavailable. Retry discovery or target an explicitly allowed built-in identifier.",
};

function addAgentValidationGuidance(result = {}, field) {
  if (result.ok !== false) {
    return result;
  }

  const guidance = AGENT_VALIDATION_GUIDANCE[result.code];
  if (guidance) {
    return { ...result, ...(field ? { field } : {}), guidance };
  }

  return result;
}

function normalizeLaunchRequest(request = {}) {
  const requestedIdentifier =
    normalizeNonEmptyString(request.requestedIdentifier) ?? normalizeNonEmptyString(request.agentIdentifier);
  const requestedBackend =
    normalizeNonEmptyString(request.requestedBackend) ?? normalizeNonEmptyString(request.backend);

  return {
    ...request,
    ...(requestedIdentifier ? { requestedIdentifier } : {}),
    ...(requestedBackend ? { requestedBackend } : {}),
  };
}

function validateLaunchRequest(request = {}, { fieldPrefix = "" } = {}) {
  const prefix = fieldPrefix ? `${fieldPrefix}.` : "";

  if (!normalizeNonEmptyString(request.requestedIdentifier)) {
    return createArgumentFailure({
      field: `${prefix}agentIdentifier`,
      message: "agentIdentifier must be a non-empty string.",
      guidance:
        "Provide the exact runtime-recognized agent identifier. Use copilot_subagent_list_agents to discover valid names.",
    });
  }

  if (!normalizeNonEmptyString(request.task)) {
    return createArgumentFailure({
      field: `${prefix}task`,
      message: "task must be a non-empty string.",
      guidance: "Provide the task text that should be sent to the target agent.",
    });
  }

  return null;
}

function normalizeParallelRequest(request = {}) {
  if (!Array.isArray(request.launches) || request.launches.length === 0) {
    return createArgumentFailure({
      field: "launches",
      message: "launches must be a non-empty array.",
      guidance: "Provide at least one { agentIdentifier, task } entry.",
    });
  }

  const normalizedLaunches = [];
  const requestedBackends = [];

  for (const [index, launch] of request.launches.entries()) {
    const normalizedEntry = normalizeLaunchRequest({
      ...launch,
      awaitCompletion: launch?.awaitCompletion ?? request.awaitCompletion,
      requestedBackend:
        launch?.requestedBackend ?? launch?.backend ?? request.requestedBackend ?? request.backend,
    });

    const validationFailure = validateLaunchRequest(normalizedEntry, {
      fieldPrefix: `launches[${index}]`,
    });
    if (validationFailure) {
      return validationFailure;
    }

    if (normalizedEntry.requestedBackend) {
      requestedBackends.push(normalizedEntry.requestedBackend);
    }

    normalizedLaunches.push({ request: normalizedEntry });
  }

  const uniqueBackends = uniqueStable(requestedBackends);
  if (uniqueBackends.length > 1) {
    return createArgumentFailure({
      code: "PARALLEL_BACKEND_CONFLICT",
      field: "launches",
      message: "Parallel launches must target the same backend when a backend is specified.",
      guidance:
        "Use one backend for the whole batch or omit backend so the extension resolves one shared backend.",
      requestedBackends: uniqueBackends,
    });
  }

  return {
    request: normalizeLaunchRequest({
      ...request,
      ...(uniqueBackends[0] ? { requestedBackend: uniqueBackends[0] } : {}),
    }),
    launches: normalizedLaunches,
  };
}

function normalizeResumeRequest(request = {}) {
  const launchId =
    normalizeNonEmptyString(request.launchId)
    ?? normalizeNonEmptyString(request.resumeReference)
    ?? normalizeNonEmptyString(request.resumeReference?.launchId)
    ?? normalizeNonEmptyString(request.resumePointer?.launchId);

  return {
    ...request,
    ...(launchId ? { launchId } : {}),
  };
}

function validateResumeRequest(request = {}) {
  if (!request.launchId) {
    return createArgumentFailure({
      field: "launchId",
      message: "launchId or a stored resume reference is required.",
      guidance: "Pass launchId directly or provide resumeReference/resumePointer with launchId.",
    });
  }

  if (!isValidLaunchId(request.launchId)) {
    return createArgumentFailure({
      field: "launchId",
      message: "launchId must use only letters, numbers, periods, underscores, and hyphens.",
      guidance: "Use the launchId returned by a prior launch or resume response.",
    });
  }

  return null;
}

function normalizeSetTitleRequest(request = {}) {
  const backend =
    normalizeNonEmptyString(request.backend)
    ?? normalizeNonEmptyString(request.requestedBackend)
    ?? normalizeNonEmptyString(request.resumePointer?.backend);
  const paneId =
    normalizeNonEmptyString(request.paneId)
    ?? normalizeNonEmptyString(request.resumePointer?.paneId);
  const title = normalizeNonEmptyString(request.title);

  return {
    ...request,
    ...(backend ? { backend, requestedBackend: backend } : {}),
    ...(paneId ? { paneId } : {}),
    ...(title ? { title } : {}),
  };
}

function validateSetTitleRequest(request = {}) {
  if (!normalizeNonEmptyString(request.title)) {
    return createArgumentFailure({
      field: "title",
      message: "title must be a non-empty string.",
      guidance: "Provide the human-readable phase or title to show in the pane.",
    });
  }

  if (!normalizeNonEmptyString(request.backend)) {
    return createArgumentFailure({
      field: "backend",
      message: "backend must be provided directly or via resumePointer.backend.",
      guidance: "Pass the backend that owns the target pane.",
    });
  }

  if (!normalizeNonEmptyString(request.paneId)) {
    return createArgumentFailure({
      field: "paneId",
      message: "paneId must be provided directly or via resumePointer.paneId.",
      guidance: "Pass the pane identifier returned from launch or resume.",
    });
  }

  return null;
}

function defaultCreateStateStore(request = {}) {
  if (!request.workspacePath) {
    return null;
  }

  return buildDefaultStateStore({
    workspacePath: request.workspacePath,
    projectRoot: request.projectRoot,
  });
}

function defaultCreateStateIndex(request = {}) {
  if (!request.projectRoot) {
    return null;
  }

  return buildDefaultStateIndex({
    projectRoot: request.projectRoot,
  });
}

async function defaultDiscoverLaunchBackendsForRuntime(request = {}, runtimeServices = {}) {
  const backendRequest = buildBackendRequest(request, runtimeServices);
  const { runtimeSupport, env } = backendRequest;

  return defaultDiscoverLaunchBackends({
    env,
    hasCommand: request.hasCommand ?? (async (command) => runtimeSupport[command] && Boolean(await resolveCommandPath(command, env))),
    startupSupport: request.startupSupport ?? {
      ...DEFAULT_SUPPORTED_STARTUP,
      tmux: runtimeSupport.tmux,
    },
  });
}

async function defaultResolveLaunchBackendForRuntime(request = {}, runtimeServices = {}) {
  const backendRequest = buildBackendRequest(request, runtimeServices);
  const { runtimeSupport, env } = backendRequest;

  return defaultResolveLaunchBackend({
    requestedBackend: backendRequest.requestedBackend,
    env,
    hasCommand: request.hasCommand ?? (async (command) => runtimeSupport[command] && Boolean(await resolveCommandPath(command, env))),
    startupSupport: request.startupSupport ?? {
      ...DEFAULT_SUPPORTED_STARTUP,
      tmux: runtimeSupport.tmux,
    },
    attach: request.attach ?? (async (backend) => defaultAttachBackendForRuntime(backend)),
    start:
      request.start
      ?? (async (backend) => defaultStartBackendForRuntime(backend, backendRequest, runtimeServices)),
  });
}

async function handleListAgents(request, services) {
  const runtimeRequest = buildTrustedRequest(request, services);
  const [agentResult, supportedBackends] = await Promise.all([
    services.listRuntimeAgents(runtimeRequest),
    services.discoverLaunchBackends(runtimeRequest),
  ]);

  if (agentResult?.ok === false) {
    return addAgentValidationGuidance({
      ...agentResult,
      supportedBackends,
    });
  }

  return {
    agentIdentifiers: agentResult.runtimeRecognizedIdentifiers,
    builtInIdentifiersAcceptedExplicitly: agentResult.builtInIdentifiersAcceptedExplicitly,
    exactNameOnly: agentResult.exactNameOnly,
    supportedBackends,
  };
}

async function handleLaunch(request, services) {
  const normalizedRequest = buildTrustedRequest(normalizeLaunchRequest(request), services);
  const validationFailure = validateLaunchRequest(normalizedRequest);
  if (validationFailure) {
    return validationFailure;
  }

  const agentValidation = addAgentValidationGuidance(
    await services.validateAgentIdentifier(normalizedRequest),
    "agentIdentifier",
  );
  if (!agentValidation.ok) {
    return agentValidation;
  }

  const backendResolution = await services.resolveLaunchBackend(normalizedRequest);
  if (!backendResolution.ok) {
    return backendResolution;
  }

  return services.continueLaunch({
    request: normalizedRequest,
    agentValidation,
    backendResolution,
    services,
  });
}

async function handleParallel(request, services) {
  const normalized = normalizeParallelRequest(request);
  if (normalized.ok === false) {
    return normalized;
  }

  const runtimeRequest = buildTrustedRequest(normalized.request, services);
  const agentCatalog = await services.listRuntimeAgents(runtimeRequest);
  const validations = normalized.launches.map((entry, index) => {
    const requestWithDefaults = buildTrustedRequest(entry.request, services);

    if (agentCatalog?.ok === false) {
      const fallbackBuiltIns = agentCatalog.builtInIdentifiersAcceptedExplicitly ?? [];
      return {
        index,
        result: addAgentValidationGuidance(
          fallbackBuiltIns.includes(requestWithDefaults.requestedIdentifier)
            ? validateAgentIdentifierAgainstCatalog({
              requestedIdentifier: requestWithDefaults.requestedIdentifier,
              builtInIdentifiers: fallbackBuiltIns,
            })
            : {
              ok: false,
              code: "AGENT_VALIDATION_UNAVAILABLE",
              requestedIdentifier: requestWithDefaults.requestedIdentifier,
              availableIdentifiers: fallbackBuiltIns,
              message: agentCatalog.message,
            },
          `launches[${index}].agentIdentifier`,
        ),
      };
    }

    return {
      index,
      result: addAgentValidationGuidance(
        validateAgentIdentifierAgainstCatalog({
          requestedIdentifier: requestWithDefaults.requestedIdentifier,
          runtimeRecognizedIdentifiers: agentCatalog.runtimeRecognizedIdentifiers,
          builtInIdentifiers: agentCatalog.builtInIdentifiersAcceptedExplicitly,
        }),
        `launches[${index}].agentIdentifier`,
      ),
    };
  });

  const failedValidation = validations.find(({ result }) => result.ok === false);
  if (failedValidation) {
    return failedValidation.result;
  }

  const backendResolution = await services.resolveLaunchBackend(runtimeRequest);
  if (!backendResolution.ok) {
    return backendResolution;
  }

  return services.continueParallelLaunch({
    request: runtimeRequest,
    launches: normalized.launches.map((entry, index) => ({
      ...entry,
      request: buildTrustedRequest(entry.request, services),
      agentValidation: validations[index].result,
    })),
    backendResolution,
    services,
  });
}

async function handleResume(request, services) {
  const normalizedRequest = buildTrustedRequest(normalizeResumeRequest(request), services);
  const validationFailure = validateResumeRequest(normalizedRequest);
  if (validationFailure) {
    return validationFailure;
  }

  return services.continueResume({
    request: normalizedRequest,
    services,
  });
}

async function handleSetTitle(request, services) {
  const normalizedRequest = buildTrustedRequest(normalizeSetTitleRequest(request), services);
  const validationFailure = validateSetTitleRequest(normalizedRequest);
  if (validationFailure) {
    return validationFailure;
  }

  return services.continueSetTitle({
    request: normalizedRequest,
    services,
  });
}

function buildHandlerAliases(handlers) {
  return Object.fromEntries(
    Object.entries(CAMELCASE_HANDLER_NAMES).map(([namespacedName, camelCaseName]) => [
      camelCaseName,
      handlers[namespacedName],
    ]),
  );
}

function toToolResult(result) {
  return {
    textResultForLlm: JSON.stringify(result, null, 2),
    resultType: result?.ok === false ? "failure" : "success",
  };
}

const DEFAULT_TOOL_TIMEOUT_MS = 90_000;

async function withToolTimeout(toolName, handler, args) {
  let timer;
  try {
    return await Promise.race([
      handler(args),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Tool ${toolName} timed out after ${DEFAULT_TOOL_TIMEOUT_MS}ms`)),
          DEFAULT_TOOL_TIMEOUT_MS,
        );
        if (timer.unref) timer.unref();
      }),
    ]);
  } catch (error) {
    return toToolResult({
      ok: false,
      code: "TOOL_TIMEOUT",
      message: error instanceof Error ? error.message : String(error),
      guidance: "The tool call timed out. Retry with awaitCompletion: false, or investigate the tmux/backend state.",
    });
  } finally {
    clearTimeout(timer);
  }
}

function buildSdkTools(handlers) {
  const definitionsByName = Object.fromEntries(
    PUBLIC_TOOL_DEFINITIONS.map((definition) => [definition.name, definition]),
  );

  const namespacedTools = PUBLIC_TOOL_NAMES.map((toolName) => ({
    name: toolName,
    description: definitionsByName[toolName].description,
    parameters: PUBLIC_TOOL_PARAMETER_SCHEMAS[toolName],
    handler: async (args) => withToolTimeout(toolName, async (a) => toToolResult(await handlers[toolName](a ?? {})), args),
  }));

  const aliasTools = Object.entries(CAMELCASE_HANDLER_NAMES).map(([toolName, alias]) => ({
    name: alias,
    description: `${definitionsByName[toolName].description} (camelCase compatibility alias)`,
    parameters: PUBLIC_TOOL_PARAMETER_SCHEMAS[toolName],
    handler: async (args) => withToolTimeout(alias, async (a) => toToolResult(await handlers[toolName](a ?? {})), args),
  }));

  return [...namespacedTools, ...aliasTools];
}

function applyDefaultServiceFactories(services, overrides = {}) {
  const factories = {
    listRuntimeAgents: () => (request = {}) => defaultListRuntimeAgents(buildTrustedRequest(request, services)),
    validateAgentIdentifier: () => (request = {}) =>
      defaultValidateAgentIdentifier(buildTrustedRequest(request, services)),
    discoverLaunchBackends: () => (request = {}) =>
      defaultDiscoverLaunchBackendsForRuntime(request, services),
    resolveLaunchBackend: () => (request = {}) =>
      defaultResolveLaunchBackendForRuntime(request, services),
    createStateStore: () => (request = {}) => defaultCreateStateStore(buildTrustedRequest(request, services)),
    createStateIndex: () => (request = {}) => defaultCreateStateIndex(buildTrustedRequest(request, services)),
    openPane: () => (context) => defaultOpenPane({ ...context, runtimeServices: services }),
    launchAgentInPane: () => (context) =>
      defaultLaunchAgentInPane({ ...context, runtimeServices: services }),
    readPaneOutput: () => (context) =>
      defaultReadPaneOutput({ ...context, runtimeServices: services }),
    readChildSessionState: () => (context) =>
      defaultReadChildSessionState({ ...context, runtimeServices: services }),
    continueLaunch: () => defaultContinueLaunch,
    continueParallelLaunch: () => defaultContinueParallelLaunch,
    continueResume: () => defaultContinueResume,
    continueSetTitle: () => defaultContinueSetTitle,
  };

  for (const [name, build] of Object.entries(factories)) {
    if (!Object.hasOwn(overrides, name)) {
      services[name] = build();
    }
  }
}

export async function createExtensionHandlers(overrides = {}) {
  const services = {
    builtInIdentifiers: DEFAULT_EXPLICIT_BUILT_IN_IDENTIFIERS,
    ...overrides,
  };
  applyDefaultServiceFactories(services, overrides);

  const handlers = {
    async copilot_subagent_list_agents(request = {}) {
      return handleListAgents(request, services);
    },
    async copilot_subagent_launch(request = {}) {
      return handleLaunch(request, services);
    },
    async copilot_subagent_parallel(request = {}) {
      return handleParallel(request, services);
    },
    async copilot_subagent_resume(request = {}) {
      return handleResume(request, services);
    },
    async copilot_subagent_set_title(request = {}) {
      return handleSetTitle(request, services);
    },
  };

  return {
    ...handlers,
    ...buildHandlerAliases(handlers),
  };
}

export async function registerExtensionSession(options = {}) {
  const joinSession =
    options.joinSession ?? (await import("@github/copilot-sdk/extension")).joinSession;
  let session;
  let enumerationCircuitOpen = false;
  const handlersFactory = options.createHandlers ?? createExtensionHandlers;
  const handlers = await handlersFactory({
    sessionWorkspacePath: () => session?.workspacePath,
    projectRoot: () => session?.workspacePath ?? process.cwd(),
    cwd: () => session?.workspacePath ?? process.cwd(),
    enumerateCustomAgents: async () => {
      if (enumerationCircuitOpen) {
        return [];
      }
      try {
        const result = await session.rpc.agent.list();
        return result.agents ?? result.availableAgents ?? [];
      } catch {
        enumerationCircuitOpen = true;
        return [];
      }
    },
  });

  const tools = buildSdkTools(handlers);

  if (process.env.COPILOT_SUBAGENT_SESSION_ID) {
    tools.push({
      name: "subagent_done",
      description:
        "Call when you have completed your task. Put your final summary in your last message BEFORE calling this tool. Your session will end after this call.",
      parameters: {},
      handler: () => {
        writeSignalFile({
          copilotSessionId: process.env.COPILOT_SUBAGENT_SESSION_ID,
          launchId: process.env.COPILOT_SUBAGENT_LAUNCH_ID,
        });
        return { ok: true, message: "Task marked complete. Session ending." };
      },
    });
  }

  session = await joinSession({ tools });

  return session;
}

export default createExtensionHandlers;

if (process.env.SESSION_ID) {
  await registerExtensionSession();
}
