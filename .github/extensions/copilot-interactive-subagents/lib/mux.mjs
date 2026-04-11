export const SUPPORTED_BACKENDS = ["cmux", "zellij", "tmux"];

import { spawnSync as defaultSpawnSync } from "node:child_process";

function isAttached(backend, env = {}) {
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

function backendGuidance(backend) {
  switch (backend) {
    case "cmux":
      return "Start Copilot inside cmux or install/configure cmux startup support.";
    case "tmux":
      return "Start Copilot inside tmux or install/configure tmux startup support.";
    case "zellij":
      return "Start Copilot inside zellij or install/configure zellij startup support.";
    default:
      return "Install or configure cmux, tmux, or zellij to enable pane-backed launches.";
  }
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

async function tryAttachedBackends(backends, attach, env, hasCommand = () => true) {
  const failures = [];

  for (const backend of backends) {
    if (!isAttached(backend, env) || !hasCommand(backend)) {
      continue;
    }

    try {
      return createBackendSuccess(backend, "attach", await attach(backend));
    } catch (error) {
      failures.push({
        backend,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { ok: false, failures };
}

async function tryStartableBackends(backends, start, hasCommand, startupSupport) {
  const failures = [];

  for (const backend of backends) {
    if (!hasCommand(backend) || !startupSupport[backend]) {
      continue;
    }

    try {
      return createBackendSuccess(backend, "start", await start(backend));
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
  const attachedResolution = await tryAttachedBackends([requestedBackend], attach, env, hasCommand);
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

  const startResolution = await tryStartableBackends(
    [requestedBackend],
    start,
    hasCommand,
    startupSupport,
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
  const attachedResolution = await tryAttachedBackends(SUPPORTED_BACKENDS, attach, env, hasCommand);
  if (attachedResolution.ok) {
    return attachedResolution;
  }

  if (attachedResolution.failures.length > 0) {
    return createBackendFailure({
      detectedBackend: attachedResolution.failures[0].backend,
      message: formatFailureMessage(attachedResolution.failures),
    });
  }

  const startResolution = await tryStartableBackends(
    SUPPORTED_BACKENDS,
    start,
    hasCommand,
    startupSupport,
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

export function probeSessionLiveness({ backend, paneId, services = {} } = {}) {
  const spawnSync = services.spawnSync ?? defaultSpawnSync;
  if (backend === "tmux") {
    const result = spawnSync("tmux", ["has-session", "-t", paneId], { stdio: "pipe" });
    return result.status === 0;
  }
  if (backend === "zellij") {
    // Zellij doesn't support pane-targeted liveness checks (dump-screen
    // targets the focused pane, not a specific pane). Return false (assume
    // dead) so resume can proceed — if the pane is actually alive, a new
    // pane opens alongside it which is harmless.
    return false;
  }
  return false;
}
