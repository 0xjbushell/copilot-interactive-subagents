import {
  METADATA_VERSION,
  assertSupportedMetadataVersion,
  buildResumePointer,
  isValidLaunchId,
  isSupportedBackend,
} from "./state.mjs";
import { extractLaunchSummary, extractSessionSummary, waitForLaunchCompletion } from "./summary.mjs";
import { acquireLock as defaultAcquireLock } from "./session-lock.mjs";
import { probeSessionLiveness as defaultProbeSessionLiveness } from "./mux.mjs";
import { closePane as defaultClosePane } from "./close-pane.mjs";
import { unlinkSync as defaultUnlinkSync, readFileSync as defaultReadFileSync } from "node:fs";
import { join } from "node:path";
import { homedir as defaultHomedir } from "node:os";
import { resolveOperation, resolveStateStore, resolveStateIndex } from "./resolve.mjs";
import { isActiveOrSuccessful, normalizeNonEmptyString, countNonEmptyLines } from "./utils.mjs";
import { resolveStateDir } from "./exit-sidecar.mjs";

function resolveLaunchId(request = {}) {
  return normalizeNonEmptyString(request.launchId)
    ?? normalizeNonEmptyString(request.resumeReference)
    ?? request.resumePointer?.launchId
    ?? request.resumeReference?.launchId
    ?? null;
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

  // Hard cutover (D1.2): throws MANIFEST_VERSION_UNSUPPORTED when version
  // mismatches; SDK callers and withToolTimeout see the typed code.
  assertSupportedMetadataVersion(manifest, { source: "manifest" });

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
    ok: isActiveOrSuccessful(manifest.status),
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
    copilotSessionId: manifest.copilotSessionId ?? null,
    resumePointer: buildResumePointer(manifest, {
      workspacePath: request.workspacePath,
      projectRoot: request.projectRoot,
    }),
  };
}

function cleanupStaleSignalFile({ copilotSessionId, stateDir, services = {} }) {
  const unlinkSync = services.unlinkSync ?? defaultUnlinkSync;
  const baseDir = stateDir ?? ".copilot-interactive-subagents";
  try { unlinkSync(join(baseDir, "done", copilotSessionId)); } catch { /* not present */ }
}

function countSessionEvents({ copilotSessionId, copilotHome, services = {} }) {
  const readFile = services.readFileSync ?? defaultReadFileSync;
  const homedir = services.homedir ?? defaultHomedir;
  const home = copilotHome ?? join(homedir(), ".copilot");
  const eventsPath = join(home, "session-state", copilotSessionId, "events.jsonl");
  return countNonEmptyLines(readFile, eventsPath);
}

async function awaitResumeCompletion({
  manifest, request, services, newPaneId, eventsBaseline, plan,
}) {
  const readPaneOutput = resolveOperation({ request, services, name: "readPaneOutput" });
  const readChildSessionState = resolveOperation({ request, services, name: "readChildSessionState" });

  const completion = await waitForLaunchCompletion({
    launchId: manifest.launchId,
    stateDir: request.stateDir,
    backend: manifest.backend,
    paneId: newPaneId,
    sessionId: manifest.sessionId,
    agentIdentifier: manifest.agentIdentifier,
    request,
    readPaneOutput,
    readChildSessionState,
    maxAttempts: request.maxMonitorAttempts ?? 25,
    pollIntervalMs: request.pollIntervalMs ?? 500,
    sleep: request.sleep,
    sidecarGraceMs: request.sidecarGraceMs ?? 500,
  });

  let completionSummary = completion.summary;
  let completionSummarySource = completion.summarySource;
  const sessionSummary = extractSessionSummary({
    copilotSessionId: manifest.copilotSessionId,
    sinceEventIndex: eventsBaseline,
  });
  if (sessionSummary.summary) {
    completionSummary = sessionSummary.summary;
    completionSummarySource = sessionSummary.source;
  }

  const terminalManifest = await plan.stateStore.updateLaunchRecord(plan.launchId, {
    status: completion.status,
    summary: completionSummary,
    exitCode: completion.exitCode,
  });

  const closePane = services.closePane ?? defaultClosePane;
  if (manifest.closePaneOnCompletion !== false) {
    try { closePane({ backend: manifest.backend, paneId: newPaneId }); } catch { /* best effort */ }
  }

  return shapeResumeResult({
    manifest: terminalManifest,
    request,
    paneVisible: false,
    summarySource: completionSummarySource,
  });
}

async function openResumePane({ manifest, request, services }) {
  const extraPrompt = (typeof request.task === "string" && request.task.length > 0) ? request.task : null;
  const openPaneAndSendCommand = services.openPaneAndSendCommand ?? request.openPaneAndSendCommand;
  if (typeof openPaneAndSendCommand === "function") {
    const result = await openPaneAndSendCommand({
      backend: manifest.backend,
      copilotSessionId: manifest.copilotSessionId,
      task: extraPrompt,
      request,
    });
    return { paneId: result?.paneId ?? manifest.paneId, sessionId: result?.sessionId ?? null };
  }

  // Fallback: compose openPane + launchAgentInPane from separate services
  const openPane = resolveOperation({ request, services, name: "openPane" });
  const launchAgentInPane = resolveOperation({ request, services, name: "launchAgentInPane" });
  if (typeof openPane === "function" && typeof launchAgentInPane === "function") {
    const pane = await openPane({ backend: manifest.backend, request });
    const child = await launchAgentInPane({
      backend: manifest.backend,
      request,
      paneId: pane.paneId,
      agentIdentifier: manifest.agentIdentifier,
      task: extraPrompt,
      copilotSessionId: manifest.copilotSessionId,
      interactive: false,
    });
    return {
      paneId: pane.paneId,
      sessionId: child?.sessionId ?? null,
    };
  }

  return { paneId: manifest.paneId, sessionId: null };
}

export async function resumeSubagent({ request = {}, services = {} } = {}) {
  request = {
    ...request,
    stateDir: request.stateDir ?? resolveStateDir({ projectRoot: request.projectRoot }),
  };
  const plan = await planResumeSession({ request, services });
  if (!plan.ok) {
    return plan;
  }

  const manifest = plan.manifest;
  if (!manifest.copilotSessionId) {
    return shapeResumeFailure({
      code: "RESUME_UNSUPPORTED",
      message: "This launch does not have a copilotSessionId (pre-v2 launch). Cannot resume.",
      manifest,
      request,
    });
  }

  // Step 1: Acquire lock
  const acquireLock = services.acquireLock ?? defaultAcquireLock;
  let lock;
  try {
    lock = acquireLock({ copilotSessionId: manifest.copilotSessionId, stateDir: request.stateDir });
  } catch (err) {
    if (err?.code === "SESSION_ACTIVE") {
      return shapeResumeFailure({ code: "SESSION_ACTIVE", message: err.message, manifest, request });
    }
    throw err;
  }

  try {
    // Step 2: Verify pane is dead (skip for terminal statuses — manifest is authoritative)
    const isTerminalStatus = manifest.status === "success" || manifest.status === "failure" || manifest.status === "timeout";
    if (!isTerminalStatus) {
      const probeSessionLiveness = services.probeSessionLiveness ?? defaultProbeSessionLiveness;
      if (probeSessionLiveness({ backend: manifest.backend, paneId: manifest.paneId, services })) {
        lock.release();
        return shapeResumeFailure({
          code: "SESSION_ACTIVE",
          message: "Session pane is still alive. Close or wait for completion before resuming.",
          manifest,
          request,
        });
      }
    }

    // Step 3: Record eventsBaseline BEFORE launching child
    const eventsBaseline = countSessionEvents({
      copilotSessionId: manifest.copilotSessionId,
      copilotHome: request.copilotHome,
      services,
    });

    // Step 4: Clean up stale signal file
    cleanupStaleSignalFile({ copilotSessionId: manifest.copilotSessionId, stateDir: request.stateDir, services });

    // Step 5: Open new pane + send resume command
    const resumePane = await openResumePane({ manifest, request, services });
    const newPaneId = resumePane.paneId;

    // Step 6: Update manifest
    const updatedManifest = await plan.stateStore.updateLaunchRecord(plan.launchId, {
      status: "interactive",
      paneId: newPaneId,
      eventsBaseline,
    });

    if (plan.stateIndex) {
      try {
        await plan.stateIndex.writeLaunchIndexEntry({
          ...updatedManifest,
          manifestPath: buildResumePointer(updatedManifest, {
            workspacePath: request.workspacePath,
            projectRoot: request.projectRoot,
          }).manifestPath,
        });
      } catch { /* best effort */ }
    }

    // Step 7: Release lock (pane is now running)
    lock.release();

    // Step 8: If awaitCompletion, monitor
    if (request.awaitCompletion) {
      return await awaitResumeCompletion({
        manifest, request, services, newPaneId, eventsBaseline, plan,
      });
    }

    // Fire-and-forget: return immediately
    return shapeResumeResult({
      manifest: updatedManifest,
      request,
      paneVisible: true,
      summarySource: "fallback",
    });
  } catch (error) {
    lock.release();
    return shapeResumeFailure({
      code: error?.code ?? "RESUME_RUNTIME_UNAVAILABLE",
      message: error instanceof Error ? error.message : String(error),
      manifest,
      request,
    });
  }
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
