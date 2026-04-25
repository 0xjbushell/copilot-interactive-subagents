import { test } from "node:test";
import assert from "node:assert/strict";
import { importProjectModule } from "../helpers/red-harness.mjs";

const { createParallelProgressTracker, deriveAggregateStatus } = await importProjectModule(
  "packages/copilot-interactive-subagents/extension/lib/progress.mjs",
  ["createParallelProgressTracker", "deriveAggregateStatus"],
);

function trackerFromStatuses(statuses) {
  const launches = statuses.map((_, i) => ({ plan: { launchId: `L${i}`, agentIdentifier: "x", agentKind: "built-in", backend: "tmux" } }));
  const tracker = createParallelProgressTracker({ launches });
  statuses.forEach((status, i) => {
    tracker.recordResult({ launchId: `L${i}`, status });
  });
  return tracker;
}

test("D5.1: success+ping → aggregateStatus success, pingCount counted", () => {
  const snap = trackerFromStatuses(["success", "ping", "success"]).snapshot();
  assert.equal(snap.aggregateStatus, "success");
  assert.equal(snap.pingCount, 1);
  assert.equal(snap.successCount, 2);
  assert.equal(snap.failureCount, 0);
});

test("D5.1: all-ping → aggregateStatus success", () => {
  const snap = trackerFromStatuses(["ping", "ping"]).snapshot();
  assert.equal(snap.aggregateStatus, "success");
  assert.equal(snap.pingCount, 2);
  assert.equal(snap.successCount, 0);
});

test("D5.1: failure+ping → partial-success", () => {
  const snap = trackerFromStatuses(["failure", "ping"]).snapshot();
  assert.equal(snap.aggregateStatus, "partial-success");
  assert.equal(snap.pingCount, 1);
  assert.equal(snap.failureCount, 1);
});

test("D5.1: running+ping → running (ping terminal but others active)", () => {
  const snap = trackerFromStatuses(["running", "ping"]).snapshot();
  assert.equal(snap.aggregateStatus, "running");
});

test("D5.1: cancelled+ping → partial-success; cancelled counted as failure", () => {
  const snap = trackerFromStatuses(["cancelled", "ping"]).snapshot();
  assert.equal(snap.aggregateStatus, "partial-success");
  assert.equal(snap.pingCount, 1);
  assert.equal(snap.failureCount, 1);
  assert.equal(snap.successCount, 0);
});

test("D5.1: pingCount === 0 (strict) when no pings", () => {
  const snap = trackerFromStatuses(["success", "failure"]).snapshot();
  assert.equal(snap.pingCount, 0);
  assert.notEqual(snap.pingCount, undefined);
});

test("D5.1: empty results → success", () => {
  const tracker = createParallelProgressTracker({ launches: [] });
  const snap = tracker.snapshot();
  assert.equal(snap.aggregateStatus, "success");
  assert.equal(snap.pingCount, 0);
});

test("D5.1: deriveAggregateStatus directly (all-failure)", () => {
  assert.equal(deriveAggregateStatus([{ status: "failure" }, { status: "failure" }]), "failure");
});

test("D5.1: deriveAggregateStatus all-cancelled remains cancelled (no non-failure terminals)", () => {
  assert.equal(deriveAggregateStatus([{ status: "cancelled" }, { status: "cancelled" }]), "cancelled");
});

test("D5.1: deriveAggregateStatus all-timeout remains timeout", () => {
  assert.equal(deriveAggregateStatus([{ status: "timeout" }, { status: "timeout" }]), "timeout");
});

test("D5.1: failureCount excludes interactive status", () => {
  const snap = trackerFromStatuses(["interactive", "failure"]).snapshot();
  // interactive is in-flight; aggregate is "running" (interactive is non-terminal).
  assert.equal(snap.aggregateStatus, "running");
  assert.equal(snap.failureCount, 1, "interactive must NOT be counted as failure");
});
