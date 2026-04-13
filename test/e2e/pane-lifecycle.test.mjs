/**
 * E2E tests for pane lifecycle — closePaneOnCompletion behavior
 * and copilotSessionId persistence across the lifecycle.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import {
  preflight,
  createBackendDriver,
  createE2EHandlers,
  createE2EWorkspace,
  createNonce,
  sleep,
} from "./e2e-helpers.mjs";

let capabilities;

before(async () => {
  capabilities = await preflight();
});

function defineBackendSuite(backend) {
  describe(`${backend} pane lifecycle`, () => {
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
      if (skipReason) { t.skip(skipReason); return true; }
      return false;
    }

    // ----- closePaneOnCompletion: true (default for autonomous) ----

    it("autonomous launch closes pane after completion by default", async (t) => {
      if (skipIfNeeded(t)) return;
      const workspacePath = await createE2EWorkspace(t);
      const { handlers } = await createE2EHandlers({
        backend,
        driver,
        workspacePath,
      });

      const result = await handlers.copilot_subagent_launch({
        workspacePath,
        requestedIdentifier: "github-copilot",
        task: "Respond with: pane-close-test",
        awaitCompletion: true,
        env: driver.env(),
      });

      assert.equal(result.ok, true);
      assert.equal(result.status, "success");
      assert.equal(result.paneVisible, false, "Pane should be closed after autonomous completion");
    });

    // ----- closePaneOnCompletion: false (keep pane alive) ----------

    it("closePaneOnCompletion=false keeps pane alive after completion", async (t) => {
      if (skipIfNeeded(t)) return;
      const workspacePath = await createE2EWorkspace(t);
      const { handlers } = await createE2EHandlers({
        backend,
        driver,
        workspacePath,
      });

      const result = await handlers.copilot_subagent_launch({
        workspacePath,
        requestedIdentifier: "github-copilot",
        task: "Respond with: keep-pane-test",
        awaitCompletion: true,
        closePaneOnCompletion: false,
        env: driver.env(),
      });

      assert.equal(result.ok, true);
      assert.equal(result.status, "success");
      assert.equal(result.paneVisible, true, "Pane should remain visible when closePaneOnCompletion=false");

      // Verify pane actually exists
      const alive = await driver.paneExists(result.paneId);
      assert.ok(alive, "Pane should still exist");
    });

    // ----- copilotSessionId persistence ----------------------------

    it("copilotSessionId is persisted in manifest and consistent across lifecycle", async (t) => {
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
        task: "Respond with: session-id-test",
        awaitCompletion: true,
        env: driver.env(),
      });

      assert.equal(result.ok, true, `Launch failed: ${JSON.stringify({ code: result.code, message: result.message, status: result.status })}`);

      // Verify copilotSessionId in result
      assert.ok(result.resumePointer, "Should have resumePointer");
      assert.ok(result.resumePointer.launchId, "resumePointer should have launchId");

      // Verify manifest
      const manifest = await stateStore.readLaunchRecord(result.launchId);
      assert.ok(manifest.copilotSessionId, "Manifest should have copilotSessionId");
      assert.equal(manifest.metadataVersion, 2, "Should be metadata v2");
      assert.equal(manifest.agentIdentifier, "github-copilot");
      assert.equal(manifest.backend, backend);
      assert.equal(manifest.status, "success");
      assert.equal(typeof manifest.requestedAt, "string", "Should have requestedAt timestamp");
    });
  });
}

defineBackendSuite("tmux");
defineBackendSuite("zellij");
