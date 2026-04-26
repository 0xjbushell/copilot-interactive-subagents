import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { importProjectModule } from "../helpers/red-harness.mjs";

const EXT_PATH = "packages/copilot-interactive-subagents/extension/extension.mjs";

describe("runner script signal handling (Bug A: orphan panes on signal exit)", () => {
  it("registers SIGTERM, SIGINT, and SIGHUP handlers so close-pane fires when copilot is killed externally", async () => {
    const { createDefaultAgentLaunchCommand } = await importProjectModule(EXT_PATH, ["createDefaultAgentLaunchCommand"]);
    const cmd = createDefaultAgentLaunchCommand(
      { launchId: "x" },
      {},
      { agentIdentifier: "github-copilot", task: "t", copilotSessionId: "s", interactive: false, backend: "zellij" },
    );
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
      assert.ok(cmd.includes(`"${sig}"`), `runner script should register a handler for ${sig}`);
    }
  });

  it("signal handler closes pane synchronously (spawnSync) so the close action survives node exit", async () => {
    const { createDefaultAgentLaunchCommand } = await importProjectModule(EXT_PATH, ["createDefaultAgentLaunchCommand"]);
    const cmd = createDefaultAgentLaunchCommand({}, {}, {
      agentIdentifier: "github-copilot", task: "t", copilotSessionId: null, interactive: false, backend: "zellij",
    });
    // Synchronous close avoids a race where detached spawn() is queued
    // but never started before process.exit().
    assert.match(cmd, /spawnSync\(\s*"zellij"[\s\S]*close-pane/);
    assert.match(cmd, /spawnSync\(\s*"tmux"[\s\S]*kill-pane/);
  });

  it("normal-exit path still closes pane (regression guard for v2.0.1 self-close)", async () => {
    const { createDefaultAgentLaunchCommand } = await importProjectModule(EXT_PATH, ["createDefaultAgentLaunchCommand"]);
    const cmd = createDefaultAgentLaunchCommand({}, {}, {
      agentIdentifier: "github-copilot", task: "t", copilotSessionId: null, interactive: false, backend: "zellij",
    });
    assert.ok(cmd.includes("__SUBAGENT_DONE_"), "sentinel still emitted");
    assert.ok(cmd.includes("ZELLIJ_PANE_ID"), "still reads ZELLIJ_PANE_ID for close target");
  });
});
