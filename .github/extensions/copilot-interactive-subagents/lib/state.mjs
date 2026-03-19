import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const METADATA_VERSION = 1;
export const LAUNCH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const SUPPORTED_BACKENDS = ["cmux", "tmux", "zellij"];
const DEFAULT_STORE_DIRECTORY = path.join(".copilot-interactive-subagents", "launches");

function normalizeOptionalText(value) {
  if (typeof value !== "string") {
    return value ?? null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeExitCode(value) {
  if (value === null || value === undefined) {
    return null;
  }

  return Number.isInteger(value) ? value : Number.parseInt(value, 10);
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
      return createLaunchRecord(JSON.parse(contents));
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
