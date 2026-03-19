import { randomUUID } from "node:crypto";

import {
  METADATA_VERSION,
  buildResumePointer,
  createLaunchRecord,
  createStateStore as defaultCreateStateStore,
} from "./state.mjs";
import { createStateIndex as defaultCreateStateIndex } from "./state-index.mjs";
import { extractLaunchSummary, waitForLaunchCompletion } from "./summary.mjs";

function normalizeExitCode(value, fallback = 1) {
  if (value === null || value === undefined) {
    return fallback;
  }

  return Number.isInteger(value) ? value : Number.parseInt(value, 10);
}

function resolveStateStore({ request, services = {} }) {
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

function resolveOperation({ request, services = {}, name }) {
  return request[name] ?? services[name];
}

function resolveStateIndex({ request, services = {} }) {
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

function createPrelaunchFailure({
  plan,
  request,
  code = "LAUNCH_RUNTIME_UNAVAILABLE",
  message,
  paneId = null,
  sessionId = null,
  exitCode = 1,
}) {
  const summary = extractLaunchSummary({
    agentIdentifier: plan.agentIdentifier,
    backend: plan.backend,
    paneId: paneId ?? "unassigned",
    sessionId,
    status: "failure",
    exitCode,
  });

  return {
    ok: false,
    code,
    message,
    launchId: plan.launchId,
    status: "failure",
    agentIdentifier: plan.agentIdentifier,
    agentKind: plan.agentKind,
    backend: plan.backend,
    launchAction: plan.launchAction,
    paneId,
    paneVisible: false,
    sessionId,
    summary: summary.summary,
    summarySource: summary.source,
    exitCode,
    metadataVersion: plan.metadataVersion,
    resumePointer: null,
  };
}

function shapeLaunchResult({
  manifest,
  request,
  launchAction,
  paneVisible,
  summarySource,
}) {
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
    ok: manifest.status === "success" || manifest.status === "running",
    launchId: manifest.launchId,
    status: manifest.status,
    agentIdentifier: manifest.agentIdentifier,
    agentKind: manifest.agentKind,
    backend: manifest.backend,
    launchAction,
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

function resolveLaunchDependencies({ plan, request, services }) {
  const stateStore = resolveStateStore({ request, services });
  const stateIndex = resolveStateIndex({ request, services });
  if (!stateStore) {
    return {
      failure: createPrelaunchFailure({
        plan,
        request,
        code: "STATE_STORE_UNAVAILABLE",
        message: "workspacePath is required to persist launch metadata.",
      }),
    };
  }

  const openPane = resolveOperation({ request, services, name: "openPane" });
  const launchAgentInPane = resolveOperation({ request, services, name: "launchAgentInPane" });
  if (typeof openPane !== "function" || typeof launchAgentInPane !== "function") {
    return {
      failure: createPrelaunchFailure({
        plan,
        request,
        message: `Launch operations are unavailable for backend ${plan.backend}.`,
      }),
    };
  }

  return {
    stateStore,
    stateIndex,
    openPane,
    launchAgentInPane,
    readPaneOutput: resolveOperation({ request, services, name: "readPaneOutput" }),
    readChildSessionState: resolveOperation({ request, services, name: "readChildSessionState" }),
  };
}

async function updateLaunchIndex({ stateIndex, manifest, request }) {
  if (!stateIndex || !manifest) {
    return;
  }

  await stateIndex.writeLaunchIndexEntry({
    ...manifest,
    manifestPath: buildResumePointer(manifest, {
      workspacePath: request.workspacePath,
      projectRoot: request.projectRoot,
    }).manifestPath,
  });
}

async function updateLaunchIndexBestEffort(options) {
  try {
    await updateLaunchIndex(options);
  } catch {}
}

async function openPaneAndPersist({ plan, request, openPane, stateStore, stateIndex }) {
  const pane = await openPane({
    backend: plan.backend,
    launchAction: plan.launchAction,
    agentIdentifier: plan.agentIdentifier,
    task: plan.task,
    visible: true,
    request,
  });

  const pendingManifest = await stateStore.writeLaunchRecord(
    createLaunchRecord({
      ...plan,
      paneId: pane?.paneId ?? null,
      sessionId: pane?.sessionId ?? null,
      status: "pending",
    }),
  );
  await updateLaunchIndexBestEffort({
    stateIndex,
    manifest: pendingManifest,
    request,
  });

  return {
    paneVisible: pane?.visible !== false,
    pendingManifest,
  };
}

async function runChildLaunch({
  plan,
  request,
  launchAgentInPane,
  stateStore,
  stateIndex,
  pendingManifest,
  paneVisible,
  readPaneOutput,
  readChildSessionState,
}) {
  const childLaunch = await launchAgentInPane({
    backend: plan.backend,
    paneId: pendingManifest.paneId,
    agentIdentifier: plan.agentIdentifier,
    agentKind: plan.agentKind,
    task: plan.task,
    request,
  });

  const runningManifest = await stateStore.updateLaunchRecord(plan.launchId, {
    status: "running",
    sessionId: childLaunch?.sessionId ?? pendingManifest.sessionId,
  });
  await updateLaunchIndexBestEffort({
    stateIndex,
    manifest: runningManifest,
    request,
  });

  if (!plan.awaitCompletion) {
    return shapeLaunchResult({
      manifest: runningManifest,
      request,
      launchAction: plan.launchAction,
      paneVisible,
      summarySource: "fallback",
    });
  }

  const completion = await waitForLaunchCompletion({
    backend: plan.backend,
    paneId: runningManifest.paneId,
    sessionId: runningManifest.sessionId,
    agentIdentifier: plan.agentIdentifier,
    readPaneOutput,
    readChildSessionState,
    maxAttempts: request.maxMonitorAttempts ?? 25,
    pollIntervalMs: request.pollIntervalMs ?? 500,
    sleep: request.sleep,
    request,
  });
  const terminalManifest = await stateStore.updateLaunchRecord(plan.launchId, {
    status: completion.status,
    summary: completion.summary,
    exitCode: completion.exitCode,
  });
  await updateLaunchIndexBestEffort({
    stateIndex,
    manifest: terminalManifest,
    request,
  });

  return shapeLaunchResult({
    manifest: terminalManifest,
    request,
    launchAction: plan.launchAction,
    paneVisible,
    summarySource: completion.summarySource,
  });
}

async function handleLaunchError({
  error,
  plan,
  request,
  stateStore,
  stateIndex,
  pendingManifest,
  paneVisible,
}) {
  if (!pendingManifest) {
    return createPrelaunchFailure({
      plan,
      request,
      code: error?.code ?? "LAUNCH_RUNTIME_UNAVAILABLE",
      message: error instanceof Error ? error.message : String(error),
      paneId: error?.paneId ?? null,
      sessionId: error?.sessionId ?? null,
      exitCode: normalizeExitCode(error?.exitCode, 1),
    });
  }

  const status = error?.timedOut ? "timeout" : error?.cancelled ? "cancelled" : "failure";
  const exitCode = normalizeExitCode(error?.exitCode, status === "success" ? 0 : 1);
  const summary = extractLaunchSummary({
    persistedExplicitSummary: error?.summary,
    paneOutput: error?.paneOutput,
    agentIdentifier: plan.agentIdentifier,
    backend: plan.backend,
    paneId: pendingManifest.paneId,
    sessionId: pendingManifest.sessionId,
    status,
    exitCode,
  });
  const failedManifest = await stateStore.updateLaunchRecord(plan.launchId, {
    status,
    sessionId: error?.sessionId ?? pendingManifest.sessionId,
    summary: summary.summary,
    exitCode,
  });
  await updateLaunchIndexBestEffort({
    stateIndex,
    manifest: failedManifest,
    request,
  });

  return shapeLaunchResult({
    manifest: failedManifest,
    request,
    launchAction: plan.launchAction,
    paneVisible,
    summarySource: summary.source,
  });
}

export function planSingleLaunch({
  request = {},
  agentValidation,
  backendResolution,
  createLaunchId = () => randomUUID(),
  now = () => new Date().toISOString(),
} = {}) {
  return {
    launchId: createLaunchId(),
    agentIdentifier: agentValidation.identifier,
    agentKind: agentValidation.agentKind,
    backend: backendResolution.selectedBackend,
    launchAction: backendResolution.action,
    backendSessionName: backendResolution.sessionName ?? null,
    task: request.task,
    awaitCompletion: request.awaitCompletion !== false,
    requestedAt: now(),
    sessionId: null,
    summary: null,
    exitCode: null,
    metadataVersion: METADATA_VERSION,
  };
}

export async function launchSingleSubagent({
  request = {},
  agentValidation,
  backendResolution,
  services = {},
  createLaunchId,
  now,
} = {}) {
  const plan = planSingleLaunch({
    request,
    agentValidation,
    backendResolution,
    createLaunchId,
    now,
  });
  const dependencies = resolveLaunchDependencies({ plan, request, services });
  if (dependencies.failure) {
    return dependencies.failure;
  }

  let paneVisible = false;
  let pendingManifest = null;

  try {
    ({ paneVisible, pendingManifest } = await openPaneAndPersist({
      plan,
      request,
      openPane: dependencies.openPane,
      stateStore: dependencies.stateStore,
      stateIndex: dependencies.stateIndex,
    }));

    return await runChildLaunch({
      plan,
      request,
      launchAgentInPane: dependencies.launchAgentInPane,
      stateStore: dependencies.stateStore,
      stateIndex: dependencies.stateIndex,
      pendingManifest,
      paneVisible,
      readPaneOutput: dependencies.readPaneOutput,
      readChildSessionState: dependencies.readChildSessionState,
    });
  } catch (error) {
    return handleLaunchError({
      error,
      plan,
      request,
      stateStore: dependencies.stateStore,
      stateIndex: dependencies.stateIndex,
      pendingManifest,
      paneVisible,
    });
  }
}
