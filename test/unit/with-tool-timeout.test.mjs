import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { importProjectModule } from "../helpers/red-harness.mjs";

const EXTENSION = ".github/extensions/copilot-interactive-subagents/extension.mjs";

describe("withToolTimeout discriminates handler errors from timeouts", () => {
  it("propagates handler errors with their original code intact (no TOOL_TIMEOUT wrapping)", async () => {
    const { withToolTimeout } = await importProjectModule(EXTENSION, ["withToolTimeout"]);

    const handler = async () => {
      const err = new Error("bad manifest");
      err.code = "MANIFEST_VERSION_UNSUPPORTED";
      err.observedVersion = 2;
      throw err;
    };

    await assert.rejects(
      () => withToolTimeout("test_tool", handler, {}),
      (err) => err?.code === "MANIFEST_VERSION_UNSUPPORTED" && err.observedVersion === 2,
    );
  });

  it("propagates plain (non-coded) errors from handler", async () => {
    const { withToolTimeout } = await importProjectModule(EXTENSION, ["withToolTimeout"]);
    await assert.rejects(
      () => withToolTimeout("t", async () => { throw new Error("boom"); }, {}),
      /boom/,
    );
  });

  it("returns the handler's resolved value untouched", async () => {
    const { withToolTimeout } = await importProjectModule(EXTENSION, ["withToolTimeout"]);
    const result = await withToolTimeout("t", async (a) => ({ ok: true, echo: a }), { x: 1 });
    assert.deepEqual(result, { ok: true, echo: { x: 1 } });
  });

  // Real-timer test of the timeout path is undesirably slow (10min default).
  // The discriminator is verified structurally via the throwing-handler test:
  // because `timedOut` only flips inside the timer callback, a thrown handler
  // error with timedOut=false re-throws (asserted above). The inverse path
  // (timedOut=true) is exercised by the existing tool-interface coverage.
});
