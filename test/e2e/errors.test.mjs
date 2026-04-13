/**
 * E2E tests for error handling — invalid inputs, missing args, bad identifiers.
 *
 * These verify the extension returns structured errors rather than crashing.
 * Most don't need copilot sessions — they test validation gates.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import {
  preflight,
  createBackendDriver,
  createE2EHandlers,
  createE2EWorkspace,
} from "./e2e-helpers.mjs";

let capabilities;

before(async () => {
  capabilities = await preflight();
});

describe("error handling", () => {
  let driver;
  let handlers;

  before(async () => {
    if (!capabilities.copilot || !capabilities.tmux) return;
    driver = createBackendDriver("tmux");
    await driver.setup();
    const { mkdtemp } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const workspacePath = await mkdtemp(join(tmpdir(), "e2e-errors-"));
    const result = await createE2EHandlers({
      backend: "tmux",
      driver,
      workspacePath,
    });
    handlers = result.handlers;
  });

  after(async () => {
    if (driver) await driver.teardown();
  });

  function skipIfNeeded(t) {
    if (!capabilities.copilot) { t.skip("copilot not available"); return true; }
    if (!capabilities.tmux) { t.skip("tmux not available"); return true; }
    return false;
  }

  // ----- Invalid agent identifier ----------------------------------

  it("launch with unknown agent returns AGENT_NOT_FOUND", async (t) => {
    if (skipIfNeeded(t)) return;

    const result = await handlers.copilot_subagent_launch({
      requestedIdentifier: "nonexistent-agent-xyz-12345",
      task: "This should fail",
      awaitCompletion: false,
      env: driver.env(),
    });

    assert.equal(result.ok, false, `Expected failure, got: ${JSON.stringify(result).slice(0, 300)}`);
    assert.equal(result.code, "AGENT_NOT_FOUND");
  });

  // ----- Missing required fields -----------------------------------

  it("launch without task returns validation error", async (t) => {
    if (skipIfNeeded(t)) return;

    const result = await handlers.copilot_subagent_launch({
      requestedIdentifier: "github-copilot",
      env: driver.env(),
    });

    assert.equal(result.ok, false, `Expected failure, got: ${JSON.stringify(result).slice(0, 300)}`);
  });

  // ----- Resume with nonexistent launchId --------------------------

  it("resume with nonexistent launchId returns error", async (t) => {
    if (skipIfNeeded(t)) return;

    // Use a fresh isolated workspace to avoid corrupted index files
    const { mkdtemp } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const freshWorkspace = await mkdtemp(join(tmpdir(), "e2e-resume-err-"));
    t.after(async () => {
      const { rm } = await import("node:fs/promises");
      await rm(freshWorkspace, { recursive: true, force: true });
    });

    const { handlers: freshHandlers } = await createE2EHandlers({
      backend: "tmux",
      driver,
      workspacePath: freshWorkspace,
    });

    const result = await freshHandlers.copilot_subagent_resume({
      workspacePath: freshWorkspace,
      projectRoot: freshWorkspace,
      launchId: "00000000-0000-0000-0000-000000000000",
      task: "This should fail",
      awaitCompletion: false,
      env: driver.env(),
    });

    assert.equal(result.ok, false, `Expected failure, got: ${JSON.stringify(result).slice(0, 300)}`);
  });

  // ----- set_title missing arguments -------------------------------

  it("set_title without backend returns INVALID_ARGUMENT", async (t) => {
    if (skipIfNeeded(t)) return;

    const result = await handlers.copilot_subagent_set_title({
      title: "Valid Title But No Target",
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "INVALID_ARGUMENT");
    assert.equal(result.field, "backend");
  });

  // ----- Parallel with empty launches array -----------------------

  it("parallel with empty launches array returns appropriate error", async (t) => {
    if (skipIfNeeded(t)) return;

    const result = await handlers.copilot_subagent_parallel({
      launches: [],
      awaitCompletion: false,
      env: driver.env(),
    });

    // Should either fail or return empty results
    if (result.ok === false) {
      assert.ok(result.code || result.message, "Should have error info");
    } else {
      assert.equal(result.totalCount, 0);
    }
  });
});
