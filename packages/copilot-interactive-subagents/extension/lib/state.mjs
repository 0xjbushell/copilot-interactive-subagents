import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { normalizeOptionalText, normalizeExitCode } from "./utils.mjs";

export const METADATA_VERSION = 3;
export const LAUNCH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const SUPPORTED_BACKENDS = ["cmux", "tmux", "zellij"];
const DEFAULT_STORE_DIRECTORY = path.join(".copilot-interactive-subagents", "launches");

export function assertSupportedMetadataVersion(parsed, { source = "manifest" } = {}) {
  const version = parsed?.metadataVersion;
  if (version !== METADATA_VERSION) {
    const error = new Error(
      `Unsupported ${source} version: ${version} (expected ${METADATA_VERSION}). Hard cutover; no migration.`,
    );
    error.code = "MANIFEST_VERSION_UNSUPPORTED";
    error.observedVersion = version;
    throw error;
  }
}

function resolveStoreRoot({ workspacePath, projectRoot = process.cwd(), storeDirectory = DEFAULT_STORE_DIRECTORY } = {}) {
  return path.resolve(workspacePath ?? projectRoot, storeDirectory);
}

export function isValidLaunchId(value) {
  return typeof value === "string" && LAUNCH_ID_PATTERN.test(value);
}

export function assertValidLaunchId(launchId) {
  if (isValidLaunchId(launchId)) {
    return launchId;
  }

  const error = new Error(
    "launchId must use only letters, numbers, periods, underscores, and hyphens.",
  );
  error.code = "INVALID_LAUNCH_ID";
  throw error;
}

export function isSupportedBackend(value) {
  return typeof value === "string" && SUPPORTED_BACKENDS.includes(value);
}

function resolveManifestPath(launchId, options = {}) {
  const rootDirectory = resolveStoreRoot(options);
  const validatedLaunchId = assertValidLaunchId(launchId);
  const manifestPath = path.resolve(rootDirectory, `${validatedLaunchId}.json`);
  const rootPrefix = `${rootDirectory}${path.sep}`;
  if (manifestPath !== `${rootDirectory}/${validatedLaunchId}.json` && !manifestPath.startsWith(rootPrefix)) {
    const error = new Error("Resolved manifest path escapes the state store root.");
    error.code = "INVALID_LAUNCH_ID";
    throw error;
  }

  return manifestPath;
}

export function createLaunchRecord({
  launchId,
  agentIdentifier,
  agentKind,
  backend,
  paneId,
  sessionId = null,
  requestedAt,
  status = "pending",
  summary = null,
  exitCode = null,
  metadataVersion = METADATA_VERSION,
  copilotSessionId = null,
  interactive = false,
  fork = null,
  closePaneOnCompletion = true,
  eventsBaseline = null,
  pingHistory = [],
  lastExitType = null,
  sidecarPath = null,
  model = null,
} = {}) {
  const validatedLaunchId = assertValidLaunchId(launchId);
  return {
    launchId: validatedLaunchId,
    agentIdentifier,
    agentKind,
    backend,
    paneId,
    sessionId: normalizeOptionalText(sessionId),
    requestedAt,
    status,
    summary: normalizeOptionalText(summary),
    exitCode: normalizeExitCode(exitCode),
    metadataVersion,
    copilotSessionId: copilotSessionId ?? null,
    interactive: interactive === true,
    fork: fork ?? null,
    closePaneOnCompletion: closePaneOnCompletion !== false,
    eventsBaseline: eventsBaseline ?? null,
    pingHistory: Array.isArray(pingHistory) ? [...pingHistory] : [],
    lastExitType: lastExitType ?? null,
    sidecarPath: sidecarPath ?? null,
    model: model ?? null,
  };
}

export function serializeLaunchRecord(record) {
  return `${JSON.stringify(createLaunchRecord(record), null, 2)}\n`;
}

export function buildResumePointer(record, options = {}) {
  return {
    launchId: record.launchId,
    sessionId: record.sessionId ?? null,
    agentIdentifier: record.agentIdentifier,
    backend: record.backend,
    paneId: record.paneId,
    manifestPath: resolveManifestPath(record.launchId, options),
  };
}

export function createStateStore(options = {}) {
  const rootDirectory = resolveStoreRoot(options);

  return {
    rootDirectory,
    async writeLaunchRecord(record) {
      const manifest = createLaunchRecord(record);
      await mkdir(rootDirectory, { recursive: true });
      await writeFile(resolveManifestPath(manifest.launchId, options), serializeLaunchRecord(manifest), "utf8");
      return manifest;
    },
    async readLaunchRecord(launchId) {
      const contents = await readFile(resolveManifestPath(launchId, options), "utf8");
      const parsed = JSON.parse(contents);
      assertSupportedMetadataVersion(parsed, { source: "manifest" });
      return createLaunchRecord(parsed);
    },
    async updateLaunchRecord(launchId, updates = {}) {
      const existing = await this.readLaunchRecord(launchId);
      const updated = createLaunchRecord({
        ...existing,
        ...updates,
        launchId: existing.launchId,
      });
      await this.writeLaunchRecord(updated);
      return updated;
    },
  };
}
