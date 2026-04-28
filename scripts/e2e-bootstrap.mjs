#!/usr/bin/env node
/**
 * E2E test bootstrap — ensures zellij tests never skip.
 *
 * If already inside zellij: runs tests directly.
 * Otherwise: spins up a zellij session inside tmux (zellij needs a
 * real PTY renderer for dump-screen to work), runs the test command
 * inside that session, and relays exit code.
 *
 * Usage: node scripts/e2e-bootstrap.mjs
 */

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const TEST_CMD = "node --test --test-concurrency=1 --test-timeout=600000 test/e2e/*.test.mjs";

// Already inside zellij — run tests directly
if (process.env.ZELLIJ) {
  const result = spawnSync("sh", ["-c", TEST_CMD], {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
    env: { ...process.env, SESSION_ID: "" },
  });
  process.exit(result.status ?? 1);
}

// Bootstrap: create zellij inside tmux for a real rendered session
const suffix = `${process.pid}-${Date.now()}`;
const tmuxSession = `e2e-zj-${suffix}`;
const zellijSession = `e2e-${suffix}`;
const logFile = path.join(tmpdir(), `e2e-out-${suffix}.log`);
const exitFile = path.join(tmpdir(), `e2e-exit-${suffix}`);

function cleanup() {
  try { execFileSync("tmux", ["kill-session", "-t", tmuxSession]); } catch { /* ok */ }
  try { execFileSync("zellij", ["delete-session", zellijSession, "--force"]); } catch { /* ok */ }
  try { unlinkSync(logFile); } catch { /* ok */ }
  try { unlinkSync(exitFile); } catch { /* ok */ }
}

process.on("SIGINT", () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });

try {
  console.log(`Bootstrapping zellij session "${zellijSession}" inside tmux...`);

  execFileSync("tmux", [
    "new-session", "-d", "-s", tmuxSession, "-x", "220", "-y", "60",
  ]);

  // Unset SESSION_ID to prevent extension auto-registration
  // (the copilot-sdk isn't available outside copilot runtime)
  execFileSync("tmux", [
    "send-keys", "-t", tmuxSession,
    "unset SESSION_ID", "Enter",
  ]);

  // Start zellij inside tmux (tmux provides the PTY renderer zellij needs)
  execFileSync("tmux", [
    "send-keys", "-t", tmuxSession,
    `zellij --session ${zellijSession}`, "Enter",
  ]);

  const zellijReady = waitForCondition(() => {
    const out = spawnSync("zellij", ["list-sessions"], { stdio: "pipe" });
    const stdout = String(out.stdout);
    // Match the session name but exclude EXITED sessions
    const lines = stdout.split("\n");
    return lines.some(
      (l) => l.includes(zellijSession) && !l.includes("EXITED"),
    );
  }, 15000);

  if (!zellijReady) {
    console.error("Failed to start zellij session within 15s");
    cleanup();
    process.exit(1);
  }

  // Dismiss the "About Zellij" floating pane
  execFileSync("tmux", ["send-keys", "-t", tmuxSession, "Escape", ""]);
  await sleep(1000);

  // Run the tests; capture exit code to a file. Use `set -o pipefail`
  // so the pipeline returns the test runner's exit code, not tee's.
  const testCmd = [
    `cd ${PROJECT_ROOT}`,
    `set -o pipefail`,
    `${TEST_CMD} 2>&1 | tee ${logFile}`,
    `echo $? > ${exitFile}`,
  ].join("; ");

  execFileSync("tmux", [
    "send-keys", "-t", tmuxSession, testCmd, "Enter",
  ]);

  console.log("Tests running inside zellij session. Waiting for completion...");

  // Poll for completion — stream output as it appears
  const maxWait = 2_700_000; // 45 minutes — full E2E suite with both backends
  const startTime = Date.now();
  let lastSize = 0;
  let exitCode = null;

  while (Date.now() - startTime < maxWait) {
    await sleep(3000);

    // Stream new output incrementally
    try {
      const log = readFileSync(logFile, "utf8");
      if (log.length > lastSize) {
        process.stdout.write(log.slice(lastSize));
        lastSize = log.length;
      }
    } catch { /* file not ready yet */ }

    try {
      const code = readFileSync(exitFile, "utf8").trim();
      if (code !== "") {
        exitCode = parseInt(code, 10);
        // Final flush
        try {
          const log = readFileSync(logFile, "utf8");
          if (log.length > lastSize) process.stdout.write(log.slice(lastSize));
        } catch { /* ok */ }
        break;
      }
    } catch { /* not done yet */ }
  }

  if (exitCode === null) {
    console.error("\nE2E tests timed out after 45 minutes");
    cleanup();
    process.exit(1);
  }

  cleanup();
  process.exit(exitCode);
} catch (err) {
  console.error("Bootstrap error:", err.message);
  cleanup();
  process.exit(1);
}

function waitForCondition(fn, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    spawnSync("sleep", ["0.5"]);
  }
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
