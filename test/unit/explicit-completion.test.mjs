import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { importProjectModule } from "../helpers/red-harness.mjs";

const EXT_PATH = ".github/extensions/copilot-interactive-subagents/extension.mjs";

describe("Explicit completion (subagent_done)", () => {
  describe("writeSignalFile", () => {
    it("GIVEN copilotSessionId and launchId WHEN called THEN writes signal file with timestamp|launchId", async () => {
      const { writeSignalFile } = await importProjectModule(EXT_PATH, ["writeSignalFile"]);
      const written = {};
      const services = {
        mkdirSync: (dir, opts) => { written.dir = dir; written.opts = opts; },
        writeFileSync: (filePath, content) => { written.path = filePath; written.content = content; },
        now: () => 1700000000000,
      };
      writeSignalFile({
        copilotSessionId: "session-abc",
        launchId: "launch-xyz",
        stateDir: "/tmp/test-state",
        services,
      });
      assert.ok(written.dir.includes("done"));
      assert.ok(written.opts.recursive);
      assert.ok(written.path.endsWith("session-abc"));
      assert.equal(written.content, "1700000000000|launch-xyz");
    });

    it("GIVEN no launchId WHEN called THEN uses 'unknown' in content", async () => {
      const { writeSignalFile } = await importProjectModule(EXT_PATH, ["writeSignalFile"]);
      let content;
      const services = {
        mkdirSync: () => {},
        writeFileSync: (_, c) => { content = c; },
        now: () => 42,
      };
      writeSignalFile({ copilotSessionId: "s1", services });
      assert.equal(content, "42|unknown");
    });

    it("GIVEN default stateDir WHEN called THEN uses .copilot-interactive-subagents", async () => {
      const { writeSignalFile } = await importProjectModule(EXT_PATH, ["writeSignalFile"]);
      let dir;
      const services = {
        mkdirSync: (d) => { dir = d; },
        writeFileSync: () => {},
        now: () => 0,
      };
      writeSignalFile({ copilotSessionId: "s1", services });
      assert.ok(dir.includes(".copilot-interactive-subagents"));
      assert.ok(dir.includes("done"));
    });
  });

  describe("subagent_done tool registration", () => {
    it("GIVEN COPILOT_SUBAGENT_SESSION_ID set WHEN session registers THEN subagent_done tool is included", async () => {
      const { registerExtensionSession } = await importProjectModule(EXT_PATH, ["registerExtensionSession"]);
      const originalEnv = process.env.COPILOT_SUBAGENT_SESSION_ID;
      const originalLaunchEnv = process.env.COPILOT_SUBAGENT_LAUNCH_ID;
      try {
        process.env.COPILOT_SUBAGENT_SESSION_ID = "test-session-id";
        process.env.COPILOT_SUBAGENT_LAUNCH_ID = "test-launch-id";

        let registeredTools;
        const mockJoinSession = async ({ tools }) => {
          registeredTools = tools;
          return { workspacePath: "/tmp" };
        };

        await registerExtensionSession({ joinSession: mockJoinSession });

        const doneTool = registeredTools.find((t) => t.name === "subagent_done");
        assert.ok(doneTool, "subagent_done tool should be registered");
        assert.deepEqual(doneTool.parameters, {});
        assert.ok(doneTool.description.includes("completed your task"));
      } finally {
        if (originalEnv === undefined) delete process.env.COPILOT_SUBAGENT_SESSION_ID;
        else process.env.COPILOT_SUBAGENT_SESSION_ID = originalEnv;
        if (originalLaunchEnv === undefined) delete process.env.COPILOT_SUBAGENT_LAUNCH_ID;
        else process.env.COPILOT_SUBAGENT_LAUNCH_ID = originalLaunchEnv;
      }
    });

    it("GIVEN COPILOT_SUBAGENT_SESSION_ID not set WHEN session registers THEN subagent_done not included", async () => {
      const { registerExtensionSession } = await importProjectModule(EXT_PATH, ["registerExtensionSession"]);
      const originalEnv = process.env.COPILOT_SUBAGENT_SESSION_ID;
      try {
        delete process.env.COPILOT_SUBAGENT_SESSION_ID;

        let registeredTools;
        const mockJoinSession = async ({ tools }) => {
          registeredTools = tools;
          return { workspacePath: "/tmp" };
        };

        await registerExtensionSession({ joinSession: mockJoinSession });

        const doneTool = registeredTools.find((t) => t.name === "subagent_done");
        assert.equal(doneTool, undefined, "subagent_done should NOT be registered without env var");
      } finally {
        if (originalEnv === undefined) delete process.env.COPILOT_SUBAGENT_SESSION_ID;
        else process.env.COPILOT_SUBAGENT_SESSION_ID = originalEnv;
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
