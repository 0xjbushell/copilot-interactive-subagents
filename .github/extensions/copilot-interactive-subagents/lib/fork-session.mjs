import { randomUUID } from "node:crypto";
import { cpSync as defaultCpSync, readFileSync as defaultReadFileSync, writeFileSync as defaultWriteFileSync, renameSync as defaultRenameSync, rmSync as defaultRmSync, existsSync as defaultExistsSync, mkdirSync as defaultMkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir as defaultHomedir } from "node:os";

import { acquireLock as defaultAcquireLock } from "./session-lock.mjs";

function resolveSessionDir({ copilotHome, copilotSessionId, services = {} }) {
  const homedir = services.homedir ?? defaultHomedir;
  const home = copilotHome ?? join(homedir(), ".copilot");
  return join(home, "session-state", copilotSessionId);
}

function updateWorkspaceYamlId({ dir, newId, services = {} }) {
  const readFileSync = services.readFileSync ?? defaultReadFileSync;
  const writeFileSync = services.writeFileSync ?? defaultWriteFileSync;
  const yamlPath = join(dir, "workspace.yaml");
  try {
    const content = readFileSync(yamlPath, "utf8");
    const updated = content.replace(/^(id:\s*).+$/m, `$1${newId}`);
    writeFileSync(yamlPath, updated);
  } catch {
    // workspace.yaml may not exist — not required
  }
}

function countEvents({ dir, services = {} }) {
  const readFileSync = services.readFileSync ?? defaultReadFileSync;
  try {
    const raw = readFileSync(join(dir, "events.jsonl"), "utf8");
    return raw.split("\n").filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

export function forkSession({
  parentCopilotSessionId,
  copilotHome,
  stateDir,
  services = {},
} = {}) {
  if (!parentCopilotSessionId) {
    return { ok: false, code: "FORK_INVALID", message: "parentCopilotSessionId is required" };
  }

  const cpSync = services.cpSync ?? defaultCpSync;
  const renameSync = services.renameSync ?? defaultRenameSync;
  const rmSync = services.rmSync ?? defaultRmSync;
  const existsSync = services.existsSync ?? defaultExistsSync;
  const mkdirSync = services.mkdirSync ?? defaultMkdirSync;
  const acquireLock = services.acquireLock ?? defaultAcquireLock;
  const generateId = services.generateId ?? randomUUID;

  const parentDir = resolveSessionDir({ copilotHome, copilotSessionId: parentCopilotSessionId, services });

  if (!existsSync(parentDir)) {
    return { ok: false, code: "FORK_NOT_FOUND", message: `Parent session directory not found: ${parentCopilotSessionId}` };
  }

  const childId = generateId();
  const sessionBase = join(parentDir, "..");
  const finalDir = join(sessionBase, childId);
  const tempDir = join(sessionBase, `.tmp-fork-${childId}`);

  // Acquire lock on parent to prevent concurrent fork/resume
  let lock;
  try {
    lock = acquireLock({ copilotSessionId: parentCopilotSessionId, stateDir });
  } catch (err) {
    if (err?.code === "SESSION_ACTIVE") {
      return { ok: false, code: "SESSION_ACTIVE", message: err.message };
    }
    throw err;
  }

  try {
    mkdirSync(sessionBase, { recursive: true });
    cpSync(parentDir, tempDir, { recursive: true });
    updateWorkspaceYamlId({ dir: tempDir, newId: childId, services });
    const eventsBaseline = countEvents({ dir: tempDir, services });
    renameSync(tempDir, finalDir);
    lock.release();

    return {
      ok: true,
      forkCopilotSessionId: childId,
      sessionPath: finalDir,
      eventsBaseline,
      parentCopilotSessionId,
    };
  } catch (error) {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
    lock.release();
    return {
      ok: false,
      code: "FORK_FAILED",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
