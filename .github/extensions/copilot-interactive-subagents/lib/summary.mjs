const SENTINEL_PATTERN = /__SUBAGENT_DONE_(-?\d+)__/;
const DEFAULT_POLL_INTERVAL_MS = 500;
const FALLBACK_STATE_TEXT = {
  success: "completed successfully",
  failure: "failed",
  cancelled: "was cancelled",
  timeout: "timed out",
  running: "is running",
  interactive: "is running interactively",
};

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir as defaultHomedir } from "node:os";

function normalizeOptionalText(value) {
  if (typeof value !== "string") {
    return value ?? null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function detectExitSentinel(paneOutput = "") {
  const match = String(paneOutput).match(SENTINEL_PATTERN);
  if (!match) {
    return null;
  }

  return {
    exitCode: Number.parseInt(match[1], 10),
    sentinel: match[0],
  };
}

function extractAssistantMessage(paneOutput = "") {
  const beforeSentinel = String(paneOutput).split("__SUBAGENT_DONE_")[0];
  const lines = beforeSentinel.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = lines[index].match(/^assistant[:>]\s*(.+)$/i);
    if (match) {
      return normalizeOptionalText(match[1]);
    }
  }

  return null;
}

function buildFallbackSummary({
  agentIdentifier,
  backend,
  paneId,
  sessionId,
  status,
  exitCode,
}) {
  const stateText = FALLBACK_STATE_TEXT[status] ?? "finished";
  const sessionText = sessionId ? ` Session ${sessionId}.` : "";
  const exitText = exitCode === null || exitCode === undefined ? "" : ` Exit code ${exitCode}.`;

  return `Subagent ${agentIdentifier} ${stateText} in ${backend} pane ${paneId}.${sessionText}${exitText}`.trim();
}

export function mapExitState({ exitCode, cancelled = false, timedOut = false } = {}) {
  if (timedOut) {
    return "timeout";
  }

  if (cancelled) {
    return "cancelled";
  }

  if (exitCode === 0) {
    return "success";
  }

  return "failure";
}

export function extractLaunchSummary({
  persistedExplicitSummary,
  paneOutput,
  agentIdentifier,
  backend,
  paneId,
  sessionId,
  status,
  exitCode,
} = {}) {
  const explicitSummary = normalizeOptionalText(persistedExplicitSummary);
  if (explicitSummary) {
    return {
      source: "explicit-summary",
      summary: explicitSummary,
    };
  }

  const assistantSummary = extractAssistantMessage(paneOutput);
  if (assistantSummary) {
    return {
      source: "assistant-message",
      summary: assistantSummary,
    };
  }

  return {
    source: "fallback",
    summary: buildFallbackSummary({
      agentIdentifier,
      backend,
      paneId,
      sessionId,
      status,
      exitCode,
    }),
  };
}

function parseEventsJsonl(raw) {
  const events = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try { events.push(JSON.parse(line)); } catch { /* truncated trailing line */ }
  }
  return events;
}

function findLastAssistantContent(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === "assistant.message" && event.data?.content) {
      return normalizeOptionalText(event.data.content);
    }
  }
  return null;
}

export function extractSessionSummary({
  copilotSessionId,
  sinceEventIndex,
  copilotHome,
  services = {},
} = {}) {
  const homedir = services.homedir ?? defaultHomedir;
  const readFile = services.readFileSync ?? readFileSync;
  const home = copilotHome ?? join(homedir(), ".copilot");
  const sessionDir = join(home, "session-state", copilotSessionId);

  let events;
  try {
    events = parseEventsJsonl(readFile(join(sessionDir, "events.jsonl"), "utf8"));
  } catch {
    return { summary: null, source: "fallback", lastEventIndex: 0 };
  }

  const totalEvents = events.length;
  const startIndex = typeof sinceEventIndex === "number" ? sinceEventIndex : 0;
  const content = findLastAssistantContent(events.slice(startIndex));
  if (content) {
    return { summary: content, source: "events.jsonl", lastEventIndex: totalEvents };
  }

  if (typeof sinceEventIndex !== "number") {
    try {
      const yaml = readFile(join(sessionDir, "workspace.yaml"), "utf8");
      const match = yaml.match(/^summary:\s*(.+)$/m);
      const text = match ? normalizeOptionalText(match[1]) : null;
      if (text) return { summary: text, source: "workspace.yaml", lastEventIndex: totalEvents };
    } catch { /* No workspace.yaml */ }
  }

  return { summary: null, source: sinceEventIndex != null ? "events.jsonl" : "fallback", lastEventIndex: totalEvents };
}

export async function waitForLaunchCompletion({
  backend,
  paneId,
  sessionId = null,
  agentIdentifier,
  request,
  readPaneOutput,
  readChildSessionState,
  maxAttempts = 25,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  sleep = async (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (typeof readPaneOutput !== "function") {
    throw new Error("Pane output monitoring is not configured.");
  }

  let latestOutput = "";
  let latestObservation = {};

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    latestObservation = (await readPaneOutput({
      backend,
      paneId,
      sessionId,
      agentIdentifier,
      request,
      attempt,
    })) ?? {};
    latestOutput = latestObservation.output ?? latestOutput;

    const sentinel = detectExitSentinel(latestOutput);
    if (sentinel) {
      const persistedChildState = typeof readChildSessionState === "function"
        ? await readChildSessionState({ backend, paneId, sessionId, agentIdentifier, request })
        : null;
      const status = mapExitState({
        exitCode: sentinel.exitCode,
        cancelled: Boolean(latestObservation.cancelled),
        timedOut: Boolean(latestObservation.timedOut),
      });
      const summary = extractLaunchSummary({
        persistedExplicitSummary:
          latestObservation.persistedExplicitSummary ??
          latestObservation.summary ??
          persistedChildState?.summary,
        paneOutput: latestOutput,
        agentIdentifier,
        backend,
        paneId,
        sessionId,
        status,
        exitCode: sentinel.exitCode,
      });

      return {
        status,
        exitCode: sentinel.exitCode,
        summary: summary.summary,
        summarySource: summary.source,
        paneOutput: latestOutput,
      };
    }

    if (attempt + 1 < maxAttempts && pollIntervalMs > 0) {
      await sleep(pollIntervalMs);
    }
  }

  const summary = extractLaunchSummary({
    persistedExplicitSummary: latestObservation.persistedExplicitSummary ?? latestObservation.summary,
    paneOutput: latestOutput,
    agentIdentifier,
    backend,
    paneId,
    sessionId,
    status: "timeout",
    exitCode: null,
  });

  return {
    status: "timeout",
    exitCode: null,
    summary: summary.summary,
    summarySource: summary.source,
    paneOutput: latestOutput,
  };
}
