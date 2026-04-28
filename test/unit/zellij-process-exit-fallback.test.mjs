/**
 * Tests that defaultReadPaneOutput for zellij falls back to list-panes
 * process-exit detection when dump-screen returns empty output.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { importProjectModule } from "../helpers/red-harness.mjs";

const mod = await importProjectModule(
  "packages/copilot-interactive-subagents/extension/lib/backend-ops.mjs",
  ["defaultReadPaneOutput"],
);
const { defaultReadPaneOutput } = mod;

function makeRunBackendCommand(responses) {
  return async ({ args }) => {
    for (const { match, result } of responses) {
      if (match(args)) return result;
    }
    return { stdout: "", stderr: "" };
  };
}

describe("defaultReadPaneOutput — zellij process-exit fallback", () => {
  it("returns dump-screen output when non-empty", async () => {
    const runBackendCommand = makeRunBackendCommand([
      {
        match: (args) => args.includes("dump-screen"),
        result: { stdout: "hello world\n__SUBAGENT_DONE_0__\n" },
      },
    ]);

    const result = await defaultReadPaneOutput({
      backend: "zellij",
      request: { runBackendCommand },
      paneId: "pane:1",
    });

    assert.ok(result.output.includes("__SUBAGENT_DONE_0__"));
  });

  it("synthesizes sentinel when dump-screen empty and process exited", async () => {
    const runBackendCommand = makeRunBackendCommand([
      {
        match: (args) => args.includes("dump-screen"),
        result: { stdout: "" },
      },
      {
        match: (args) => args.includes("list-panes"),
        result: { stdout: JSON.stringify([{ id: 1, is_plugin: false, exited: true, exit_status: 0 }]) },
      },
    ]);

    const result = await defaultReadPaneOutput({
      backend: "zellij",
      request: { runBackendCommand },
      paneId: "pane:1",
    });

    assert.ok(result.output.includes("__SUBAGENT_DONE_0__"), `expected sentinel, got: ${result.output}`);
  });

  it("preserves exit code from list-panes", async () => {
    const runBackendCommand = makeRunBackendCommand([
      {
        match: (args) => args.includes("dump-screen"),
        result: { stdout: "" },
      },
      {
        match: (args) => args.includes("list-panes"),
        result: { stdout: JSON.stringify([{ id: 3, is_plugin: false, exited: true, exit_status: 42 }]) },
      },
    ]);

    const result = await defaultReadPaneOutput({
      backend: "zellij",
      request: { runBackendCommand },
      paneId: "pane:3",
    });

    assert.ok(result.output.includes("__SUBAGENT_DONE_42__"), `expected exit code 42, got: ${result.output}`);
  });

  it("defaults to exit code 0 when exit_status absent", async () => {
    const runBackendCommand = makeRunBackendCommand([
      {
        match: (args) => args.includes("dump-screen"),
        result: { stdout: "" },
      },
      {
        match: (args) => args.includes("list-panes"),
        result: { stdout: JSON.stringify([{ id: 1, is_plugin: false, exited: true }]) },
      },
    ]);

    const result = await defaultReadPaneOutput({
      backend: "zellij",
      request: { runBackendCommand },
      paneId: "pane:1",
    });

    assert.ok(result.output.includes("__SUBAGENT_DONE_0__"), `expected exit code 0, got: ${result.output}`);
  });

  it("returns empty when dump-screen empty and process still running", async () => {
    const runBackendCommand = makeRunBackendCommand([
      {
        match: (args) => args.includes("dump-screen"),
        result: { stdout: "" },
      },
      {
        match: (args) => args.includes("list-panes"),
        result: { stdout: JSON.stringify([{ id: 1, is_plugin: false, exited: false, pane_command: "node" }]) },
      },
    ]);

    const result = await defaultReadPaneOutput({
      backend: "zellij",
      request: { runBackendCommand },
      paneId: "pane:1",
    });

    assert.equal(result.output, "");
  });

  it("synthesizes sentinel when pane not found in list-panes (already closed)", async () => {
    const runBackendCommand = makeRunBackendCommand([
      {
        match: (args) => args.includes("dump-screen"),
        result: { stdout: "" },
      },
      {
        match: (args) => args.includes("list-panes"),
        result: { stdout: JSON.stringify([{ id: 99, is_plugin: false, exited: false }]) },
      },
    ]);

    const result = await defaultReadPaneOutput({
      backend: "zellij",
      request: { runBackendCommand },
      paneId: "pane:1",
    });

    assert.ok(result.output.includes("__SUBAGENT_DONE_0__"), `expected sentinel for missing pane, got: ${result.output}`);
  });

  it("returns empty when list-panes fails", async () => {
    const runBackendCommand = makeRunBackendCommand([
      {
        match: (args) => args.includes("dump-screen"),
        result: { stdout: "" },
      },
      {
        match: (args) => args.includes("list-panes"),
        result: { stdout: "not json" },
      },
    ]);

    const result = await defaultReadPaneOutput({
      backend: "zellij",
      request: { runBackendCommand },
      paneId: "pane:1",
    });

    assert.equal(result.output, "");
  });

  it("ignores plugin panes when checking exit status", async () => {
    const runBackendCommand = makeRunBackendCommand([
      {
        match: (args) => args.includes("dump-screen"),
        result: { stdout: "" },
      },
      {
        match: (args) => args.includes("list-panes"),
        result: { stdout: JSON.stringify([
          { id: 1, is_plugin: true, exited: true, exit_status: 0 },
          { id: 1, is_plugin: false, exited: false, pane_command: "node" },
        ]) },
      },
    ]);

    const result = await defaultReadPaneOutput({
      backend: "zellij",
      request: { runBackendCommand },
      paneId: "pane:1",
    });

    // Non-plugin pane with id 1 is still running → should return empty
    assert.equal(result.output, "");
  });
});
