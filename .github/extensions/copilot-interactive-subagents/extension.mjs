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
import { createStateStore as buildDefaultStateStore } from "./lib/state.mjs";
import { createStateIndex as buildDefaultStateIndex } from "./lib/state-index.mjs";
import { setSubagentTitle as defaultContinueSetTitle } from "./lib/titles.mjs";
import { uniqueStable } from "./lib/utils.mjs";
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
import { writeExitSidecar, resolveStateDir } from "./lib/exit-sidecar.mjs";
import {
  PUBLIC_TOOL_NAMES,
  PUBLIC_TOOL_DEFINITIONS,
  PUBLIC_TOOL_PARAMETER_SCHEMAS,
  CAMELCASE_HANDLER_NAMES,
  PUBLIC_SPAWNING_TOOL_NAMES,
} from "./lib/tool-schemas.mjs";
import {
  normalizeLaunchRequest,
  validateLaunchRequest,
  normalizeParallelRequest,
  normalizeResumeRequest,
  validateResumeRequest,
  normalizeSetTitleRequest,
  validateSetTitleRequest,
  addAgentValidationGuidance,
} from "./lib/validation.mjs";

// Re-export for backward compatibility (tests import these from extension.mjs)
export { createDefaultAgentLaunchCommand, writeSignalFile };
export { PUBLIC_TOOL_NAMES, PUBLIC_TOOL_DEFINITIONS, PUBLIC_TOOL_PARAMETER_SCHEMAS };

const DEFAULT_EXPLICIT_BUILT_IN_IDENTIFIERS = ["github-copilot"];
const DEFAULT_SUPPORTED_STARTUP = {
  cmux: false,
  tmux: true,
  zellij: false,
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

export async function withToolTimeout(toolName, handler, args) {
  let timer;
  let timedOut = false;
  try {
    return await Promise.race([
      handler(args),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => {
            timedOut = true;
            reject(new Error(`Tool ${toolName} timed out after ${DEFAULT_TOOL_TIMEOUT_MS}ms`));
          },
          DEFAULT_TOOL_TIMEOUT_MS,
        );
        if (timer.unref) timer.unref();
      }),
    ]);
  } catch (error) {
    if (!timedOut) {
      // Non-timeout error: propagate with original code intact so SDK and
      // tests see typed errors (e.g. MANIFEST_VERSION_UNSUPPORTED).
      throw error;
    }
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

function buildChildToolServices(options) {
  // The seam is fs-shaped (writeFileSync/mkdirSync/renameSync/now) for
  // exit-sidecar IO, NOT the handler-factory shape. Tests inject overrides;
  // production falls through to module defaults inside writeExitSidecar.
  return options.childToolServices ?? {};
}

function resolveChildStateDir() {
  // D1.1's contract: parent ALWAYS exports COPILOT_SUBAGENT_STATE_DIR alongside
  // COPILOT_SUBAGENT_LAUNCH_ID. Fail loud on the fallback path so a silently
  // misrouted sidecar doesn't drop on the floor.
  const fromEnv = process.env.COPILOT_SUBAGENT_STATE_DIR;
  if (fromEnv) return fromEnv;
  if (process.env.COPILOT_SUBAGENT_LAUNCH_ID) {
    const error = new Error(
      "COPILOT_SUBAGENT_LAUNCH_ID is set but COPILOT_SUBAGENT_STATE_DIR is not. " +
        "Parent must export both (D1.1 contract). Aborting child tool to prevent silent IPC loss.",
    );
    error.code = "STATE_DIR_MISSING";
    throw error;
  }
  return resolveStateDir({ projectRoot: process.cwd() });
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

  let tools = buildSdkTools(handlers);

  // D4.1: strip parent-only spawning tools when running inside a child session.
  // Filter happens AFTER alias expansion so camelCase aliases are also caught.
  if (process.env.COPILOT_SUBAGENT_LAUNCH_ID) {
    tools = tools.filter((tool) => !PUBLIC_SPAWNING_TOOL_NAMES.has(tool.name));
  }

  const childToolServices = buildChildToolServices(options);

  if (process.env.COPILOT_SUBAGENT_LAUNCH_ID) {
    tools.push({
      name: "caller_ping",
      description:
        "Pause your work and notify the parent caller that you need input. After calling this, end your turn — your session will terminate and the parent will resume you with a follow-up task.",
      parameters: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "What you need from the parent (a question, a blocker, or a status update).",
          },
        },
        required: ["message"],
      },
      handler: ({ message } = {}) => {
        const launchId = process.env.COPILOT_SUBAGENT_LAUNCH_ID;
        try {
          writeExitSidecar({
            launchId,
            type: "ping",
            message,
            stateDir: resolveChildStateDir(),
            services: childToolServices,
          });
        } catch (err) {
          // Best-effort shutdown contract (spec line 163): the model relies on
          // the verbatim return string to end its turn. On IO failure surface
          // the error in stderr but DO NOT fail the tool — otherwise the model
          // keeps calling tools instead of yielding.
          process.stderr.write(`caller_ping: sidecar write failed: ${err?.message ?? err}\n`);
        }
        return {
          ok: true,
          message: "Ping sent. Session is terminating. Do not call further tools. End your turn.",
        };
      },
    });
  }

  if (process.env.COPILOT_SUBAGENT_LAUNCH_ID) {
    tools.push({
      name: "subagent_done",
      description:
        "Call when you have completed your task. Optionally pass a summary; otherwise put your final summary in your last message before calling. Session ends after this call.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Optional final summary text." },
        },
      },
      handler: ({ summary } = {}) => {
        const trimmed = (typeof summary === "string" && summary.trim().length > 0) ? summary : null;
        writeExitSidecar({
          launchId: process.env.COPILOT_SUBAGENT_LAUNCH_ID,
          type: "done",
          summary: trimmed,
          exitCode: 0,
          stateDir: resolveChildStateDir(),
          services: childToolServices,
        });
        return {
          ok: true,
          message: "Session is terminating. Do not call further tools. End your turn.",
        };
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
