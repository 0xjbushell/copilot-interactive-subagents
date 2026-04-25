/**
 * E2E test helpers — real backend operations, no mocking.
 *
 * These utilities create isolated mux sessions, invoke extension handlers
 * with real backend commands, and verify results via manifests + pane state.
 *
 * Requirements:
 *   - copilot CLI authenticated
 *   - tmux: automatically creates detached session (works from any terminal)
 *   - zellij: must run from INSIDE an active zellij session (tests skip otherwise)
 */

import { execFile as execFileCb } from "node:child_process";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Preflight — run once per suite to check environment capabilities
// ---------------------------------------------------------------------------

export async function preflight() {
  const results = { copilot: false, tmux: false, zellij: false };

  try {
    await execFile("copilot", ["--version"]);
    results.copilot = true;
  } catch { /* not available */ }

  try {
    await execFile("tmux", ["-V"]);
    results.tmux = true;
  } catch { /* not available */ }

  // Zellij E2E requires being inside a zellij session
  if (process.env.ZELLIJ) {
    try {
      await execFile("zellij", ["--version"]);
      results.zellij = true;
    } catch { /* not available */ }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Backend drivers — create/destroy isolated mux sessions
// ---------------------------------------------------------------------------

export function createBackendDriver(backend) {
  if (backend === "tmux") return createTmuxDriver();
  if (backend === "zellij") return createZellijDriver();
  throw new Error(`Unsupported backend: ${backend}`);
}

function createTmuxDriver() {
  const sessionName = `e2e-${randomUUID().slice(0, 8)}`;

  return {
    backend: "tmux",
    sessionName,

    async setup() {
      await execFile("tmux", [
        "new-session", "-d", "-s", sessionName, "-x", "200", "-y", "50",
      ]);
    },

    async teardown() {
      try {
        await execFile("tmux", ["kill-session", "-t", sessionName]);
      } catch { /* already dead */ }
    },

    env() {
      return {};
    },

    async capturePane(paneId) {
      const { stdout } = await execFile("tmux", [
        "capture-pane", "-p", "-t", paneId, "-S", "-500",
      ]);
      return stdout;
    },

    async sendKeys(paneId, text) {
      await execFile("tmux", ["send-keys", "-t", paneId, "-l", text]);
      await execFile("tmux", ["send-keys", "-t", paneId, "Enter"]);
    },

    async paneExists(paneId) {
      try {
        await execFile("tmux", ["has-session", "-t", paneId]);
        return true;
      } catch {
        return false;
      }
    },
  };
}

function createZellijDriver() {
  const sessionName = process.env.ZELLIJ_SESSION_NAME ?? "unknown";

  return {
    backend: "zellij",
    sessionName,

    async setup() {
      // Zellij E2E reuses the current zellij session.
      // Preflight ensures we're inside one; this is a no-op.
    },

    async teardown() {
      // Close all non-default panes to prevent accumulation across test suites.
      // Zellij reuses the session so orphan panes from prior tests can cause
      // resource exhaustion and timeouts.
      try {
        const { stdout } = await execFile("zellij", ["action", "list-panes"]);
        const lines = stdout.trim().split("\n").slice(1); // skip header
        for (const line of lines) {
          const id = line.split(/\s+/)[0]; // e.g. "terminal_5"
          const numericId = id.replace("terminal_", "");
          if (numericId !== "0") {
            try {
              await execFile("zellij", ["action", "close-pane", "--pane-id", numericId]);
            } catch { /* best effort */ }
          }
        }
      } catch { /* list-panes not available or failed */ }
    },

    env() {
      return {
        ZELLIJ: process.env.ZELLIJ,
        ZELLIJ_PANE_ID: process.env.ZELLIJ_PANE_ID ?? "0",
        ZELLIJ_SESSION_NAME: sessionName,
      };
    },

    async capturePane(paneId) {
      const numericId = stripPanePrefix(paneId);
      const { stdout } = await execFile("zellij", [
        "action", "dump-screen", "--pane-id", numericId, "-f",
      ]);
      return stdout;
    },

    async sendKeys(paneId, text) {
      const numericId = stripPanePrefix(paneId);
      await execFile("zellij", [
        "action", "write-chars", "--pane-id", numericId, text,
      ]);
      // Send Enter as byte 13
      await execFile("zellij", [
        "action", "write", "--pane-id", numericId, "13",
      ]);
    },

    async paneExists(paneId) {
      const numericId = stripPanePrefix(paneId);
      try {
        await execFile("zellij", [
          "action", "dump-screen", "--pane-id", numericId,
        ]);
        return true;
      } catch {
        return false;
      }
    },
  };
}

function stripPanePrefix(paneId) {
  return String(paneId).startsWith("pane:") ? String(paneId).slice(5) : String(paneId);
}

// ---------------------------------------------------------------------------
// Extension handler factory — wires real defaults with test-specific config
// ---------------------------------------------------------------------------

export async function createE2EHandlers({ backend, driver, workspacePath }) {
  const { createExtensionHandlers } = await import(
    path.resolve(".", "packages/copilot-interactive-subagents/extension/extension.mjs")
  );
  const { createStateStore } = await import(
    path.resolve(".", "packages/copilot-interactive-subagents/extension/lib/state.mjs")
  );

  const handlers = await createExtensionHandlers({
    enumerateCustomAgents: async () => [],
    createStateStore: () => createStateStore({ workspacePath }),
    resolveLaunchBackend: async () => ({
      ok: true,
      selectedBackend: backend,
      // "start" tells the handler to target the named session
      action: "start",
      // For tmux: targets our pre-created isolated session
      // For zellij: session name is informational (actions use ZELLIJ env)
      sessionName: driver.sessionName,
      manualSetupRequired: false,
    }),
  });

  const stateStore = createStateStore({ workspacePath });

  return { handlers, stateStore };
}

// ---------------------------------------------------------------------------
// Workspace & cleanup
// ---------------------------------------------------------------------------

export async function createE2EWorkspace(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "e2e-lifecycle-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------------------------------------------------------------------
// Manifest reading
// ---------------------------------------------------------------------------

export async function readAllManifests(workspacePath) {
  const launchesDir = path.join(workspacePath, ".copilot-interactive-subagents", "launches");
  try {
    const files = await readdir(launchesDir);
    const manifests = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const content = await readFile(path.join(launchesDir, file), "utf8");
      manifests.push(JSON.parse(content));
    }
    return manifests;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Polling helper
// ---------------------------------------------------------------------------

export async function waitFor(fn, { timeoutMs = 60_000, intervalMs = 1000, label = "condition" } = {}) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (err) {
      lastError = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`waitFor(${label}) timed out after ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ""}`);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Nonce generator for deterministic assertions
// ---------------------------------------------------------------------------

export function createNonce() {
  return `e2e-${randomUUID().slice(0, 8)}`;
}
