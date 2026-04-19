import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { importProjectModule } from "./helpers/red-harness.mjs";

async function createWorkspace(t) {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), "copilot-interactive-subagents-"));
  t.after(async () => {
    await rm(workspacePath, { recursive: true, force: true });
  });

  return workspacePath;
}

function createLaunch({
  workspacePath,
  requestedIdentifier,
  task,
  awaitCompletion = true,
  maxMonitorAttempts,
}) {
  return {
    request: {
      workspacePath,
      requestedIdentifier,
      task,
      awaitCompletion,
      sidecarGraceMs: 0,
      ...(maxMonitorAttempts ? { maxMonitorAttempts } : {}),
    },
    agentValidation: {
      identifier: requestedIdentifier,
      agentKind: "custom",
    },
  };
}

function createDeferred() {
  let resolve;
  const promise = new Promise((value) => {
    resolve = value;
  });

  return { promise, resolve };
}

async function waitFor(assertion, { attempts = 100 } = {}) {
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return assertion();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  throw lastError;
}

function createIdFactory(prefix) {
  let index = 0;
  return () => `${prefix}-${String(++index).padStart(3, "0")}`;
}

describe("parallel pane-backed launch orchestration", () => {
  it("plans parallel launches in request order with deterministic pane layout metadata", async () => {
    const { planParallelLaunches } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/parallel.mjs",
      ["planParallelLaunches"],
    );

    const launches = [
      createLaunch({
        workspacePath: "/tmp/workspace",
        requestedIdentifier: "reviewer-a",
        task: "Inspect alpha",
      }),
      createLaunch({
        workspacePath: "/tmp/workspace",
        requestedIdentifier: "reviewer-b",
        task: "Inspect beta",
      }),
      createLaunch({
        workspacePath: "/tmp/workspace",
        requestedIdentifier: "reviewer-c",
        task: "Inspect gamma",
      }),
    ];

    const plans = planParallelLaunches({
      launches,
      backendResolution: {
        selectedBackend: "tmux",
        action: "attach",
      },
      createLaunchId: createIdFactory("launch"),
      now: () => "2026-03-19T00:00:00.000Z",
    });

    assert.deepEqual(
      plans.map((entry) => ({
        launchId: entry.plan.launchId,
        agentIdentifier: entry.plan.agentIdentifier,
        slot: entry.layout.slot,
        title: entry.layout.title,
        strategy: entry.layout.strategy,
      })),
      [
        {
          launchId: "launch-001",
          agentIdentifier: "reviewer-a",
          slot: 0,
          title: "1/3 reviewer-a",
          strategy: "tiled",
        },
        {
          launchId: "launch-002",
          agentIdentifier: "reviewer-b",
          slot: 1,
          title: "2/3 reviewer-b",
          strategy: "tiled",
        },
        {
          launchId: "launch-003",
          agentIdentifier: "reviewer-c",
          slot: 2,
          title: "3/3 reviewer-c",
          strategy: "tiled",
        },
      ],
    );
  });

  it("tracks progress by launchId and preserves request order even when similarly worded summaries finish out of order", async () => {
    const { createParallelProgressTracker } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/progress.mjs",
      ["createParallelProgressTracker"],
    );

    const tracker = createParallelProgressTracker({
      launches: [
        {
          launchId: "launch-001",
          agentIdentifier: "reviewer-a",
          agentKind: "custom",
          backend: "tmux",
          requestIndex: 0,
          requestedAt: "2026-03-19T00:00:00.000Z",
        },
        {
          launchId: "launch-002",
          agentIdentifier: "reviewer-b",
          agentKind: "custom",
          backend: "tmux",
          requestIndex: 1,
          requestedAt: "2026-03-19T00:00:01.000Z",
        },
      ],
    });

    tracker.markRunning({
      launchId: "launch-001",
      paneId: "%1",
      sessionId: "session-a",
    });
    tracker.markRunning({
      launchId: "launch-002",
      paneId: "%2",
      sessionId: "session-b",
    });
    tracker.recordResult({
      launchId: "launch-002",
      status: "success",
      summary: "Reviewed failing tests and drafted a fix for beta",
      exitCode: 0,
      paneId: "%2",
      sessionId: "session-b",
    });
    tracker.recordResult({
      launchId: "launch-001",
      status: "failure",
      summary: "Reviewed failing tests and drafted a fix for alpha",
      exitCode: 12,
      paneId: "%1",
      sessionId: "session-a",
    });

    const snapshot = tracker.snapshot();

    assert.equal(snapshot.aggregateStatus, "partial-success");
    assert.deepEqual(snapshot.results.map((result) => result.launchId), [
      "launch-001",
      "launch-002",
    ]);
    assert.deepEqual(snapshot.results.map((result) => result.summary), [
      "Reviewed failing tests and drafted a fix for alpha",
      "Reviewed failing tests and drafted a fix for beta",
    ]);
    assert.equal(snapshot.progressByLaunchId["launch-001"].status, "failure");
    assert.equal(snapshot.progressByLaunchId["launch-002"].status, "success");
    assert.equal(snapshot.progressByLaunchId["launch-001"].exitCode, 12);
    assert.equal(snapshot.progressByLaunchId["launch-002"].exitCode, 0);
  });

  it("GIVEN three launches, one exits immediately, and two continue WHEN progress is requested during execution THEN each agent remains attributable and visible in request order", async (t) => {
    const workspacePath = await createWorkspace(t);
    const { createParallelLaunchController } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/parallel.mjs",
      ["createParallelLaunchController"],
    );

    const delayedSecond = createDeferred();
    const delayedThird = createDeferred();
    const openPaneCalls = [];

    const controller = createParallelLaunchController({
      launches: [
        createLaunch({
          workspacePath,
          requestedIdentifier: "reviewer-a",
          task: "Audit alpha",
        }),
        createLaunch({
          workspacePath,
          requestedIdentifier: "reviewer-b",
          task: "Audit beta",
        }),
        createLaunch({
          workspacePath,
          requestedIdentifier: "reviewer-c",
          task: "Audit gamma",
        }),
      ],
      backendResolution: {
        selectedBackend: "tmux",
        action: "attach",
      },
      createLaunchId: createIdFactory("launch"),
      now: () => "2026-03-19T00:00:00.000Z",
      services: {
        openPane: async ({ layout }) => {
          openPaneCalls.push(layout);
          return {
            paneId: `%${layout.slot + 1}`,
            visible: true,
          };
        },
        launchAgentInPane: async ({ paneId }) => ({
          sessionId: `session-${paneId.slice(1)}`,
        }),
        readPaneOutput: async ({ paneId }) => {
          switch (paneId) {
            case "%1":
              return {
                output: "assistant: Reviewed alpha immediately\n__SUBAGENT_DONE_0__",
              };
            case "%2":
              return delayedSecond.promise;
            case "%3":
              return delayedThird.promise;
            default:
              assert.fail(`unexpected pane ${paneId}`);
          }
        },
      },
    });

    const inFlight = await waitFor(() => {
      const snapshot = controller.getProgress();
      assert.equal(snapshot.aggregateStatus, "running");
      assert.deepEqual(snapshot.results.map((result) => result.status), [
        "success",
        "running",
        "running",
      ]);
      return snapshot;
    });

    assert.deepEqual(inFlight.results.map((result) => result.paneId), ["%1", "%2", "%3"]);
    assert.equal(inFlight.progressByLaunchId[inFlight.results[1].launchId].sessionId, "session-2");
    assert.equal(inFlight.progressByLaunchId[inFlight.results[2].launchId].sessionId, "session-3");
    assert.deepEqual(openPaneCalls.map((layout) => layout.strategy), ["tiled", "tiled", "tiled"]);

    delayedThird.resolve({
      output: "assistant: Reviewed gamma after alpha\n__SUBAGENT_DONE_0__",
    });
    delayedSecond.resolve({
      output: "assistant: Reviewed beta after gamma\n__SUBAGENT_DONE_0__",
    });

    const finalResult = await controller.completionPromise;

    assert.equal(finalResult.aggregateStatus, "success");
    assert.deepEqual(finalResult.results.map((result) => result.launchId), [
      "launch-001",
      "launch-002",
      "launch-003",
    ]);
    assert.deepEqual(finalResult.results.map((result) => result.summary), [
      "Reviewed alpha immediately",
      "Reviewed beta after gamma",
      "Reviewed gamma after alpha",
    ]);
  });

  it("GIVEN pane creation fails for one child while siblings succeed WHEN the run completes THEN aggregate reporting returns partial success with per-agent exit state intact", async (t) => {
    const workspacePath = await createWorkspace(t);
    const { launchParallelSubagents } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/parallel.mjs",
      ["launchParallelSubagents"],
    );

    let paneSequence = 0;
    const result = await launchParallelSubagents({
      launches: [
        createLaunch({
          workspacePath,
          requestedIdentifier: "reviewer-a",
          task: "Summarize alpha",
        }),
        createLaunch({
          workspacePath,
          requestedIdentifier: "reviewer-b",
          task: "Summarize beta",
        }),
        createLaunch({
          workspacePath,
          requestedIdentifier: "reviewer-c",
          task: "Summarize gamma",
        }),
      ],
      backendResolution: {
        selectedBackend: "tmux",
        action: "start",
      },
      createLaunchId: createIdFactory("launch"),
      now: () => "2026-03-19T00:00:00.000Z",
      services: {
        openPane: async ({ layout }) => {
          paneSequence += 1;
          if (layout.slot === 1) {
            const error = new Error("pane split failed");
            error.exitCode = 71;
            throw error;
          }

          return {
            paneId: `%${paneSequence}`,
            visible: true,
          };
        },
        launchAgentInPane: async ({ paneId }) => ({
          sessionId: `session-${paneId.slice(1)}`,
        }),
        readPaneOutput: async ({ paneId }) => {
          if (paneId === "%1") {
            return {
              output: "assistant: Summary ready for alpha\n__SUBAGENT_DONE_0__",
            };
          }

          return {
            output: "assistant: Summary ready for gamma\n__SUBAGENT_DONE_0__",
          };
        },
      },
    });

    assert.equal(result.aggregateStatus, "partial-success");
    assert.deepEqual(result.results.map((entry) => entry.status), [
      "success",
      "failure",
      "success",
    ]);
    assert.deepEqual(result.results.map((entry) => entry.exitCode), [0, 71, 0]);
    assert.equal(result.results[1].paneId, null);
    assert.match(result.results[1].summary, /reviewer-b/i);
    assert.match(result.results[1].summary, /unassigned/i);
    assert.equal(result.results[0].summary, "Summary ready for alpha");
    assert.equal(result.results[2].summary, "Summary ready for gamma");
  });

  it("GIVEN one child times out while a sibling succeeds WHEN completion is awaited THEN timeout reporting does not block sibling results forever", async (t) => {
    const workspacePath = await createWorkspace(t);
    const { launchParallelSubagents } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/parallel.mjs",
      ["launchParallelSubagents"],
    );

    const result = await launchParallelSubagents({
      launches: [
        createLaunch({
          workspacePath,
          requestedIdentifier: "reviewer-a",
          task: "Inspect alpha",
        }),
        createLaunch({
          workspacePath,
          requestedIdentifier: "reviewer-b",
          task: "Inspect beta",
          maxMonitorAttempts: 2,
        }),
      ],
      backendResolution: {
        selectedBackend: "tmux",
        action: "attach",
      },
      createLaunchId: createIdFactory("launch"),
      now: () => "2026-03-19T00:00:00.000Z",
      services: {
        openPane: async ({ layout }) => ({
          paneId: `%${layout.slot + 1}`,
          visible: true,
        }),
        launchAgentInPane: async ({ paneId }) => ({
          sessionId: `session-${paneId.slice(1)}`,
        }),
        readPaneOutput: async ({ paneId }) => {
          if (paneId === "%1") {
            return {
              output: "assistant: Reviewed failing tests for alpha\n__SUBAGENT_DONE_0__",
            };
          }

          return {
            output: "assistant: Reviewed failing tests for beta but still thinking",
          };
        },
      },
    });

    assert.equal(result.aggregateStatus, "partial-success");
    assert.deepEqual(result.results.map((entry) => entry.status), ["success", "timeout"]);
    assert.equal(result.results[0].summary, "Reviewed failing tests for alpha");
    assert.equal(result.results[1].summary, "Reviewed failing tests for beta but still thinking");
    assert.deepEqual(result.progressByLaunchId[result.results[1].launchId], result.results[1]);
  });
});
