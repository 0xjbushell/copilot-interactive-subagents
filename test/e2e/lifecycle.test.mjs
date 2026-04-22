/**
 * E2E lifecycle tests — real copilot sessions in real mux panes.
 *
 * Scenarios are parameterized across backends (tmux, zellij).
 * Each backend gets its own describe block with identical test logic.
 *
 * Run: npm run test:e2e
 * Requirements:
 *   - copilot CLI authenticated
 *   - tmux: works from any terminal (creates detached session)
 *   - zellij: must be run from inside a zellij session
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import {
  preflight,
  createBackendDriver,
  createE2EHandlers,
  createE2EWorkspace,
  createNonce,
  waitFor,
  sleep,
} from "./e2e-helpers.mjs";

// ---------------------------------------------------------------------------
// Suite-level preflight
// ---------------------------------------------------------------------------

let capabilities;

before(async () => {
  capabilities = await preflight();
});

// ---------------------------------------------------------------------------
// Shared scenario definitions — parameterized by backend
// ---------------------------------------------------------------------------

function defineBackendSuite(backend) {
  describe(`${backend} lifecycle`, () => {
    let driver;
    let skipReason = null;

    before(async () => {
      if (!capabilities.copilot) {
        skipReason = "copilot CLI not available";
        return;
      }
      if (!capabilities[backend]) {
        skipReason = `${backend} not available`;
        return;
      }
      driver = createBackendDriver(backend);
      await driver.setup();
    });

    after(async () => {
      if (driver) await driver.teardown();
    });

    function skipIfNeeded(t) {
      if (skipReason) {
        t.skip(skipReason);
        return true;
      }
      return false;
    }

    // ----- Scenario 1: Launch + await completion ---------------------------

    it("launch with awaitCompletion returns success with manifest", async (t) => {
      if (skipIfNeeded(t)) return;
      const workspacePath = await createE2EWorkspace(t);
      const nonce = createNonce();
      const { handlers, stateStore } = await createE2EHandlers({
        backend,
        driver,
        workspacePath,
      });

      const result = await handlers.copilot_subagent_launch({
        workspacePath,
        requestedIdentifier: "github-copilot",
        task: `Respond with exactly this text and nothing else: ${nonce}`,
        awaitCompletion: true,
        env: driver.env(),
      });

      // Primary oracle: handler result
      assert.equal(result.ok, true, `Expected ok=true, got: ${JSON.stringify(result)}`);
      assert.equal(result.status, "success");
      assert.equal(result.exitCode, 0);
      assert.equal(result.backend, backend);
      assert.ok(result.launchId, "Should have launchId");
      assert.ok(result.paneId, "Should have paneId");

      // Secondary oracle: persisted manifest
      const manifest = await stateStore.readLaunchRecord(result.launchId);
      assert.equal(manifest.status, "success");
      assert.equal(manifest.exitCode, 0);
      assert.equal(manifest.backend, backend);
      assert.equal(manifest.metadataVersion, 3);
      assert.ok(manifest.copilotSessionId, "Manifest should have copilotSessionId");
    });

    // ----- Scenario 2: Launch fire-and-forget ------------------------------

    it("launch without awaitCompletion returns running with live pane", async (t) => {
      if (skipIfNeeded(t)) return;
      const workspacePath = await createE2EWorkspace(t);
      const nonce = createNonce();
      const { handlers, stateStore } = await createE2EHandlers({
        backend,
        driver,
        workspacePath,
      });

      const result = await handlers.copilot_subagent_launch({
        workspacePath,
        requestedIdentifier: "github-copilot",
        task: `Respond with exactly this text and nothing else: ${nonce}`,
        awaitCompletion: false,
        env: driver.env(),
      });

      assert.equal(result.ok, true, `Expected ok=true, got: ${JSON.stringify(result)}`);
      assert.equal(result.status, "running");
      assert.equal(result.backend, backend);
      assert.ok(result.paneId, "Should have paneId");

      // Verify the pane actually exists
      const paneAlive = await driver.paneExists(result.paneId);
      assert.ok(paneAlive, "Pane should exist after fire-and-forget launch");

      // Verify manifest is in running state (fire-and-forget doesn't poll for completion)
      const manifest = await stateStore.readLaunchRecord(result.launchId);
      assert.equal(manifest.status, "running");
      assert.equal(manifest.backend, backend);
      assert.ok(manifest.copilotSessionId, "Manifest should have copilotSessionId");
    });

    // ----- Scenario 3: Resume a completed session --------------------------

    it("resume a completed session opens new pane and succeeds", async (t) => {
      if (skipIfNeeded(t)) return;
      const workspacePath = await createE2EWorkspace(t);
      const { handlers, stateStore } = await createE2EHandlers({
        backend,
        driver,
        workspacePath,
      });

      // Step 1: Initial launch
      const initial = await handlers.copilot_subagent_launch({
        workspacePath,
        requestedIdentifier: "github-copilot",
        task: "Respond with: initial-run-ok",
        awaitCompletion: true,
        env: driver.env(),
      });

      assert.equal(initial.ok, true, `Initial launch failed: ${JSON.stringify(initial)}`);
      assert.equal(initial.status, "success");

      // Brief pause to let pane close propagate (zellij close-pane is async)
      await sleep(2000);

      // Step 2: Resume with new task
      const resumed = await handlers.copilot_subagent_resume({
        workspacePath,
        launchId: initial.launchId,
        task: "Respond with: resume-ok",
        awaitCompletion: true,
        maxMonitorAttempts: 60,
        pollIntervalMs: 1000,
        env: driver.env(),
      });

      assert.equal(resumed.ok, true, `Resume failed: ${JSON.stringify(resumed)}`);
      assert.equal(resumed.status, "success");

      // Verify resume opened a different pane than the original
      assert.ok(resumed.paneId, "Resumed should have a paneId");
      assert.notEqual(
        resumed.paneId,
        initial.paneId,
        "Resumed pane should differ from original (new pane for resumed session)",
      );

      // Verify manifest: same launchId, updated state
      const manifest = await stateStore.readLaunchRecord(initial.launchId);
      assert.equal(manifest.status, "success");
      assert.equal(manifest.launchId, initial.launchId);
    });

    // ----- Scenario 4: Parallel launch ------------------------------------

    it("parallel launch completes both agents successfully", async (t) => {
      if (skipIfNeeded(t)) return;
      const workspacePath = await createE2EWorkspace(t);
      const nonce1 = createNonce();
      const nonce2 = createNonce();
      const { handlers } = await createE2EHandlers({
        backend,
        driver,
        workspacePath,
      });

      const result = await handlers.copilot_subagent_parallel({
        workspacePath,
        launches: [
          {
            requestedIdentifier: "github-copilot",
            task: `Respond with exactly: ${nonce1}`,
          },
          {
            requestedIdentifier: "github-copilot",
            task: `Respond with exactly: ${nonce2}`,
          },
        ],
        awaitCompletion: true,
        env: driver.env(),
      });

      assert.equal(result.aggregateStatus, "success", `Parallel launch failed: ${JSON.stringify(result).slice(0, 500)}`);
      assert.ok(Array.isArray(result.results), "Should have results array");
      assert.equal(result.results.length, 2, "Should have 2 results");

      for (const r of result.results) {
        assert.equal(r.status, "success", `Agent failed: ${JSON.stringify(r).slice(0, 300)}`);
        assert.equal(r.exitCode, 0);
        assert.ok(r.paneId, "Result should have paneId");
        assert.ok(r.launchId, "Result should have launchId");
      }
    });

    // ----- Scenario 5: Interactive mode + round-trip ----------------------

    it("interactive launch keeps pane alive for user interaction", async (t) => {
      if (skipIfNeeded(t)) return;
      const workspacePath = await createE2EWorkspace(t);
      const { handlers, stateStore } = await createE2EHandlers({
        backend,
        driver,
        workspacePath,
      });

      const result = await handlers.copilot_subagent_launch({
        workspacePath,
        requestedIdentifier: "github-copilot",
        task: "You are a test agent. Wait for user input.",
        awaitCompletion: false,
        interactive: true,
        env: driver.env(),
      });

      assert.equal(result.ok, true, `Interactive launch failed: ${JSON.stringify(result)}`);
      assert.equal(result.status, "interactive");
      assert.ok(result.paneId, "Should have paneId");
      assert.ok(result.launchId, "Should have launchId");

      // Give copilot a moment to start in the pane
      await sleep(5000);

      // Verify pane is alive
      const paneAlive = await driver.paneExists(result.paneId);
      assert.ok(paneAlive, "Interactive pane should remain alive");

      // Verify manifest shows interactive status
      const manifest = await stateStore.readLaunchRecord(result.launchId);
      assert.equal(manifest.status, "interactive");
      assert.equal(manifest.interactive, true);
      assert.ok(manifest.copilotSessionId, "Should have copilotSessionId");
    });
  });
}

// ---------------------------------------------------------------------------
// Register backend suites
// ---------------------------------------------------------------------------

defineBackendSuite("tmux");
defineBackendSuite("zellij");
