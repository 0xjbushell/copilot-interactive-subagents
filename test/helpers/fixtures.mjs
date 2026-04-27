import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Create a temporary Copilot session directory for testing.
 * Registers cleanup via t.after() if a test context is provided.
 */
export function createSessionDir(copilotSessionId, { copilotHome, t } = {}) {
  const home = copilotHome ?? path.join(os.tmpdir(), `.copilot-test-${process.pid}-${Date.now()}`);
  const dir = path.join(home, "session-state", copilotSessionId);
  fs.mkdirSync(dir, { recursive: true });

  if (t?.after) {
    t.after(() => {
      fs.rmSync(home, { recursive: true, force: true });
    });
  }

  return dir;
}

/**
 * Write an events.jsonl file into a session directory.
 * Returns the file path.
 */
export function createEventsJsonl(sessionDir, events = []) {
  const content = events.length > 0
    ? events.map((e) => JSON.stringify(e)).join("\n") + "\n"
    : "";
  const filePath = path.join(sessionDir, "events.jsonl");
  fs.writeFileSync(filePath, content);
  return filePath;
}

/**
 * Create a complete v2 launch manifest with sensible defaults.
 * Override any field via the overrides parameter.
 */
export function createManifestV2(overrides = {}) {
  return {
    launchId: overrides.launchId ?? "test-launch-001",
    agentIdentifier: overrides.agentIdentifier ?? "test-agent",
    agentKind: overrides.agentKind ?? "custom",
    backend: overrides.backend ?? "tmux",
    paneId: overrides.paneId ?? "%1",
    sessionId: overrides.sessionId ?? null,
    requestedAt: overrides.requestedAt ?? new Date().toISOString(),
    status: overrides.status ?? "pending",
    summary: overrides.summary ?? null,
    exitCode: overrides.exitCode ?? null,
    metadataVersion: overrides.metadataVersion ?? 3,
    copilotSessionId: overrides.copilotSessionId ?? "test-uuid-0000-0000-0000-000000000001",
    interactive: overrides.interactive ?? false,
    fork: overrides.fork ?? null,
    closePaneOnCompletion: overrides.closePaneOnCompletion ?? true,
    eventsBaseline: overrides.eventsBaseline ?? null,
    model: overrides.model ?? null,
  };
}

/**
 * Create a lockfile at the expected path for a Copilot session.
 * Returns { path, cleanup } where cleanup removes the lockfile.
 */
export function createLockfile(copilotSessionId, { lockDir, t } = {}) {
  const dir = lockDir ?? path.join(os.tmpdir(), `.copilot-test-locks-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const lockPath = path.join(dir, `${copilotSessionId}.lock`);
  fs.writeFileSync(lockPath, String(process.pid));

  const cleanup = () => {
    fs.rmSync(lockPath, { force: true });
    try { fs.rmdirSync(dir); } catch { /* dir not empty or already removed */ }
  };

  if (t?.after) {
    t.after(cleanup);
  }

  return { path: lockPath, cleanup };
}
