const TERMINAL_STATUSES = new Set(["success", "failure", "cancelled", "timeout", "ping"]);
const NON_FAILURE_TERMINAL = new Set(["success", "ping"]);
const NON_FAILURE_STATUSES = new Set(["pending", "running", "interactive", "success", "ping"]);

function cloneRecord(record) {
  return {
    ...record,
    layout: record.layout ? { ...record.layout } : null,
    resumePointer: record.resumePointer ? { ...record.resumePointer } : null,
  };
}

function normalizeLaunchEntry(entry, requestIndex) {
  const plan = entry?.plan ?? entry ?? {};

  return {
    launchId: plan.launchId,
    agentIdentifier: plan.agentIdentifier,
    agentKind: plan.agentKind,
    backend: plan.backend,
    launchAction: plan.launchAction ?? null,
    requestedAt: plan.requestedAt ?? null,
    requestIndex: entry?.requestIndex ?? requestIndex,
    paneId: plan.paneId ?? null,
    paneVisible: false,
    sessionId: plan.sessionId ?? null,
    status: plan.status ?? "pending",
    summary: plan.summary ?? null,
    summarySource: plan.summarySource ?? null,
    exitCode: plan.exitCode ?? null,
    metadataVersion: plan.metadataVersion ?? null,
    resumePointer: plan.resumePointer ?? null,
    layout: entry?.layout ? { ...entry.layout } : null,
  };
}

export function deriveAggregateStatus(results = []) {
  if (results.length === 0) {
    return "success";
  }

  if (results.some((result) => !TERMINAL_STATUSES.has(result.status))) {
    return "running";
  }

  const nonFailureTerminal = results.filter((result) => NON_FAILURE_TERMINAL.has(result.status)).length;
  if (nonFailureTerminal === results.length) {
    return "success";
  }

  if (nonFailureTerminal > 0) {
    return "partial-success";
  }

  if (results.every((result) => result.status === "cancelled")) {
    return "cancelled";
  }

  if (results.every((result) => result.status === "timeout")) {
    return "timeout";
  }

  return "failure";
}

export function createParallelProgressTracker({ launches = [] } = {}) {
  const orderedLaunchIds = [];
  const records = new Map();

  launches.forEach((entry, requestIndex) => {
    const record = normalizeLaunchEntry(entry, requestIndex);
    orderedLaunchIds.push(record.launchId);
    records.set(record.launchId, record);
  });

  function updateRecord(launchId, updates = {}) {
    const existing = records.get(launchId);
    if (!existing) {
      throw new Error(`Unknown launchId: ${launchId}`);
    }

    const next = {
      ...existing,
      ...updates,
    };
    records.set(launchId, next);
    return next;
  }

  function createSnapshot() {
    const results = orderedLaunchIds.map((launchId) => cloneRecord(records.get(launchId)));
    const progressByLaunchId = Object.fromEntries(
      results.map((result) => [result.launchId, result]),
    );

    return {
      aggregateStatus: deriveAggregateStatus(results),
      totalCount: results.length,
      completedCount: results.filter((result) => TERMINAL_STATUSES.has(result.status)).length,
      runningCount: results.filter((result) => result.status === "running").length,
      pendingCount: results.filter((result) => result.status === "pending").length,
      successCount: results.filter((result) => result.status === "success").length,
      pingCount: results.filter((result) => result.status === "ping").length,
      failureCount: results.filter((result) => !NON_FAILURE_STATUSES.has(result.status)).length,
      results,
      progressByLaunchId,
    };
  }

  return {
    markPaneOpened({ launchId, paneId, paneVisible = true, sessionId = null, layout } = {}) {
      return updateRecord(launchId, {
        paneId: paneId ?? null,
        paneVisible,
        sessionId,
        layout: layout ? { ...layout } : records.get(launchId)?.layout ?? null,
      });
    },

    markRunning({ launchId, paneId, sessionId = null, paneVisible = true, layout } = {}) {
      return updateRecord(launchId, {
        paneId: paneId ?? null,
        paneVisible,
        sessionId,
        status: "running",
        layout: layout ? { ...layout } : records.get(launchId)?.layout ?? null,
      });
    },

    recordResult(result = {}) {
      return updateRecord(result.launchId, {
        ...result,
        paneVisible: result.paneVisible ?? records.get(result.launchId)?.paneVisible ?? false,
      });
    },

    snapshot() {
      return createSnapshot();
    },
  };
}

