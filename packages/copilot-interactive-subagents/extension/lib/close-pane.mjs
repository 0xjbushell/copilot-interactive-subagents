import { spawnSync as defaultSpawnSync } from "node:child_process";
import { stripPanePrefix } from "./utils.mjs";

function interpretResult(result, label) {
  if (result.status === 0) {
    return { ok: true, alreadyClosed: false };
  }
  const stderr = String(result.stderr ?? "").trim();
  if (stderr.includes("not found") || stderr.includes("no such")) {
    return { ok: true, alreadyClosed: true };
  }
  return { ok: false, code: "CLOSE_PANE_FAILED", message: stderr || `${label} exited with ${result.status}` };
}

export function closePane({ backend, paneId, services = {} } = {}) {
  const spawnSync = services.spawnSync ?? defaultSpawnSync;

  if (backend === "tmux") {
    return interpretResult(spawnSync("tmux", ["kill-pane", "-t", paneId], { stdio: "pipe" }), "tmux kill-pane");
  }
  if (backend === "zellij") {
    const numericId = stripPanePrefix(paneId);
    return interpretResult(spawnSync("zellij", ["action", "close-pane", "--pane-id", numericId], { stdio: "pipe" }), "zellij close-pane");
  }

  const error = new Error(`closePane: unsupported backend "${backend}"`);
  error.code = "CLOSE_PANE_UNSUPPORTED_BACKEND";
  throw error;
}
