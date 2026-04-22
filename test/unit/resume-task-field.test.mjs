import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { importProjectModule } from "../helpers/red-harness.mjs";

const RESUME_MODULE = ".github/extensions/copilot-interactive-subagents/lib/resume.mjs";
const STATE_MODULE = ".github/extensions/copilot-interactive-subagents/lib/state.mjs";

async function loadResume() {
  const { resumeSubagent } = await importProjectModule(RESUME_MODULE, ["resumeSubagent"]);
  return resumeSubagent;
}

async function loadState() {
  const { createLaunchRecord, METADATA_VERSION } = await importProjectModule(STATE_MODULE, ["createLaunchRecord", "METADATA_VERSION"]);
  return { createLaunchRecord, METADATA_VERSION };
}

async function makeWorkspace(t) {
  const dir = await mkdtemp(join(tmpdir(), "d24-resume-"));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  return dir;
}

function makeStubs() {
  const sendCalls = [];
  const launchCalls = [];
  const services = {
    openPaneAndSendCommand: async (args) => { sendCalls.push(args); return { paneId: "pane:1", sessionId: "sess-1" }; },
    readPaneOutput: async () => ({ output: "__SUBAGENT_DONE_0__" }),
    readChildSessionState: async () => null,
    closePane: () => {},
    probeSessionLiveness: async () => true,
    acquireLock: () => ({ release: () => {} }),
  };
  return { sendCalls, launchCalls, services };
}

async function makeManifest({ workspacePath, t }) {
  const { createLaunchRecord } = await loadState();
  const { mkdir, writeFile } = await import("node:fs/promises");
  const manifestDir = join(workspacePath, ".copilot-interactive-subagents", "launches");
  await mkdir(manifestDir, { recursive: true });
  const record = createLaunchRecord({
    launchId: "launch-001",
    agentIdentifier: "reviewer",
    agentKind: "custom",
    backend: "tmux",
    paneId: "pane:1",
    sessionId: "sess-1",
    copilotSessionId: "csess-1",
    workspacePath,
    status: "success",
    closePaneOnCompletion: false,
  });
  await writeFile(join(manifestDir, "launch-001.json"), JSON.stringify(record));
  return record;
}

describe("D2.4: resume task field threading", () => {
  it("AC: empty-string task delivers NO extra prompt (openPaneAndSendCommand path)", async (t) => {
    const workspacePath = await makeWorkspace(t);
    await makeManifest({ workspacePath, t });
    const resumeSubagent = await loadResume();
    const { sendCalls, services } = makeStubs();
    await resumeSubagent({
      request: { workspacePath, launchId: "launch-001", task: "", awaitCompletion: false },
      services,
    });
    assert.equal(sendCalls.length, 1);
    assert.equal(sendCalls[0].task, null, "empty string must convert to null");
  });

  it("AC: omitted task delivers NO extra prompt (openPaneAndSendCommand path)", async (t) => {
    const workspacePath = await makeWorkspace(t);
    await makeManifest({ workspacePath, t });
    const resumeSubagent = await loadResume();
    const { sendCalls, services } = makeStubs();
    await resumeSubagent({
      request: { workspacePath, launchId: "launch-001", awaitCompletion: false },
      services,
    });
    assert.equal(sendCalls[0].task, null);
  });

  it("AC: non-empty task is delivered intact via openPaneAndSendCommand", async (t) => {
    const workspacePath = await makeWorkspace(t);
    await makeManifest({ workspacePath, t });
    const resumeSubagent = await loadResume();
    const { sendCalls, services } = makeStubs();
    await resumeSubagent({
      request: { workspacePath, launchId: "launch-001", task: "please continue", awaitCompletion: false },
      services,
    });
    assert.equal(sendCalls[0].task, "please continue");
  });

  it("AC: fallback path (openPane + launchAgentInPane) also threads task with empty===null parity", async (t) => {
    const workspacePath = await makeWorkspace(t);
    await makeManifest({ workspacePath, t });
    const resumeSubagent = await loadResume();
    const launchCalls = [];
    const services = {
      openPane: async () => ({ paneId: "pane:1" }),
      launchAgentInPane: async (args) => { launchCalls.push(args); return { sessionId: "sess-1" }; },
      readPaneOutput: async () => ({ output: "__SUBAGENT_DONE_0__" }),
      closePane: () => {},
      probeSessionLiveness: async () => true,
      acquireLock: () => ({ release: () => {} }),
    };
    await resumeSubagent({
      request: { workspacePath, launchId: "launch-001", task: "", awaitCompletion: false },
      services,
    });
    assert.equal(launchCalls.length, 1);
    assert.equal(launchCalls[0].task, null, "fallback path: empty string must converge to null too");
  });

  it("AC: fallback path delivers non-empty task intact", async (t) => {
    const workspacePath = await makeWorkspace(t);
    await makeManifest({ workspacePath, t });
    const resumeSubagent = await loadResume();
    const launchCalls = [];
    const services = {
      openPane: async () => ({ paneId: "pane:1" }),
      launchAgentInPane: async (args) => { launchCalls.push(args); return { sessionId: "sess-1" }; },
      readPaneOutput: async () => ({ output: "__SUBAGENT_DONE_0__" }),
      closePane: () => {},
      probeSessionLiveness: async () => true,
      acquireLock: () => ({ release: () => {} }),
    };
    const longTask = "x".repeat(10240);
    await resumeSubagent({
      request: { workspacePath, launchId: "launch-001", task: longTask, awaitCompletion: false },
      services,
    });
    assert.equal(launchCalls[0].task, longTask, "long task delivered without truncation");
  });

  it("AC: schema accepts task as optional string in private validation", async () => {
    const { PUBLIC_TOOL_PARAMETER_SCHEMAS } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/tool-schemas.mjs",
      ["PUBLIC_TOOL_PARAMETER_SCHEMAS"],
    );
    const resumeSchema = PUBLIC_TOOL_PARAMETER_SCHEMAS.copilot_subagent_resume;
    assert.equal(resumeSchema.properties.task.type, "string");
    assert.match(resumeSchema.properties.task.description, /follow-up/i);
  });
});
