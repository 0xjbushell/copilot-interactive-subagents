import { execFile } from "node:child_process";
import { access, constants as fsConstants, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { mkdirSync as defaultMkdirSync, writeFileSync as defaultWriteFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  listRuntimeAgents as defaultListRuntimeAgents,
  validateAgentIdentifier as defaultValidateAgentIdentifier,
  validateAgentIdentifierAgainstCatalog,
} from "./lib/agents.mjs";
import {
  discoverLaunchBackends as defaultDiscoverLaunchBackends,
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

const execFileAsync = promisify(execFile);
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

function normalizeNonEmptyString(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function uniqueStable(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function encodeBase64(value) {
  return Buffer.from(String(value ?? ""), "utf8").toString("base64");
}

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

  return {
    ...request,
    ...(trustedWorkspacePath ? { workspacePath: trustedWorkspacePath } : {}),
    projectRoot: trustedProjectRoot,
    cwd: request.cwd ?? resolveServiceValue(services.cwd) ?? trustedProjectRoot,
    builtInIdentifiers: mergeBuiltInIdentifiers(request, services),
    ...(request.enumerateCustomAgents
      ? {}
      : typeof services.enumerateCustomAgents === "function"
        ? { enumerateCustomAgents: services.enumerateCustomAgents }
        : {}),
  };
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

function isAttachedBackend(backend, env = {}) {
  switch (backend) {
    case "cmux":
      return Boolean(env.CMUX_SOCKET_PATH);
    case "tmux":
      return Boolean(env.TMUX);
    case "zellij":
      return Boolean(env.ZELLIJ || env.ZELLIJ_SESSION_NAME);
    default:
      return false;
  }
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

function listCommandSearchPaths(env = process.env) {
  const directories = new Set();
  const pathValue = env.PATH;

  if (typeof pathValue === "string") {
    for (const directory of pathValue.split(path.delimiter)) {
      if (directory) {
        directories.add(directory);
      }
    }
  }

  const userName = env.USER ?? env.LOGNAME ?? null;
  if (userName) {
    directories.add(path.join("/etc/profiles/per-user", userName, "bin"));
  }

  directories.add("/run/current-system/sw/bin");
  directories.add("/usr/local/bin");
  directories.add("/usr/bin");
  directories.add("/bin");

  return [...directories];
}

async function resolveCommandPath(commandName, env = process.env) {
  if (path.isAbsolute(commandName)) {
    try {
      await access(commandName, fsConstants.X_OK);
      return commandName;
    } catch {
      return null;
    }
  }

  for (const directory of listCommandSearchPaths(env)) {
    const candidate = path.join(directory, commandName);

    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {}
  }

  return null;
}

async function hasCommandInPath(commandName, env = process.env) {
  if (await resolveCommandPath(commandName, env)) {
    return true;
  }

  return false;
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

function addAgentValidationGuidance(result = {}, field) {
  if (result.ok !== false) {
    return result;
  }

  if (result.code === "AGENT_NOT_FOUND") {
    return {
      ...result,
      ...(field ? { field } : {}),
      guidance:
        "Provide the exact runtime-recognized agent identifier. Use copilot_subagent_list_agents to discover valid names.",
    };
  }

  if (result.code === "AGENT_VALIDATION_UNAVAILABLE") {
    return {
      ...result,
      ...(field ? { field } : {}),
      guidance:
        "Retry agent discovery or target an explicitly allowed built-in identifier if your workflow already knows it.",
    };
  }

  if (result.code === "AGENT_DISCOVERY_UNAVAILABLE") {
    return {
      ...result,
      ...(field ? { field } : {}),
      guidance:
        "Agent discovery is temporarily unavailable. Retry discovery or target an explicitly allowed built-in identifier.",
    };
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

function createRuntimeUnavailableError(operation, backend) {
  const error = new Error(
    `Launch runtime operation ${operation} is not configured for backend ${backend}.`,
  );
  error.code = "LAUNCH_RUNTIME_UNAVAILABLE";
  return error;
}

function resolveLaunchRuntimeOperation(request = {}, _runtimeServices = {}, backend, operation) {
  const runtime = request.launchRuntime ?? {};

  if (typeof runtime[operation] === "function") {
    return runtime[operation];
  }

  if (typeof runtime?.backends?.[backend]?.[operation] === "function") {
    return runtime.backends[backend][operation];
  }

  return null;
}

async function runDefaultBackendCommand({ request, runtimeServices = {}, backend, args }) {
  const runner = request.runBackendCommand ?? runtimeServices.runBackendCommand;
  const env = {
    ...process.env,
    ...(request.env ?? {}),
  };
  for (const key of Object.keys(env)) {
    if (env[key] == null) {
      delete env[key];
    }
  }
  const cwd = request.cwd ?? process.cwd();
  if (typeof runner === "function") {
    return runner({ command: backend, args, cwd, env, request });
  }

  const command = (await resolveCommandPath(backend, env)) ?? backend;
  const { stdout = "", stderr = "" } = await execFileAsync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });

  return { stdout, stderr };
}

function defaultTmuxSessionName(request = {}) {
  const suffix = path.basename(request.projectRoot ?? process.cwd()).replace(/[^A-Za-z0-9_-]+/g, "-");
  return `copilot-subagents-${suffix || "session"}`.slice(0, 64);
}

function zellijPaneId(paneId) {
  return String(paneId).startsWith("pane:") ? String(paneId).slice("pane:".length) : String(paneId);
}

async function createPrivateTempFile(prefix, fileName) {
  const directoryPath = await mkdtemp(path.join(tmpdir(), `${prefix}-`));
  return {
    directoryPath,
    filePath: path.join(directoryPath, fileName),
  };
}

async function waitForFileText(filePath, {
  timeoutMs = 5000,
  intervalMs = 25,
} = {}) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const text = await readFile(filePath, "utf8");
      if (text.trim()) {
        return text;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  const error = new Error(`Timed out waiting for zellij pane metadata at ${filePath}.`);
  error.code = "LAUNCH_RUNTIME_UNAVAILABLE";
  throw error;
}

function getPaneTarget(_backend, paneId) {
  return paneId;
}

function withZellijPaneRequest(request = {}, paneId) {
  if (!paneId) {
    return request;
  }

  return {
    ...request,
    env: {
      ...(request.env ?? {}),
      ZELLIJ_PANE_ID: zellijPaneId(paneId),
    },
  };
}

function withoutZellijPaneRequest(request = {}) {
  return {
    ...request,
    env: {
      ...(request.env ?? {}),
      ZELLIJ_PANE_ID: null,
    },
  };
}

function getPaneCaptureArgs(backend, paneId, outputPath) {
  switch (backend) {
    case "tmux":
      return ["capture-pane", "-p", "-t", paneId, "-S", "-200"];
    case "zellij":
      return ["action", "dump-screen", outputPath];
    default:
      throw createRuntimeUnavailableError("readPaneOutput", backend);
  }
}

function buildOpenPaneArgs(backend, context = {}) {
  const orientation = context.layout?.orientation;
  switch (backend) {
    case "tmux":
      return [
        "split-window",
        // -h = horizontal split (pane appears right), -v = vertical (pane appears below)
        orientation === "horizontal" ? "-v" : "-h",
        ...(context.launchAction === "start" && context.backendSessionName ? ["-t", context.backendSessionName] : []),
        "-P",
        "-F",
        "#{pane_id}",
      ];
    case "zellij":
      return [
        "action",
        "new-pane",
        "--direction",
        orientation === "horizontal" ? "down" : "right",
        "--name",
        context.agentIdentifier ?? "copilot-subagent",
      ];
    default:
      throw createRuntimeUnavailableError("openPane", backend);
  }
}

function extractPaneId(stdout = "") {
  const paneId = String(stdout).trim().split(/\r?\n/).filter(Boolean).at(-1);
  return paneId || null;
}

export function createDefaultAgentLaunchCommand(request = {}, runtimeServices = {}, { agentIdentifier, task, copilotSessionId, interactive, backend }) {
  const createAgentLaunchCommand =
    request.createAgentLaunchCommand ?? runtimeServices.createAgentLaunchCommand;
  if (typeof createAgentLaunchCommand === "function") {
    return createAgentLaunchCommand({ agentIdentifier, task, copilotSessionId, interactive, backend });
  }

  const copilotBinary = request.copilotBinary ?? runtimeServices.copilotBinary ?? "copilot";
  const agentIdentifierB64 = encodeBase64(agentIdentifier);
  const taskB64 = encodeBase64(task ?? "");
  const useDefaultCopilotAgent = agentIdentifier === "github-copilot";
  const promptFlag = interactive ? "-i" : "-p";
  const suppressStats = interactive ? "" : ' "-s",';
  const resumeFlag = copilotSessionId ? `"--resume=${copilotSessionId}",` : "";
  const runnerScript = [
    'const { spawnSync } = require("node:child_process");',
    'const decode = (name) => Buffer.from(process.env[name] || "", "base64").toString("utf8");',
    useDefaultCopilotAgent
      ? `const args = [${resumeFlag} "${promptFlag}", decode("COPILOT_SUBAGENT_TASK_B64"), "--allow-all-tools", "--allow-all-paths", "--allow-all-urls", "--no-ask-user",${suppressStats}];`
      : `const args = [${resumeFlag} "--agent", decode("COPILOT_SUBAGENT_AGENT_B64"), "${promptFlag}", decode("COPILOT_SUBAGENT_TASK_B64"), "--allow-all-tools", "--allow-all-paths", "--allow-all-urls", "--no-ask-user",${suppressStats}];`,
    `const result = spawnSync(${JSON.stringify(copilotBinary)}, args, { stdio: "inherit" });`,
    'const code = Number.isInteger(result.status) ? result.status : 1;',
    'process.stdout.write("\\n__SUBAGENT_DONE_" + code + "__\\n");',
    'process.exit(code);',
  ].join("");

  const envParts = [
    `COPILOT_SUBAGENT_AGENT_B64=${shellEscape(agentIdentifierB64)}`,
    `COPILOT_SUBAGENT_TASK_B64=${shellEscape(taskB64)}`,
  ];
  if (copilotSessionId) {
    envParts.push(`COPILOT_SUBAGENT_SESSION_ID=${shellEscape(copilotSessionId)}`);
  }
  if (request.launchId) {
    envParts.push(`COPILOT_SUBAGENT_LAUNCH_ID=${shellEscape(request.launchId)}`);
  }
  return [...envParts, `node -e ${shellEscape(runnerScript)}`].join(" ");
}

export function writeSignalFile({ copilotSessionId, launchId, stateDir, services = {} } = {}) {
  const mkdirSync = services.mkdirSync ?? defaultMkdirSync;
  const writeFileSync = services.writeFileSync ?? defaultWriteFileSync;
  const now = services.now ?? Date.now;
  const baseDir = stateDir ?? ".copilot-interactive-subagents";
  const signalDir = path.join(baseDir, "done");
  mkdirSync(signalDir, { recursive: true });
  writeFileSync(path.join(signalDir, copilotSessionId), `${now()}|${launchId ?? "unknown"}`);
}

async function defaultOpenPane({ backend, request, runtimeServices = {}, ...context }) {
  const openPane = resolveLaunchRuntimeOperation(request, runtimeServices, backend, "openPane");
  if (openPane) {
    return openPane({ backend, request, ...context });
  }

  const result = await runDefaultBackendCommand({
    request,
    runtimeServices,
    backend,
    args: buildOpenPaneArgs(backend, context),
  });
  let paneId = extractPaneId(result?.stdout);
  if (backend === "zellij" && (!paneId || !/^pane:\d+$/.test(paneId))) {
    const { directoryPath, filePath: paneIdPath } = await createPrivateTempFile(
      "copilot-subagents-zellij-pane",
      "pane-id.txt",
    );
    const commandFilePath = path.join(directoryPath, "command.sh");
    const commandReadyPath = path.join(directoryPath, "command-ready");
    const exitFilePath = path.join(directoryPath, "exit-code");
    try {
      const direction = context.layout?.orientation === "horizontal" ? "down" : "right";
      const timeoutSecs = 120;
      const captureScript = [
        `echo "$ZELLIJ_PANE_ID" > ${shellEscape(paneIdPath)}`,
        `CMDFILE=${shellEscape(commandFilePath)}`,
        `READY=${shellEscape(commandReadyPath)}`,
        `EXITF=${shellEscape(exitFilePath)}`,
        `WAITED=0`,
        `while [ ! -f "$READY" ]; do sleep 0.2; WAITED=$((WAITED+1)); if [ "$WAITED" -ge ${timeoutSecs * 5} ]; then echo "subagent: timed out waiting for command"; exit 1; fi; done`,
        `bash "$CMDFILE"`,
        `echo $? > "$EXITF"`,
      ].join(" && ");
      await runDefaultBackendCommand({
        request: withoutZellijPaneRequest(request),
        runtimeServices,
        backend,
        args: ["run", "--direction", direction, "--name", context.agentIdentifier ?? "copilot-subagent", "--", "bash", "-c", captureScript],
      });
      const capturedPaneId = (await waitForFileText(paneIdPath)).trim();
      if (capturedPaneId) {
        paneId = `pane:${capturedPaneId}`;
      }
    } catch (error) {
      await rm(directoryPath, { force: true, recursive: true }).catch(() => {});
      throw error;
    }
    // Don't clean up directoryPath yet — launchAgentInPane needs commandFilePath
    return {
      paneId,
      visible: true,
      zellijCommandFile: commandFilePath,
      zellijCommandReady: commandReadyPath,
      zellijExitFile: exitFilePath,
      zellijTempDir: directoryPath,
    };
  }

  if (!paneId) {
    throw createRuntimeUnavailableError("openPane", backend);
  }

  return {
    paneId,
    visible: true,
  };
}

async function defaultLaunchAgentInPane({ backend, request, runtimeServices = {}, ...context }) {
  const launchAgentInPane = resolveLaunchRuntimeOperation(
    request,
    runtimeServices,
    backend,
    "launchAgentInPane",
  );
  if (launchAgentInPane) {
    return launchAgentInPane({ backend, request, ...context });
  }

  const command = createDefaultAgentLaunchCommand(request, runtimeServices, context);
  const paneTarget = getPaneTarget(backend, context.paneId);

  switch (backend) {
    case "tmux":
      await runDefaultBackendCommand({
        request,
        runtimeServices,
        backend,
        args: ["select-pane", "-t", paneTarget],
      });
      await runDefaultBackendCommand({
        request,
        runtimeServices,
        backend,
        args: ["send-keys", "-t", paneTarget, "-l", command],
      });
      await runDefaultBackendCommand({
        request,
        runtimeServices,
        backend,
        args: ["send-keys", "-t", paneTarget, "Enter"],
      });
      return {
        sessionId: request.sessionId ?? null,
      };
    case "zellij":
      if (context.zellijCommandFile) {
        const commandContent = command + "\n";
        const stagingPath = context.zellijCommandFile + ".tmp";
        await writeFile(stagingPath, commandContent, { mode: 0o600 });
        await rename(stagingPath, context.zellijCommandFile);
        await writeFile(context.zellijCommandReady, "ready\n", { mode: 0o600 });
        // Temp dir cleanup is managed by the caller (runChildLaunch) since
        // the exit-code file in the same dir is needed for monitoring.
      } else {
        await runDefaultBackendCommand({
          request: withZellijPaneRequest(request, context.paneId),
          runtimeServices,
          backend,
          args: ["action", "write-chars", command],
        });
        await runDefaultBackendCommand({
          request: withZellijPaneRequest(request, context.paneId),
          runtimeServices,
          backend,
          args: ["action", "write", "13"],
        });
      }
      return {
        sessionId: request.sessionId ?? null,
      };
    default:
      throw createRuntimeUnavailableError("launchAgentInPane", backend);
  }
}

async function defaultReadPaneOutput({ backend, request, runtimeServices = {}, ...context }) {
  const readPaneOutput = resolveLaunchRuntimeOperation(
    request,
    runtimeServices,
    backend,
    "readPaneOutput",
  );
  if (readPaneOutput) {
    return readPaneOutput({ backend, request, ...context });
  }

  if (backend === "zellij") {
    // File-based completion: capture script writes exit code to a file
    // after copilot finishes. This avoids dump-screen which can't target
    // specific panes in zellij.
    if (context.zellijExitFile) {
      try {
        const exitCodeStr = await readFile(context.zellijExitFile, "utf8");
        const exitCode = parseInt(exitCodeStr.trim(), 10);
        return { output: `__SUBAGENT_DONE_${isNaN(exitCode) ? 1 : exitCode}__` };
      } catch {
        return { output: "" }; // Exit file not yet written — still running
      }
    }
    // Fallback: dump-screen (unreliable for pane targeting, kept for
    // custom openPane implementations that don't use command-file IPC)
    const { directoryPath, filePath: outputPath } = await createPrivateTempFile(
      "copilot-subagents-zellij-screen",
      "screen.txt",
    );
    const args = getPaneCaptureArgs(backend, context.paneId, outputPath);
    try {
      await runDefaultBackendCommand({
        request: withZellijPaneRequest(request, context.paneId),
        runtimeServices,
        backend,
        args,
      });
      const output = await readFile(outputPath, "utf8");
      return { output };
    } finally {
      await rm(directoryPath, { force: true, recursive: true }).catch(() => {});
    }
  }

  return runDefaultBackendCommand({
    request,
    runtimeServices,
    backend,
    args: getPaneCaptureArgs(backend, context.paneId),
  }).then((result) => ({
    ...result,
    output: result?.output ?? result?.stdout ?? "",
  }));
}

async function defaultReadChildSessionState({ backend, request, runtimeServices = {}, ...context }) {
  const readChildSessionState = resolveLaunchRuntimeOperation(
    request,
    runtimeServices,
    backend,
    "readChildSessionState",
  );
  if (!readChildSessionState) {
    return null;
  }

  return readChildSessionState({ backend, request, ...context });
}

async function defaultDiscoverLaunchBackendsForRuntime(request = {}, runtimeServices = {}) {
  const backendRequest = buildBackendRequest(request, runtimeServices);
  const { runtimeSupport, env } = backendRequest;

  return defaultDiscoverLaunchBackends({
    env,
    hasCommand: request.hasCommand ?? (async (command) => runtimeSupport[command] && hasCommandInPath(command, env)),
    startupSupport: request.startupSupport ?? {
      ...DEFAULT_SUPPORTED_STARTUP,
      tmux: runtimeSupport.tmux,
    },
  });
}

async function defaultAttachBackendForRuntime(backend) {
  switch (backend) {
    case "tmux":
    case "zellij":
      return {};
    default:
      throw createRuntimeUnavailableError("attach", backend);
  }
}

async function defaultStartBackendForRuntime(backend, request, runtimeServices = {}) {
  if (backend !== "tmux") {
    throw createRuntimeUnavailableError("start", backend);
  }

  const sessionName = request.tmuxSessionName ?? runtimeServices.tmuxSessionName ?? defaultTmuxSessionName(request);
  await runDefaultBackendCommand({
    request,
    runtimeServices,
    backend,
    args: ["new-session", "-A", "-d", "-s", sessionName],
  });
  return { sessionName };
}

async function defaultResolveLaunchBackendForRuntime(request = {}, runtimeServices = {}) {
  const backendRequest = buildBackendRequest(request, runtimeServices);
  const { runtimeSupport, env } = backendRequest;

  return defaultResolveLaunchBackend({
    requestedBackend: backendRequest.requestedBackend,
    env,
    hasCommand: request.hasCommand ?? (async (command) => runtimeSupport[command] && hasCommandInPath(command, env)),
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
