import { randomUUID } from "node:crypto";

import {
  METADATA_VERSION,
  buildResumePointer,
  createLaunchRecord,
} from "./state.mjs";
import { resolveStateDir } from "./exit-sidecar.mjs";
import { extractLaunchSummary, extractSessionSummary, waitForLaunchCompletion } from "./summary.mjs";
import { closePane as defaultClosePane } from "./close-pane.mjs";
import { forkSession as defaultForkSession } from "./fork-session.mjs";
import { resolveOperation, resolveStateStore, resolveStateIndex } from "./resolve.mjs";
import { isActiveOrSuccessful, normalizeExitCode } from "./utils.mjs";

const DEFAULT_MONITOR_ATTEMPTS = 240;

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
    ok: isActiveOrSuccessful(manifest.status),
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
    closePane: resolveOperation({ request, services, name: "closePane" }) ?? defaultClosePane,
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
    backendSessionName: plan.backendSessionName,
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

export function enrichCompletionSummary(completion, plan) {
  // Precedence (D2.3 inversion): sidecar > pane scrape > session-events fallback.
  if (completion.source === "sidecar" && completion.summary) {
    return { summary: completion.summary, source: "sidecar" };
  }
  if (completion.source === "sentinel" && completion.summary) {
    return { summary: completion.summary, source: completion.summarySource ?? "pane" };
  }
  if (plan.copilotSessionId) {
    const sessionSummary = extractSessionSummary({
      copilotSessionId: plan.copilotSessionId,
      sinceEventIndex: plan.eventsBaseline ?? undefined,
    });
    if (sessionSummary.summary) {
      return { summary: sessionSummary.summary, source: sessionSummary.source };
    }
  }
  return { summary: completion.summary ?? null, source: completion.summarySource ?? "fallback" };
}

export function buildManifestUpdates({ completion, completionSummary, activeManifest, now }) {
  const updates = {
    status: completion.status,
    summary: completionSummary.summary,
    exitCode: completion.exitCode,
  };
  if (completion.source === "sidecar") {
    updates.sidecarPath = completion.sidecarPath;
    updates.lastExitType = completion.sidecarType === "ping" ? "ping" : "done";
    if (completion.sidecarType === "ping") {
      updates.pingHistory = [
        ...(activeManifest.pingHistory ?? []),
        { message: completion.message, sentAt: now() },
      ];
    }
  } else if (completion.source === "sentinel") {
    updates.lastExitType = "done";
  }
  return updates;
}

export function shapePingResult({ baseResult, completion }) {
  return {
    ...baseResult,
    status: "ping",
    summary: null,
    exitCode: 0,
    ping: { message: completion.message },
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
  closePane,
}) {
  const childLaunch = await launchAgentInPane({
    backend: plan.backend,
    paneId: pendingManifest.paneId,
    agentIdentifier: plan.agentIdentifier,
    agentKind: plan.agentKind,
    task: plan.task,
    copilotSessionId: plan.copilotSessionId,
    launchId: plan.launchId,
    interactive: plan.interactive,
    request,
  });

  const activeStatus = plan.interactive ? "interactive" : "running";
  const activeManifest = await stateStore.updateLaunchRecord(plan.launchId, {
    status: activeStatus,
    sessionId: childLaunch?.sessionId ?? pendingManifest.sessionId,
  });
  await updateLaunchIndexBestEffort({
    stateIndex,
    manifest: activeManifest,
    request,
  });

  if (!plan.awaitCompletion) {
    return shapeLaunchResult({
      manifest: activeManifest,
      request,
      launchAction: plan.launchAction,
      paneVisible,
      summarySource: "fallback",
    });
  }

  const completion = await waitForLaunchCompletion({
    launchId: plan.launchId,
    stateDir: request.stateDir,
    backend: plan.backend,
    paneId: activeManifest.paneId,
    sessionId: activeManifest.sessionId,
    agentIdentifier: plan.agentIdentifier,
    readPaneOutput,
    readChildSessionState,
    maxAttempts: request.maxMonitorAttempts ?? DEFAULT_MONITOR_ATTEMPTS,
    pollIntervalMs: request.pollIntervalMs ?? 500,
    sleep: request.sleep,
    sidecarGraceMs: request.sidecarGraceMs ?? 500,
    request,
  });

  const completionWithSummary = enrichCompletionSummary(completion, plan);

  const now = () => new Date().toISOString();
  const updates = buildManifestUpdates({
    completion, completionSummary: completionWithSummary, activeManifest, now,
  });
  const terminalManifest = await stateStore.updateLaunchRecord(plan.launchId, updates);
  await updateLaunchIndexBestEffort({
    stateIndex,
    manifest: terminalManifest,
    request,
  });

  if (plan.closePaneOnCompletion && typeof closePane === "function") {
    try {
      closePane({ backend: plan.backend, paneId: activeManifest.paneId });
      paneVisible = false;
    } catch {
      // Pane close is best-effort — don't fail the launch
    }
  }

  const baseResult = shapeLaunchResult({
    manifest: terminalManifest,
    request,
    launchAction: plan.launchAction,
    paneVisible,
    summarySource: completionWithSummary.source,
  });
  return completion.status === "ping"
    ? shapePingResult({ baseResult, completion })
    : baseResult;
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

  let status = "failure";
  if (error?.timedOut) status = "timeout";
  else if (error?.cancelled) status = "cancelled";
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
  createCopilotSessionId = () => randomUUID(),
  now = () => new Date().toISOString(),
} = {}) {
  const backend = backendResolution.selectedBackend;
  const interactive = request.interactive === true;
  return {
    launchId: createLaunchId(),
    agentIdentifier: agentValidation.identifier,
    agentKind: agentValidation.agentKind,
    backend,
    launchAction: backendResolution.action,
    backendSessionName: backendResolution.sessionName ?? null,
    task: request.task,
    awaitCompletion: request.awaitCompletion ?? !interactive,
    requestedAt: now(),
    sessionId: null,
    summary: null,
    exitCode: null,
    metadataVersion: METADATA_VERSION,
    copilotSessionId: backend === "cmux" ? null : createCopilotSessionId(),
    interactive,
    fork: request.fork ?? null,
    closePaneOnCompletion: request.closePaneOnCompletion ?? !interactive,
    eventsBaseline: null,
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
  request = {
    ...request,
    stateDir: request.stateDir ?? resolveStateDir({ projectRoot: request.projectRoot }),
  };
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

  // Fork step: if fork param is set, fork parent session and use child's copilotSessionId
  if (request.fork && plan.copilotSessionId) {
    const forkSession = services.forkSession ?? defaultForkSession;
    let parentId = request.fork.copilotSessionId;
    if (!parentId && request.fork.launchId) {
      const parentManifest = await dependencies.stateStore.readLaunchRecord(request.fork.launchId);
      parentId = parentManifest?.copilotSessionId;
    }
    if (!parentId) {
      return {
        ok: false,
        code: "FORK_INVALID",
        message: "Fork requires copilotSessionId or a launchId with a copilotSessionId.",
      };
    }
    const forkResult = forkSession({
      parentCopilotSessionId: parentId,
      copilotHome: request.copilotHome,
      stateDir: request.stateDir,
      services,
    });
    if (!forkResult.ok) {
      return { ok: false, ...forkResult };
    }
    plan.copilotSessionId = forkResult.forkCopilotSessionId;
    plan.fork = {
      parentCopilotSessionId: forkResult.parentCopilotSessionId,
      parentLaunchId: request.fork.launchId ?? null,
    };
    plan.eventsBaseline = forkResult.eventsBaseline;
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
      closePane: dependencies.closePane,
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
