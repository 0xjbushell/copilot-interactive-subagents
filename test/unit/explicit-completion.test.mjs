import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { importProjectModule } from "../helpers/red-harness.mjs";

const EXT_PATH = ".github/extensions/copilot-interactive-subagents/extension.mjs";

describe("Explicit completion (subagent_done)", () => {
  describe("subagent_done tool registration", () => {
    it("GIVEN COPILOT_SUBAGENT_LAUNCH_ID set WHEN session registers THEN subagent_done tool is included with optional summary parameter", async () => {
      const { registerExtensionSession } = await importProjectModule(EXT_PATH, ["registerExtensionSession"]);
      const originalLaunchEnv = process.env.COPILOT_SUBAGENT_LAUNCH_ID;
      const originalSessionEnv = process.env.COPILOT_SUBAGENT_SESSION_ID;
      try {
        process.env.COPILOT_SUBAGENT_LAUNCH_ID = "test-launch-id";
        delete process.env.COPILOT_SUBAGENT_SESSION_ID;

        let registeredTools;
        const mockJoinSession = async ({ tools }) => {
          registeredTools = tools;
          return { workspacePath: "/tmp" };
        };

        await registerExtensionSession({ joinSession: mockJoinSession });

        const doneTool = registeredTools.find((t) => t.name === "subagent_done");
        assert.ok(doneTool, "subagent_done tool should be registered");
        assert.equal(doneTool.parameters.type, "object");
        assert.ok(doneTool.parameters.properties.summary, "summary param should be defined");
        assert.equal(doneTool.parameters.properties.summary.type, "string");
        assert.ok(!Array.isArray(doneTool.parameters.required) || doneTool.parameters.required.length === 0, "summary must NOT be required");
      } finally {
        if (originalLaunchEnv === undefined) delete process.env.COPILOT_SUBAGENT_LAUNCH_ID;
        else process.env.COPILOT_SUBAGENT_LAUNCH_ID = originalLaunchEnv;
        if (originalSessionEnv === undefined) delete process.env.COPILOT_SUBAGENT_SESSION_ID;
        else process.env.COPILOT_SUBAGENT_SESSION_ID = originalSessionEnv;
      }
    });

    it("GIVEN COPILOT_SUBAGENT_LAUNCH_ID not set WHEN session registers THEN subagent_done not included", async () => {
      const { registerExtensionSession } = await importProjectModule(EXT_PATH, ["registerExtensionSession"]);
      const originalLaunchEnv = process.env.COPILOT_SUBAGENT_LAUNCH_ID;
      try {
        delete process.env.COPILOT_SUBAGENT_LAUNCH_ID;

        let registeredTools;
        const mockJoinSession = async ({ tools }) => {
          registeredTools = tools;
          return { workspacePath: "/tmp" };
        };

        await registerExtensionSession({ joinSession: mockJoinSession });

        const doneTool = registeredTools.find((t) => t.name === "subagent_done");
        assert.equal(doneTool, undefined, "subagent_done should NOT be registered without env var");
      } finally {
        if (originalLaunchEnv === undefined) delete process.env.COPILOT_SUBAGENT_LAUNCH_ID;
        else process.env.COPILOT_SUBAGENT_LAUNCH_ID = originalLaunchEnv;
      }
    });
  });

  describe("command builder env vars", () => {
    it("GIVEN copilotSessionId and launchId WHEN command built THEN includes COPILOT_SUBAGENT_SESSION_ID and LAUNCH_ID", async () => {
      const { createDefaultAgentLaunchCommand } = await importProjectModule(EXT_PATH, ["createDefaultAgentLaunchCommand"]);
      const cmd = createDefaultAgentLaunchCommand(
        { launchId: "my-launch" },
        {},
        { agentIdentifier: "github-copilot", task: "do stuff", copilotSessionId: "my-session", interactive: false, backend: "tmux" },
      );
      assert.ok(cmd.includes("COPILOT_SUBAGENT_SESSION_ID="), "should include session ID env var");
      assert.ok(cmd.includes("my-session"), "should include actual session ID");
      assert.ok(cmd.includes("COPILOT_SUBAGENT_LAUNCH_ID="), "should include launch ID env var");
      assert.ok(cmd.includes("my-launch"), "should include actual launch ID");
    });

    it("GIVEN no copilotSessionId WHEN command built THEN omits COPILOT_SUBAGENT_SESSION_ID", async () => {
      const { createDefaultAgentLaunchCommand } = await importProjectModule(EXT_PATH, ["createDefaultAgentLaunchCommand"]);
      const cmd = createDefaultAgentLaunchCommand(
        {},
        {},
        { agentIdentifier: "github-copilot", task: "do stuff", copilotSessionId: null, interactive: false, backend: "tmux" },
      );
      assert.ok(!cmd.includes("COPILOT_SUBAGENT_SESSION_ID="), "should not include session ID env var");
    });
  });
});
