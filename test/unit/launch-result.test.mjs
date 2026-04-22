import { test } from "node:test";
import assert from "node:assert/strict";
import { importProjectModule } from "../helpers/red-harness.mjs";

const launchModule = await importProjectModule(
  ".github/extensions/copilot-interactive-subagents/lib/launch.mjs",
  ["enrichCompletionSummary", "buildManifestUpdates", "shapePingResult"],
);
const utilsModule = await importProjectModule(
  ".github/extensions/copilot-interactive-subagents/lib/utils.mjs",
  ["isActiveOrSuccessful"],
);

const { enrichCompletionSummary, buildManifestUpdates, shapePingResult } = launchModule;
const { isActiveOrSuccessful } = utilsModule;

test("isActiveOrSuccessful returns true for ping (D2.3 status taxonomy)", () => {
  assert.equal(isActiveOrSuccessful("ping"), true);
  assert.equal(isActiveOrSuccessful("success"), true);
  assert.equal(isActiveOrSuccessful("failure"), false);
});

test("enrichCompletionSummary: sidecar summary wins over session events", () => {
  // summarySource omitted to detect precedence: sidecar branch returns "sidecar" explicitly,
  // fallback branch would return "fallback".
  const completion = { source: "sidecar", summary: "from-sidecar" };
  const plan = { copilotSessionId: null };
  const result = enrichCompletionSummary(completion, plan);
  assert.equal(result.summary, "from-sidecar");
  assert.equal(result.source, "sidecar");
});

test("enrichCompletionSummary: sentinel summary wins when no sidecar", () => {
  const completion = { source: "sentinel", summary: "pane-text", summarySource: "pane" };
  const result = enrichCompletionSummary(completion, { copilotSessionId: null });
  assert.equal(result.summary, "pane-text");
  assert.equal(result.source, "pane");
});

test("enrichCompletionSummary: falls through when no sidecar/sentinel summary and no session id", () => {
  const completion = { source: "timeout", summary: null, summarySource: null, exitCode: null };
  const result = enrichCompletionSummary(completion, { copilotSessionId: null });
  assert.equal(result.summary, null);
  assert.equal(result.source, "fallback");
});

test("buildManifestUpdates: sidecar+done sets lastExitType=done and sidecarPath", () => {
  const completion = {
    source: "sidecar", sidecarType: "done", status: "success",
    exitCode: 0, sidecarPath: "/x/sidecar.json",
  };
  const updates = buildManifestUpdates({
    completion,
    completionSummary: { summary: "ok", source: "sidecar" },
    activeManifest: { pingHistory: [] },
    now: () => "2025-01-01T00:00:00.000Z",
  });
  assert.equal(updates.lastExitType, "done");
  assert.equal(updates.sidecarPath, "/x/sidecar.json");
  assert.equal(updates.pingHistory, undefined);
});

test("buildManifestUpdates: sidecar+ping appends to pingHistory and sets lastExitType=ping", () => {
  const completion = {
    source: "sidecar", sidecarType: "ping", status: "ping",
    exitCode: 0, sidecarPath: "/x/p.json", message: "need input",
  };
  const updates = buildManifestUpdates({
    completion,
    completionSummary: { summary: null, source: "sidecar" },
    activeManifest: { pingHistory: [{ message: "earlier", sentAt: "2024-12-31T00:00:00.000Z" }] },
    now: () => "2025-01-01T00:00:00.000Z",
  });
  assert.equal(updates.lastExitType, "ping");
  assert.equal(updates.sidecarPath, "/x/p.json");
  assert.deepEqual(updates.pingHistory, [
    { message: "earlier", sentAt: "2024-12-31T00:00:00.000Z" },
    { message: "need input", sentAt: "2025-01-01T00:00:00.000Z" },
  ]);
});

test("buildManifestUpdates: sentinel sets lastExitType=done but NOT sidecarPath", () => {
  const completion = { source: "sentinel", status: "success", exitCode: 0 };
  const updates = buildManifestUpdates({
    completion,
    completionSummary: { summary: "x", source: "pane" },
    activeManifest: {},
    now: () => "t",
  });
  assert.equal(updates.lastExitType, "done");
  assert.equal(updates.sidecarPath, undefined);
});

test("buildManifestUpdates: timeout does not touch lastExitType or sidecarPath", () => {
  const completion = { source: "timeout", status: "timeout", exitCode: null };
  const updates = buildManifestUpdates({
    completion,
    completionSummary: { summary: null, source: "fallback" },
    activeManifest: {},
    now: () => "t",
  });
  assert.equal(updates.lastExitType, undefined);
  assert.equal(updates.sidecarPath, undefined);
  assert.equal(updates.status, "timeout");
});

test("shapePingResult: produces strict ping result shape", () => {
  const baseResult = {
    ok: true, launchId: "L", status: "success", summary: "stale",
    exitCode: 99, paneId: "%1", sessionId: "S",
  };
  const completion = { message: "What about Y?" };
  const result = shapePingResult({ baseResult, completion });
  assert.equal(result.status, "ping");
  assert.equal(result.summary, null);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.ping, { message: "What about Y?" });
  // Other base fields preserved
  assert.equal(result.launchId, "L");
  assert.equal(result.paneId, "%1");
});
