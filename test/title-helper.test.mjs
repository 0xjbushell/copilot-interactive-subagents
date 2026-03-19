import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { importProjectModule } from "./helpers/red-harness.mjs";

describe("pane title helper", () => {
  it("uses runtime title updates when the caller provides a setPaneTitle adapter", async () => {
    const { setSubagentTitle } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/titles.mjs",
      ["setSubagentTitle"],
    );

    const calls = [];
    const result = await setSubagentTitle({
      request: {
        backend: "zellij",
        paneId: "pane-7",
        title: "Waiting for review",
        setPaneTitle: async (payload) => {
          calls.push(payload);
          return { applied: true };
        },
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].backend, "zellij");
    assert.equal(calls[0].paneId, "pane-7");
    assert.equal(calls[0].title, "Waiting for review");
    assert.equal(calls[0].request.backend, "zellij");
    assert.equal(calls[0].request.paneId, "pane-7");
    assert.equal(calls[0].request.title, "Waiting for review");
    assert.equal(typeof calls[0].request.setPaneTitle, "function");
    assert.deepEqual(
      { ...result, request: undefined },
      {
        ok: true,
        backend: "zellij",
        paneId: "pane-7",
        title: "Waiting for review",
        applied: true,
        source: "runtime",
        request: undefined,
      },
    );
  });

  it("uses the tmux backend command when no runtime adapter is supplied", async () => {
    const { setSubagentTitle } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/titles.mjs",
      ["setSubagentTitle"],
    );

    const commands = [];
    const result = await setSubagentTitle({
      request: {
        backend: "tmux",
        paneId: "%3",
        title: "Investigating",
        runBackendCommand: async ({ command, args }) => {
          commands.push({ command, args });
          return { stdout: "" };
        },
      },
    });

    assert.deepEqual(commands, [
      {
        command: "tmux",
        args: ["select-pane", "-t", "%3", "-T", "Investigating"],
      },
    ]);
    assert.deepEqual(result, {
      ok: true,
      backend: "tmux",
      paneId: "%3",
      title: "Investigating",
      applied: true,
      source: "backend-command",
    });
  });

  it("returns a stable unsupported-backend error when no default title command exists", async () => {
    const { setSubagentTitle } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/titles.mjs",
      ["setSubagentTitle"],
    );

    const result = await setSubagentTitle({
      request: {
        backend: "cmux",
        paneId: "pane-2",
        title: "Waiting",
      },
    });

    assert.deepEqual(result, {
      ok: false,
      code: "TITLE_UNSUPPORTED",
      message: "Backend cmux does not expose a default title-update command.",
      backend: "cmux",
      paneId: "pane-2",
      guidance: "Provide a runtime setPaneTitle implementation or use tmux for built-in title support.",
    });
  });

  it("normalizes set-title requests from resume pointers and rejects incomplete targets consistently", async () => {
    const { createExtensionHandlers } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/extension.mjs",
      ["createExtensionHandlers"],
    );

    const handlers = await createExtensionHandlers({
      continueSetTitle: async ({ request }) => ({
        ok: true,
        backend: request.backend,
        paneId: request.paneId,
        title: request.title,
        applied: true,
        source: "runtime",
      }),
    });

    const fromResumePointer = await handlers.copilot_subagent_set_title({
      title: "Awaiting validation",
      resumePointer: {
        backend: "tmux",
        paneId: "%9",
      },
    });
    const invalid = await handlers.copilot_subagent_set_title({
      title: "Awaiting validation",
      backend: "tmux",
    });

    assert.deepEqual(fromResumePointer, {
      ok: true,
      backend: "tmux",
      paneId: "%9",
      title: "Awaiting validation",
      applied: true,
      source: "runtime",
    });
    assert.deepEqual(invalid, {
      ok: false,
      code: "INVALID_ARGUMENT",
      field: "paneId",
      message: "paneId must be provided directly or via resumePointer.paneId.",
      guidance: "Pass the pane identifier returned from launch or resume.",
    });
  });
});
