import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { importProjectModule } from "../helpers/red-harness.mjs";

const EXT_PATH = "packages/copilot-interactive-subagents/extension/extension.mjs";

describe("tool timeout default (Bug B: 90s timeout breaks blocking launches)", () => {
  it("DEFAULT_TOOL_TIMEOUT_MS is at least 30 minutes by default", async () => {
    const { DEFAULT_TOOL_TIMEOUT_MS } = await importProjectModule(EXT_PATH, ["DEFAULT_TOOL_TIMEOUT_MS"]);
    assert.ok(
      DEFAULT_TOOL_TIMEOUT_MS >= 30 * 60_000,
      `DEFAULT_TOOL_TIMEOUT_MS should be >= 30 minutes for real subagent work, got ${DEFAULT_TOOL_TIMEOUT_MS}ms`,
    );
  });

  it("env var COPILOT_SUBAGENT_TOOL_TIMEOUT_MS overrides the default", async () => {
    const original = process.env.COPILOT_SUBAGENT_TOOL_TIMEOUT_MS;
    try {
      process.env.COPILOT_SUBAGENT_TOOL_TIMEOUT_MS = "12345";
      const { resolveToolTimeoutMs } = await importProjectModule(EXT_PATH, ["resolveToolTimeoutMs"]);
      assert.equal(resolveToolTimeoutMs(), 12345);
    } finally {
      if (original === undefined) delete process.env.COPILOT_SUBAGENT_TOOL_TIMEOUT_MS;
      else process.env.COPILOT_SUBAGENT_TOOL_TIMEOUT_MS = original;
    }
  });

  it("invalid env var falls back to default rather than crashing", async () => {
    const original = process.env.COPILOT_SUBAGENT_TOOL_TIMEOUT_MS;
    try {
      process.env.COPILOT_SUBAGENT_TOOL_TIMEOUT_MS = "not-a-number";
      const { resolveToolTimeoutMs, DEFAULT_TOOL_TIMEOUT_MS } = await importProjectModule(EXT_PATH, [
        "resolveToolTimeoutMs",
        "DEFAULT_TOOL_TIMEOUT_MS",
      ]);
      assert.equal(resolveToolTimeoutMs(), DEFAULT_TOOL_TIMEOUT_MS);
    } finally {
      if (original === undefined) delete process.env.COPILOT_SUBAGENT_TOOL_TIMEOUT_MS;
      else process.env.COPILOT_SUBAGENT_TOOL_TIMEOUT_MS = original;
    }
  });
});
