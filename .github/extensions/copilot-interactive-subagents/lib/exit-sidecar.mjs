import {
  writeFileSync as defaultWriteFileSync,
  readFileSync as defaultReadFileSync,
  mkdirSync as defaultMkdirSync,
  unlinkSync as defaultUnlinkSync,
  existsSync as defaultExistsSync,
  renameSync as defaultRenameSync,
} from "node:fs";
import path from "node:path";

export const SIDECAR_VERSION = 1;
export const SIDECAR_DIRNAME = "exit";

const STATE_DIR_NAME = ".copilot-interactive-subagents";
const ALLOWED_TYPES = new Set(["done", "ping"]);

export function resolveStateDir({ projectRoot } = {}) {
  const root = projectRoot ?? process.cwd();
  return path.resolve(root, STATE_DIR_NAME);
}

function sidecarPath(stateDir, launchId) {
  return path.join(stateDir, SIDECAR_DIRNAME, `${launchId}.json`);
}

export function writeExitSidecar({
  launchId,
  type,
  summary,
  message,
  exitCode,
  stateDir,
  services = {},
} = {}) {
  const writeFileSync = services.writeFileSync ?? defaultWriteFileSync;
  const mkdirSync = services.mkdirSync ?? defaultMkdirSync;
  const renameSync = services.renameSync ?? defaultRenameSync;
  const now = services.now ?? (() => new Date().toISOString());

  const exitDir = path.join(stateDir, SIDECAR_DIRNAME);
  mkdirSync(exitDir, { recursive: true });

  const record = {
    version: SIDECAR_VERSION,
    type,
    writtenAt: now(),
    launchId,
  };
  if (type === "done") {
    record.summary = summary ?? null;
    record.exitCode = exitCode ?? null;
  } else if (type === "ping") {
    record.message = message ?? null;
  }

  const finalPath = sidecarPath(stateDir, launchId);
  const tmpPath = `${finalPath}.tmp`;
  const json = `${JSON.stringify(record, null, 2)}\n`;
  writeFileSync(tmpPath, json);
  renameSync(tmpPath, finalPath);
}

function isValidRecord(parsed) {
  if (!parsed || typeof parsed !== "object") return false;
  if (parsed.version !== SIDECAR_VERSION) return false;
  if (!ALLOWED_TYPES.has(parsed.type)) return false;
  if (typeof parsed.launchId !== "string" || parsed.launchId.length === 0) return false;
  if (typeof parsed.writtenAt !== "string") return false;
  return true;
}

export function readExitSidecar({ launchId, stateDir, services = {} } = {}) {
  const readFileSync = services.readFileSync ?? defaultReadFileSync;
  const existsSync = services.existsSync ?? defaultExistsSync;
  const warn = services.warn ?? console.warn;

  const filePath = sidecarPath(stateDir, launchId);
  if (!existsSync(filePath)) return null;

  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    warn(`exit-sidecar: failed to read ${filePath}: ${err?.message ?? err}`);
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    warn(`exit-sidecar: malformed JSON at ${filePath}: ${err?.message ?? err}`);
    return null;
  }

  if (!isValidRecord(parsed)) {
    warn(`exit-sidecar: invalid record at ${filePath} (failed schema check)`);
    return null;
  }

  return parsed;
}

export function deleteExitSidecar({ launchId, stateDir, services = {} } = {}) {
  const unlinkSync = services.unlinkSync ?? defaultUnlinkSync;
  const existsSync = services.existsSync ?? defaultExistsSync;
  const filePath = sidecarPath(stateDir, launchId);
  if (!existsSync(filePath)) return;
  try {
    unlinkSync(filePath);
  } catch (err) {
    if (err?.code === "ENOENT") return;
    throw err;
  }
}
