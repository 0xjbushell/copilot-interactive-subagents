import { openSync, writeFileSync, readFileSync, unlinkSync, mkdirSync, constants } from "node:fs";
import path from "node:path";

const DEFAULT_STATE_DIR = ".copilot-interactive-subagents";

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireLock({ copilotSessionId, stateDir, services = {} } = {}) {
  const fs = {
    openSync: services.openSync ?? openSync,
    writeFileSync: services.writeFileSync ?? writeFileSync,
    readFileSync: services.readFileSync ?? readFileSync,
    unlinkSync: services.unlinkSync ?? unlinkSync,
    mkdirSync: services.mkdirSync ?? mkdirSync,
  };
  const checkAlive = services.isProcessAlive ?? isProcessAlive;
  const getPid = services.pid ?? (() => process.pid);
  const getNow = services.now ?? Date.now;

  const baseDir = stateDir ?? DEFAULT_STATE_DIR;
  const lockDir = path.join(baseDir, "locks");
  fs.mkdirSync(lockDir, { recursive: true });
  const lockPath = path.join(lockDir, `${copilotSessionId}.lock`);

  const content = JSON.stringify({ pid: getPid(), startedAt: getNow() });

  try {
    const fd = fs.openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    fs.writeFileSync(fd, content);
    // fd auto-closed by writeFileSync when given a number
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;

    // Lock file exists — check if owner is alive
    let existing;
    try {
      existing = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    } catch {
      // Corrupt lock file — remove and retry
      tryUnlink(fs, lockPath);
      return acquireLock({ copilotSessionId, stateDir, services });
    }

    if (existing.pid && checkAlive(existing.pid)) {
      const error = new Error("Session is currently active in another pane. Close or wait for completion before resuming.");
      error.code = "SESSION_ACTIVE";
      throw error;
    }

    // Stale lock — owner is dead, recover
    tryUnlink(fs, lockPath);
    return acquireLock({ copilotSessionId, stateDir, services });
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    tryUnlink(fs, lockPath);
    removeExitHandler();
  };

  const exitHandler = () => release();
  process.on("exit", exitHandler);
  const removeExitHandler = () => {
    try { process.removeListener("exit", exitHandler); } catch { /* best effort */ }
  };

  return { release };
}

function tryUnlink(fs, filePath) {
  try { fs.unlinkSync(filePath); } catch { /* already gone */ }
}
