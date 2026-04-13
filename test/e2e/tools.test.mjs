/**
 * E2E tests for list_agents and set_title tools.
 *
 * These don't require copilot sessions — they test tool infrastructure.
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

// ---------------------------------------------------------------------------
// list_agents
// ---------------------------------------------------------------------------

describe("list_agents", () => {
  it("returns built-in identifiers and supported backends", async (t) => {
    if (!capabilities.copilot) { t.skip("copilot not available"); return; }
    if (!capabilities.tmux) { t.skip("tmux not available"); return; }

    const driver = createBackendDriver("tmux");
    await driver.setup();
    t.after(() => driver.teardown());

    const workspacePath = await createE2EWorkspace(t);
    const { handlers } = await createE2EHandlers({
      backend: "tmux",
      driver,
      workspacePath,
    });

    const result = await handlers.copilot_subagent_list_agents({
      env: driver.env(),
    });

    assert.ok(Array.isArray(result.agentIdentifiers), "Should return agentIdentifiers array");
    assert.ok(
      Array.isArray(result.builtInIdentifiersAcceptedExplicitly),
      "Should return builtInIdentifiersAcceptedExplicitly",
    );
    assert.ok(
      result.builtInIdentifiersAcceptedExplicitly.includes("github-copilot"),
      "Should include github-copilot in builtInIdentifiersAcceptedExplicitly",
    );
    assert.ok(Array.isArray(result.supportedBackends), "Should return supportedBackends");
    assert.ok(result.supportedBackends.length > 0, "Should have at least one backend");
  });
});

// ---------------------------------------------------------------------------
// set_title (tmux only — zellij returns TITLE_UNSUPPORTED)
// ---------------------------------------------------------------------------

describe("set_title", () => {
  it("updates tmux pane title successfully", async (t) => {
    if (!capabilities.copilot) { t.skip("copilot not available"); return; }
    if (!capabilities.tmux) { t.skip("tmux not available"); return; }

    const driver = createBackendDriver("tmux");
    await driver.setup();
    t.after(() => driver.teardown());

    const workspacePath = await createE2EWorkspace(t);
    const { handlers } = await createE2EHandlers({
      backend: "tmux",
      driver,
      workspacePath,
    });

    // Launch a fire-and-forget agent to get a real paneId
    const launch = await handlers.copilot_subagent_launch({
      workspacePath,
      requestedIdentifier: "github-copilot",
      task: "Respond with: title-test-ok",
      awaitCompletion: false,
      env: driver.env(),
    });

    assert.equal(launch.ok, true, `Launch failed: ${JSON.stringify(launch)}`);

    // Set title on the live pane
    const result = await handlers.copilot_subagent_set_title({
      backend: "tmux",
      paneId: launch.paneId,
      title: "E2E Title Test",
      env: driver.env(),
    });

    assert.equal(result.ok, true, `set_title failed: ${JSON.stringify(result)}`);
    assert.equal(result.title, "E2E Title Test");
    assert.equal(result.applied, true);
    assert.equal(result.backend, "tmux");
  });

  it("returns TITLE_UNSUPPORTED for zellij backend", async (t) => {
    if (!capabilities.copilot) { t.skip("copilot not available"); return; }
    if (!capabilities.tmux) { t.skip("tmux not available"); return; }

    const driver = createBackendDriver("tmux");
    await driver.setup();
    t.after(() => driver.teardown());

    const workspacePath = await createE2EWorkspace(t);
    const { handlers } = await createE2EHandlers({
      backend: "tmux",
      driver,
      workspacePath,
    });

    // Call set_title with zellij backend (no runtime setPaneTitle override)
    const result = await handlers.copilot_subagent_set_title({
      backend: "zellij",
      paneId: "pane:1",
      title: "Should Fail",
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "TITLE_UNSUPPORTED");
  });

  it("rejects empty title", async (t) => {
    if (!capabilities.copilot) { t.skip("copilot not available"); return; }
    if (!capabilities.tmux) { t.skip("tmux not available"); return; }

    const driver = createBackendDriver("tmux");
    await driver.setup();
    t.after(() => driver.teardown());

    const workspacePath = await createE2EWorkspace(t);
    const { handlers } = await createE2EHandlers({
      backend: "tmux",
      driver,
      workspacePath,
    });

    const result = await handlers.copilot_subagent_set_title({
      backend: "tmux",
      paneId: "%1",
      title: "",
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "INVALID_ARGUMENT");
  });
});
