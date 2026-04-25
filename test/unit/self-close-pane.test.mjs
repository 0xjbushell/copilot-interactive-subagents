import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importProjectModule } from "../helpers/red-harness.mjs";

const EXT_PATH = "packages/copilot-interactive-subagents/extension/extension.mjs";

async function waitForFile(filePath, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !existsSync(filePath)) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("Self-close pane on child exit (TIX-000058)", () => {
  describe("runner script content", () => {
    it("GIVEN any launch WHEN command built THEN runner script reads ZELLIJ_PANE_ID and TMUX_PANE env vars", async () => {
      const { createDefaultAgentLaunchCommand } = await importProjectModule(EXT_PATH, ["createDefaultAgentLaunchCommand"]);
      const cmd = createDefaultAgentLaunchCommand(
        { launchId: "L1" },
        {},
        { agentIdentifier: "github-copilot", task: "t", copilotSessionId: null, interactive: false, backend: "zellij" },
      );
      assert.ok(cmd.includes("ZELLIJ_PANE_ID"), "runner should read ZELLIJ_PANE_ID");
      assert.ok(cmd.includes("TMUX_PANE"), "runner should read TMUX_PANE");
    });

    it("GIVEN runner script WHEN copilot exits THEN self-close runs BEFORE process.exit", async () => {
      const { createDefaultAgentLaunchCommand } = await importProjectModule(EXT_PATH, ["createDefaultAgentLaunchCommand"]);
      const cmd = createDefaultAgentLaunchCommand({}, {}, { agentIdentifier: "github-copilot", task: "t", copilotSessionId: null, interactive: false, backend: "tmux" });
      // Self-close logic must appear AFTER spawnSync result and BEFORE process.exit
      const spawnSyncIdx = cmd.indexOf("spawnSync");
      const closePaneIdx = cmd.indexOf("ZELLIJ_PANE_ID");
      const exitIdx = cmd.indexOf("process.exit(code)");
      assert.ok(spawnSyncIdx > 0 && closePaneIdx > spawnSyncIdx && exitIdx > closePaneIdx,
        `expected order: spawnSync(${spawnSyncIdx}) < self-close(${closePaneIdx}) < process.exit(${exitIdx})`);
    });

    it("GIVEN runner script WHEN self-close fails THEN process.exit still runs (try/catch)", async () => {
      const { createDefaultAgentLaunchCommand } = await importProjectModule(EXT_PATH, ["createDefaultAgentLaunchCommand"]);
      const cmd = createDefaultAgentLaunchCommand({}, {}, { agentIdentifier: "github-copilot", task: "t", copilotSessionId: null, interactive: true, backend: "zellij" });
      assert.ok(/try\s*\{[^}]*ZELLIJ_PANE_ID[\s\S]*?\}\s*catch/.test(cmd),
        "self-close must be wrapped in try/catch");
    });
  });

  describe("end-to-end behavior with stubbed backend binaries", () => {
    function setupStubBackend(backend) {
      const tmpDir = mkdtempSync(join(tmpdir(), "self-close-stub-"));
      const binDir = join(tmpDir, "bin");
      mkdirSync(binDir);
      const recordPath = join(tmpDir, "calls.log");

      // Stub `copilot` — exit immediately with code 0
      writeFileSync(join(binDir, "copilot"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(binDir, "copilot"), 0o755);

      // Stub the close-pane binary
      const stubScript = `#!/bin/sh\necho "$0 $@" >> ${JSON.stringify(recordPath)}\nexit 0\n`;
      writeFileSync(join(binDir, backend), stubScript);
      chmodSync(join(binDir, backend), 0o755);

      return { tmpDir, binDir, recordPath };
    }

    it("GIVEN $ZELLIJ_PANE_ID set WHEN copilot exits THEN zellij action close-pane is invoked", async () => {
      const { createDefaultAgentLaunchCommand } = await importProjectModule(EXT_PATH, ["createDefaultAgentLaunchCommand"]);
      const { binDir, recordPath } = setupStubBackend("zellij");

      const cmd = createDefaultAgentLaunchCommand(
        {},
        {},
        { agentIdentifier: "github-copilot", task: "noop", copilotSessionId: null, interactive: false, backend: "zellij" },
      );

      const result = spawnSync("/bin/sh", ["-c", cmd], {
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, ZELLIJ_PANE_ID: "42", TMUX_PANE: "" },
        timeout: 5000,
      });

      assert.equal(result.status, 0, `runner failed: ${result.stderr?.toString()}`);
      await waitForFile(recordPath);
      assert.ok(existsSync(recordPath), "zellij stub was not invoked");
      const log = readFileSync(recordPath, "utf8");
      assert.ok(log.includes("close-pane"), `log missing close-pane: ${log}`);
      assert.ok(log.includes("42"), `log missing pane id 42: ${log}`);
    });

    it("GIVEN $TMUX_PANE set WHEN copilot exits THEN tmux kill-pane is invoked", async () => {
      const { createDefaultAgentLaunchCommand } = await importProjectModule(EXT_PATH, ["createDefaultAgentLaunchCommand"]);
      const { binDir, recordPath } = setupStubBackend("tmux");

      const cmd = createDefaultAgentLaunchCommand(
        {},
        {},
        { agentIdentifier: "github-copilot", task: "noop", copilotSessionId: null, interactive: false, backend: "tmux" },
      );

      const result = spawnSync("/bin/sh", ["-c", cmd], {
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, TMUX_PANE: "%9", ZELLIJ_PANE_ID: "" },
        timeout: 5000,
      });

      assert.equal(result.status, 0, `runner failed: ${result.stderr?.toString()}`);
      await waitForFile(recordPath);
      assert.ok(existsSync(recordPath), "tmux stub was not invoked");
      const log = readFileSync(recordPath, "utf8");
      assert.ok(log.includes("kill-pane"), `log missing kill-pane: ${log}`);
      assert.ok(log.includes("%9"), `log missing pane id %9: ${log}`);
    });

    it("GIVEN no pane env vars set WHEN copilot exits THEN runner exits cleanly (no error)", async () => {
      const { createDefaultAgentLaunchCommand } = await importProjectModule(EXT_PATH, ["createDefaultAgentLaunchCommand"]);
      const tmpDir = mkdtempSync(join(tmpdir(), "self-close-noenv-"));
      const binDir = join(tmpDir, "bin");
      mkdirSync(binDir);
      writeFileSync(join(binDir, "copilot"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(binDir, "copilot"), 0o755);

      const cmd = createDefaultAgentLaunchCommand({}, {}, { agentIdentifier: "github-copilot", task: "t", copilotSessionId: null, interactive: false, backend: "tmux" });

      const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };
      delete env.ZELLIJ_PANE_ID;
      delete env.TMUX_PANE;

      const result = spawnSync("/bin/sh", ["-c", cmd], { env, timeout: 5000 });
      assert.equal(result.status, 0, `runner failed without pane env: ${result.stderr?.toString()}`);
    });
  });
});
