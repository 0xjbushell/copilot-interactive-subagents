import { randomUUID } from "node:crypto";

import { launchSingleSubagent, planSingleLaunch } from "./launch.mjs";
import { buildMuxLayout } from "./mux-layout.mjs";
import { createParallelProgressTracker } from "./progress.mjs";

function normalizeLaunchEntry(entry = {}) {
  return {
    request: entry.request ?? {},
    agentValidation: entry.agentValidation,
  };
}

function createUnexpectedFailure(entry, error) {
  return {
    ok: false,
    launchId: entry.plan.launchId,
    status: "failure",
    agentIdentifier: entry.plan.agentIdentifier,
    agentKind: entry.plan.agentKind,
    backend: entry.plan.backend,
    launchAction: entry.plan.launchAction,
    paneId: null,
    paneVisible: false,
    sessionId: null,
    summary: error instanceof Error ? error.message : String(error),
    summarySource: "fallback",
    exitCode: error?.exitCode ?? 1,
    metadataVersion: entry.plan.metadataVersion,
    resumePointer: null,
  };
}

function buildLaunchServices(entry, tracker, services = {}) {
  const openPane = services.openPane;
  const launchAgentInPane = services.launchAgentInPane;

  return {
    ...services,
    async openPane(context = {}) {
      const pane = await openPane({
        ...context,
        layout: entry.layout,
      });

      tracker.markPaneOpened({
        launchId: entry.plan.launchId,
        paneId: pane?.paneId ?? null,
        paneVisible: pane?.visible !== false,
        sessionId: pane?.sessionId ?? null,
        layout: entry.layout,
      });

      return pane;
    },
    async launchAgentInPane(context = {}) {
      const child = await launchAgentInPane({
        ...context,
        layout: entry.layout,
      });

      tracker.markRunning({
        launchId: entry.plan.launchId,
        paneId: context.paneId ?? null,
        sessionId: child?.sessionId ?? null,
        paneVisible: true,
        layout: entry.layout,
      });

      return child;
    },
  };
}

export function planParallelLaunches({
  launches = [],
  backendResolution,
  createLaunchId = () => randomUUID(),
  now = () => new Date().toISOString(),
} = {}) {
  const normalizedLaunches = launches.map(normalizeLaunchEntry);
  const layout = buildMuxLayout({
    backend: backendResolution.selectedBackend,
    launches: normalizedLaunches.map(({ request, agentValidation }) => ({
      agentIdentifier: agentValidation?.identifier ?? request?.requestedIdentifier,
      task: request?.task,
    })),
  });

  return normalizedLaunches.map((entry, requestIndex) => {
    const requestTimestamp = now();
    const launchId = createLaunchId();
    const plan = planSingleLaunch({
      request: entry.request,
      agentValidation: entry.agentValidation,
      backendResolution,
      createLaunchId: () => launchId,
      now: () => requestTimestamp,
    });

    return {
      ...entry,
      requestIndex,
      plan,
      layout: {
        ...layout.panes[requestIndex],
      },
    };
  });
}

export function createParallelLaunchController({
  launches = [],
  backendResolution,
  services = {},
  createLaunchId,
  now,
} = {}) {
  const plannedLaunches = planParallelLaunches({
    launches,
    backendResolution,
    createLaunchId,
    now,
  });
  const tracker = createParallelProgressTracker({ launches: plannedLaunches });

  const completionPromise = Promise.all(
    plannedLaunches.map(async (entry) => {
      const result = await launchSingleSubagent({
        request: entry.request,
        agentValidation: entry.agentValidation,
        backendResolution,
        services: buildLaunchServices(entry, tracker, services),
        createLaunchId: () => entry.plan.launchId,
        now: () => entry.plan.requestedAt,
      }).catch((error) => createUnexpectedFailure(entry, error));

      tracker.recordResult(result);
      return result;
    }),
  ).then(() => tracker.snapshot());

  return {
    plans: plannedLaunches,
    getProgress() {
      return tracker.snapshot();
    },
    completionPromise,
  };
}

export async function launchParallelSubagents(options = {}) {
  const controller = createParallelLaunchController(options);
  return controller.completionPromise;
}
