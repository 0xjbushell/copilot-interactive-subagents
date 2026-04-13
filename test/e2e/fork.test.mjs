/**
 * E2E tests for fork — launching a new agent with forked session context.
 *
 * Fork copies a parent copilot session's state so the child agent has
 * the parent's conversation history as context.
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
  describe(`${backend} fork`, () => {
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

    it("fork from launchId creates child with parent context", async (t) => {
      if (skipIfNeeded(t)) return;
      const workspacePath = await createE2EWorkspace(t);
      const { handlers, stateStore } = await createE2EHandlers({
        backend,
        driver,
        workspacePath,
      });

      // Step 1: Create parent session
      const parent = await handlers.copilot_subagent_launch({
        workspacePath,
        requestedIdentifier: "github-copilot",
        task: "Remember this secret code: FORK_PARENT_42. Respond with: parent-done",
        awaitCompletion: true,
        env: driver.env(),
      });

      assert.equal(parent.ok, true, `Parent launch failed: ${JSON.stringify(parent)}`);
      assert.equal(parent.status, "success");

      const parentManifest = await stateStore.readLaunchRecord(parent.launchId);
      assert.ok(parentManifest.copilotSessionId, "Parent should have copilotSessionId");

      await sleep(2000);

      // Step 2: Fork from parent — child should have parent's context
      const child = await handlers.copilot_subagent_launch({
        workspacePath,
        requestedIdentifier: "github-copilot",
        task: "What was the secret code from the previous conversation? Respond with just the code.",
        awaitCompletion: true,
        fork: { launchId: parent.launchId },
        env: driver.env(),
      });

      assert.equal(child.ok, true, `Fork launch failed: ${JSON.stringify(child)}`);
      assert.equal(child.status, "success");

      // Verify child has a different launchId
      assert.notEqual(child.launchId, parent.launchId);

      // Verify child manifest has fork metadata
      const childManifest = await stateStore.readLaunchRecord(child.launchId);
      assert.ok(childManifest.copilotSessionId, "Child should have copilotSessionId");
      assert.notEqual(
        childManifest.copilotSessionId,
        parentManifest.copilotSessionId,
        "Child should have a different copilotSessionId (forked copy)",
      );
      assert.ok(childManifest.fork, "Child manifest should have fork metadata");
      assert.equal(
        childManifest.fork.parentCopilotSessionId,
        parentManifest.copilotSessionId,
        "Fork should reference parent's copilotSessionId",
      );
    });
  });
}

defineBackendSuite("tmux");
defineBackendSuite("zellij");
