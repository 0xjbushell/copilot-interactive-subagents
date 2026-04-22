export const SUPPORTED_BACKENDS = ["cmux", "zellij", "tmux"];

import { spawnSync as defaultSpawnSync } from "node:child_process";
import { stripPanePrefix } from "./utils.mjs";

export function isAttached(backend, env = {}) {
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

const BACKEND_GUIDANCE = {
  cmux: "Start Copilot inside cmux or install/configure cmux startup support.",
  tmux: "Start Copilot inside tmux or install/configure tmux startup support.",
  zellij: "Start Copilot inside zellij or install/configure zellij startup support.",
};
const DEFAULT_GUIDANCE = "Install or configure cmux, tmux, or zellij to enable pane-backed launches.";

function backendGuidance(backend) {
  return BACKEND_GUIDANCE[backend] ?? DEFAULT_GUIDANCE;
}

function generalGuidance(backends = SUPPORTED_BACKENDS) {
  if (backends.length === 1) {
    return backendGuidance(backends[0]);
  }

  return "Install or configure cmux, tmux, or zellij to enable pane-backed launches.";
}

function createBackendFailure({
  code = "BACKEND_UNAVAILABLE",
  requestedBackend,
  detectedBackend,
  message,
  availableBackends = [],
}) {
  const focusedBackend = requestedBackend ?? detectedBackend;

  return {
    ok: false,
    code,
    requestedBackend,
    detectedBackend,
    availableBackends,
    guidance: focusedBackend
      ? backendGuidance(focusedBackend)
      : generalGuidance(availableBackends.map(({ backend }) => backend)),
    setupGuidance: focusedBackend
      ? backendGuidance(focusedBackend)
      : generalGuidance(availableBackends.map(({ backend }) => backend)),
    ...(message ? { message } : {}),
  };
}

function createBackendSuccess(selectedBackend, action, details) {
  return {
    ok: true,
    selectedBackend,
    action,
    manualSetupRequired: false,
    ...details,
  };
}

function formatFailureMessage(failures) {
  return failures.map(({ backend, error }) => `${backend}: ${error}`).join("; ");
}

async function tryBackends(backends, executor, shouldAttempt, action) {
  const failures = [];

  for (const backend of backends) {
    if (!shouldAttempt(backend)) {
      continue;
    }

    try {
      return createBackendSuccess(backend, action, await executor(backend));
    } catch (error) {
      failures.push({
        backend,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { ok: false, failures };
}

async function resolveRequestedBackend({
  requestedBackend,
  env,
  hasCommand,
  startupSupport,
  attach,
  start,
}) {
  const attachedResolution = await tryBackends(
    [requestedBackend],
    attach,
    (b) => isAttached(b, env) && hasCommand(b),
    "attach",
  );
  if (attachedResolution.ok) {
    return attachedResolution;
  }

  if (attachedResolution.failures.length > 0) {
    return createBackendFailure({
      requestedBackend,
      detectedBackend: requestedBackend,
      message: formatFailureMessage(attachedResolution.failures),
    });
  }

  if (!hasCommand(requestedBackend)) {
    return createBackendFailure({
      code: "BACKEND_UNAVAILABLE",
      requestedBackend,
      availableBackends: await discoverLaunchBackends({ env, hasCommand, startupSupport }),
    });
  }

  if (!startupSupport[requestedBackend]) {
    return createBackendFailure({
      code: "BACKEND_START_UNSUPPORTED",
      requestedBackend,
      availableBackends: await discoverLaunchBackends({ env, hasCommand, startupSupport }),
    });
  }

  const startResolution = await tryBackends(
    [requestedBackend],
    start,
    (b) => hasCommand(b) && startupSupport[b],
    "start",
  );

  if (startResolution.ok) {
    return startResolution;
  }

  return createBackendFailure({
    requestedBackend,
    message: formatFailureMessage(startResolution.failures),
  });
}

async function resolveAutomaticBackend({
  env,
  hasCommand,
  startupSupport,
  attach,
  start,
}) {
  const attachedResolution = await tryBackends(
    SUPPORTED_BACKENDS,
    attach,
    (b) => isAttached(b, env) && hasCommand(b),
    "attach",
  );
  if (attachedResolution.ok) {
    return attachedResolution;
  }

  if (attachedResolution.failures.length > 0) {
    return createBackendFailure({
      detectedBackend: attachedResolution.failures[0].backend,
      message: formatFailureMessage(attachedResolution.failures),
    });
  }

  const startResolution = await tryBackends(
    SUPPORTED_BACKENDS,
    start,
    (b) => hasCommand(b) && startupSupport[b],
    "start",
  );
  if (startResolution.ok) {
    return startResolution;
  }

  if (startResolution.failures.length > 0) {
    return createBackendFailure({
      detectedBackend: startResolution.failures[0].backend,
      message: formatFailureMessage(startResolution.failures),
    });
  }

  return createBackendFailure({
    availableBackends: [],
  });
}

export async function discoverLaunchBackends({
  env = process.env,
  hasCommand = () => false,
  startupSupport = {},
} = {}) {
  const discovered = [];

  for (const backend of SUPPORTED_BACKENDS) {
    if (isAttached(backend, env) && hasCommand(backend)) {
      discovered.push({
        backend,
        source: "attached",
        attachable: true,
        startSupported: Boolean(startupSupport[backend]),
      });
      continue;
    }

    if (hasCommand(backend) && startupSupport[backend]) {
      discovered.push({
        backend,
        source: "startable",
        attachable: false,
        startSupported: true,
      });
    }
  }

  return discovered;
}

export async function resolveLaunchBackend({
  requestedBackend,
  env = process.env,
  hasCommand = () => false,
  startupSupport = {},
  attach = async () => ({}),
  start = async () => ({}),
} = {}) {
  if (requestedBackend) {
    return resolveRequestedBackend({
      requestedBackend,
      env,
      hasCommand,
      startupSupport,
      attach,
      start,
    });
  }

  return resolveAutomaticBackend({
    env,
    hasCommand,
    startupSupport,
    attach,
    start,
  });
}

// A pane whose foreground command is a plain shell is treated as "dead" —
// the copilot subprocess has exited and the user hasn't closed the zombie pane yet.
// Resume is safe in that state: we open a fresh pane bound to the same sessionId.
const DEAD_SHELLS = new Set(["bash", "zsh", "sh", "fish", "dash", "ksh"]);

function paneCommandIndicatesDeadShell(command) {
  const trimmed = String(command ?? "").trim();
  if (!trimmed) return true;
  // Strip leading "-" used by login shells (e.g. "-bash").
  const normalized = trimmed.startsWith("-") ? trimmed.slice(1) : trimmed;
  const [firstToken] = normalized.split(" ");
  return DEAD_SHELLS.has(firstToken);
}

function parseTmuxPaneLine(line) {
  const parts = line.split(" ");
  return {
    id: parts[0] ?? "",
    deadFlag: parts[1] ?? "",
    currentCommand: parts.slice(2).join(" "),
  };
}

function probeTmuxLiveness(paneId, spawnSync) {
  const result = spawnSync(
    "tmux",
    ["list-panes", "-a", "-F", "#{pane_id} #{pane_dead} #{pane_current_command}"],
    { stdio: "pipe" },
  );
  if (result.status !== 0) return false;
  const lines = String(result.stdout ?? "").split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    const { id, deadFlag, currentCommand } = parseTmuxPaneLine(line);
    if (id !== paneId) continue;
    if (deadFlag === "1") return false;
    return !paneCommandIndicatesDeadShell(currentCommand);
  }
  return false;
}

function probeZellijLiveness(paneId, spawnSync) {
  const numericId = Number.parseInt(stripPanePrefix(paneId), 10);
  if (!Number.isFinite(numericId)) return false;
  const result = spawnSync("zellij", ["action", "list-panes", "-j", "-c"], { stdio: "pipe" });
  if (result.status !== 0) return false;
  let panes;
  try {
    panes = JSON.parse(String(result.stdout ?? ""));
  } catch {
    return false;
  }
  if (!Array.isArray(panes)) return false;
  const match = panes.find((p) => p && p.is_plugin === false && Number(p.id) === numericId);
  if (!match || match.exited === true) return false;
  return !paneCommandIndicatesDeadShell(match.pane_command);
}

export function probeSessionLiveness({ backend, paneId, services = {} } = {}) {
  const spawnSync = services.spawnSync ?? defaultSpawnSync;
  if (backend === "tmux") return probeTmuxLiveness(paneId, spawnSync);
  if (backend === "zellij") return probeZellijLiveness(paneId, spawnSync);
  return false;
}
