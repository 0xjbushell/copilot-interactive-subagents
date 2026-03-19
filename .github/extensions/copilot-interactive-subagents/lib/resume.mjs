import {
  METADATA_VERSION,
  buildResumePointer,
  createStateStore as defaultCreateStateStore,
  isValidLaunchId,
  isSupportedBackend,
} from "./state.mjs";
import { createStateIndex as defaultCreateStateIndex } from "./state-index.mjs";
import { extractLaunchSummary, waitForLaunchCompletion } from "./summary.mjs";

function resolveOperation({ request, services = {}, name }) {
  return request[name] ?? services[name];
}

function resolveLaunchId(request = {}) {
  if (typeof request.launchId === "string" && request.launchId.trim().length > 0) {
    return request.launchId.trim();
  }

  if (typeof request.resumeReference === "string" && request.resumeReference.trim().length > 0) {
    return request.resumeReference.trim();
  }

  return request.resumePointer?.launchId ?? request.resumeReference?.launchId ?? null;
}

function resolveStateStore({ request = {}, services = {} }) {
  if (request.stateStore) {
    return request.stateStore;
  }

  if (services.stateStore) {
    return services.stateStore;
  }

  const createStateStore = request.createStateStore ?? services.createStateStore ?? defaultCreateStateStore;
  return createStateStore({
    workspacePath: request.workspacePath,
    projectRoot: request.projectRoot,
  });
}

function resolveStateIndex({ request = {}, services = {} }) {
  if (request.stateIndex) {
    return request.stateIndex;
  }

  if (services.stateIndex) {
    return services.stateIndex;
  }

  if (!request.projectRoot && !request.createStateIndex && !services.createStateIndex) {
    return null;
  }

  const createStateIndex = request.createStateIndex ?? services.createStateIndex ?? defaultCreateStateIndex;
  return createStateIndex({
    projectRoot: request.projectRoot,
  });
}

function normalizeFailureMessage(message, fallback) {
  if (typeof message !== "string") {
    return fallback;
  }

  const trimmed = message.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function shapeResumeFailure({
  code,
  message,
  launchId,
  manifest = null,
  request = {},
}) {
  return {
    ok: false,
    code,
    message,
    launchId: launchId ?? manifest?.launchId ?? null,
    status: "failure",
    agentIdentifier: manifest?.agentIdentifier ?? null,
    agentKind: manifest?.agentKind ?? null,
    backend: manifest?.backend ?? null,
    paneId: manifest?.paneId ?? null,
    paneVisible: false,
    sessionId: manifest?.sessionId ?? null,
    summary: manifest?.summary ?? message,
    summarySource: manifest?.summary ? "stored" : "failure",
    exitCode: manifest?.exitCode ?? null,
    metadataVersion: manifest?.metadataVersion ?? METADATA_VERSION,
    resumePointer: manifest
      ? buildResumePointer(manifest, {
        workspacePath: request.workspacePath,
        projectRoot: request.projectRoot,
      })
      : null,
  };
}

function validateManifest({ manifest, request }) {
  if (!manifest) {
    return shapeResumeFailure({
      code: "LAUNCH_NOT_FOUND",
      message: "No stored launch metadata was found for the requested launch reference.",
      launchId: resolveLaunchId(request),
      request,
    });
  }

  if (manifest.metadataVersion !== METADATA_VERSION) {
    return shapeResumeFailure({
      code: "RESUME_UNSUPPORTED",
      message: `Stored launch metadata version ${manifest.metadataVersion} is not supported by this resume implementation.`,
      manifest,
      request,
    });
  }

  if (!manifest.backend || !manifest.agentIdentifier || !manifest.paneId) {
    return shapeResumeFailure({
      code: "RESUME_TARGET_INVALID",
      message: "Stored launch metadata is missing the backend, agent identifier, or pane reference required to resume.",
      manifest,
      request,
    });
  }

  if (!isSupportedBackend(manifest.backend)) {
    return shapeResumeFailure({
      code: "RESUME_TARGET_INVALID",
      message: "Stored launch metadata uses an unsupported backend value.",
      manifest,
      request,
    });
  }

  return null;
}

async function readWorkspaceManifest(stateStore, launchId) {
  if (!stateStore || !launchId) {
    return null;
  }

  try {
    return await stateStore.readLaunchRecord(launchId);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function shapeResumeResult({ manifest, request, paneVisible, summarySource }) {
  const summary = manifest.summary
    ?? extractLaunchSummary({
      agentIdentifier: manifest.agentIdentifier,
      backend: manifest.backend,
      paneId: manifest.paneId,
      sessionId: manifest.sessionId,
      status: manifest.status,
      exitCode: manifest.exitCode,
    }).summary;

  return {
    ok: manifest.status === "running" || manifest.status === "success",
    launchId: manifest.launchId,
    status: manifest.status,
    agentIdentifier: manifest.agentIdentifier,
    agentKind: manifest.agentKind,
    backend: manifest.backend,
    paneId: manifest.paneId,
    paneVisible,
    sessionId: manifest.sessionId,
    summary,
    summarySource,
    exitCode: manifest.exitCode,
    metadataVersion: manifest.metadataVersion,
    resumePointer: buildResumePointer(manifest, {
      workspacePath: request.workspacePath,
      projectRoot: request.projectRoot,
    }),
  };
}

async function probeManifestTarget({ plan, request, services }) {
  const probeResumeTarget = resolveOperation({ request, services, name: "probeResumeTarget" });
  if (typeof probeResumeTarget !== "function") {
    return null;
  }

  const probe = await probeResumeTarget({
    manifest: plan.manifest,
    request,
  });

  if (probe?.ok !== false) {
    return null;
  }

  return shapeResumeFailure({
    code: probe.code ?? "RESUME_TARGET_INVALID",
    message: normalizeFailureMessage(
      probe.message ?? probe.reason,
      `The stored session ${plan.manifest.sessionId} is no longer resumable.`,
    ),
    manifest: plan.manifest,
    request,
  });
}

function formatAttachFailureMessage(error) {
  const message = normalizeFailureMessage(
    error instanceof Error ? error.message : String(error),
    "Resume attach failed.",
  );

  return message.includes("attach failed")
    ? message
    : `Resume attach failed: ${message}`;
}

function shapeRuntimeResumeFailure({ error, manifest, request }) {
  return shapeResumeFailure({
    code: error?.code ?? "RESUME_RUNTIME_UNAVAILABLE",
    message: normalizeFailureMessage(
      error instanceof Error ? error.message : String(error),
      "Resume failed while monitoring or persisting the launch state.",
    ),
    manifest,
    request,
  });
}

async function attachResumeTarget({ plan, request, services }) {
  const reattachResumeTarget = resolveOperation({ request, services, name: "reattachResumeTarget" });

  if (typeof reattachResumeTarget !== "function") {
    return {
      paneId: plan.manifest.paneId,
      paneVisible: true,
      sessionId: plan.manifest.sessionId,
    };
  }

  try {
    return await reattachResumeTarget({
      manifest: plan.manifest,
      request,
    });
  } catch (error) {
    return shapeResumeFailure({
      code: "RESUME_ATTACH_FAILED",
      message: formatAttachFailureMessage(error),
      manifest: plan.manifest,
      request,
    });
  }
}

async function buildTerminalManifest({
  plan,
  request,
  services,
  paneId,
  sessionId,
}) {
  if (!request.awaitCompletion) {
    return {
      manifest: {
        ...plan.manifest,
        paneId,
        sessionId,
        status: plan.manifest.status === "pending" ? "running" : plan.manifest.status,
        summary: plan.manifest.summary,
        exitCode: plan.manifest.exitCode,
      },
      summarySource: plan.manifest.summary ? "stored" : "fallback",
    };
  }

  const completion = await waitForLaunchCompletion({
    backend: plan.manifest.backend,
    paneId,
    sessionId,
    agentIdentifier: plan.manifest.agentIdentifier,
    request,
    readPaneOutput: resolveOperation({ request, services, name: "readPaneOutput" }),
    readChildSessionState: resolveOperation({ request, services, name: "readChildSessionState" }),
    maxAttempts: request.maxMonitorAttempts ?? 25,
    pollIntervalMs: request.pollIntervalMs ?? 500,
    sleep: request.sleep,
  });

  return {
    manifest: {
      ...plan.manifest,
      paneId,
      sessionId,
      status: completion.status,
      summary: completion.summary,
      exitCode: completion.exitCode,
    },
    summarySource: completion.summarySource,
  };
}

export async function planResumeSession({ request = {}, services = {} } = {}) {
  const launchId = resolveLaunchId(request);
  if (!launchId) {
    return shapeResumeFailure({
      code: "LAUNCH_NOT_FOUND",
      message: "A launchId or stored launch reference is required to resume a prior subagent.",
      request,
    });
  }

  if (!isValidLaunchId(launchId)) {
    return shapeResumeFailure({
      code: "INVALID_ARGUMENT",
      message: "launchId must use only letters, numbers, periods, underscores, and hyphens.",
      launchId,
      request,
    });
  }

  const stateStore = resolveStateStore({ request, services });
  const stateIndex = resolveStateIndex({ request, services });

  const workspaceManifest = await readWorkspaceManifest(stateStore, launchId);
  if (workspaceManifest) {
    const validationFailure = validateManifest({ manifest: workspaceManifest, request });
    if (validationFailure) {
      return validationFailure;
    }

    return {
      ok: true,
      launchId,
      lookupSource: "workspace",
      manifest: workspaceManifest,
      stateStore,
      stateIndex,
    };
  }

  const indexedManifest = stateIndex ? await stateIndex.lookupLaunch(launchId) : null;
  if (indexedManifest) {
    const validationFailure = validateManifest({ manifest: indexedManifest, request });
    if (validationFailure) {
      return validationFailure;
    }

    return {
      ok: true,
      launchId,
      lookupSource: "index",
      manifest: indexedManifest,
      stateStore,
      stateIndex,
    };
  }

  return shapeResumeFailure({
    code: "LAUNCH_NOT_FOUND",
    message: `No stored launch metadata was found for launch ${launchId}.`,
    launchId,
    request,
  });
}

export async function resumeSubagent({ request = {}, services = {} } = {}) {
  const plan = await planResumeSession({ request, services });
  if (!plan.ok) {
    return plan;
  }

  const probeFailure = await probeManifestTarget({ plan, request, services });
  if (probeFailure) {
    return probeFailure;
  }

  const attachment = await attachResumeTarget({ plan, request, services });
  if (attachment?.ok === false) {
    return attachment;
  }

  const nextPaneId = attachment?.paneId ?? plan.manifest.paneId;
  const nextSessionId = attachment?.sessionId ?? plan.manifest.sessionId;
  const paneVisible = attachment?.paneVisible !== false;
  try {
    const { manifest: terminalUpdate, summarySource } = await buildTerminalManifest({
      plan,
      request,
      services,
      paneId: nextPaneId,
      sessionId: nextSessionId,
    });

    const persistedManifest = await plan.stateStore.writeLaunchRecord(terminalUpdate);
    if (plan.stateIndex) {
      try {
        await plan.stateIndex.writeLaunchIndexEntry({
          ...persistedManifest,
          manifestPath: buildResumePointer(persistedManifest, {
            workspacePath: request.workspacePath,
            projectRoot: request.projectRoot,
          }).manifestPath,
        });
      } catch {}
    }
    return shapeResumeResult({
      manifest: persistedManifest,
      request,
      paneVisible,
      summarySource,
    });
  } catch (error) {
    return shapeRuntimeResumeFailure({
      error,
      manifest: plan.manifest,
      request,
    });
  }
}
