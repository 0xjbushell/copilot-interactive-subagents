import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { normalizeNonEmptyString } from "./utils.mjs";

const execFileAsync = promisify(execFile);

function createTitleFailure({ code, message, backend = null, paneId = null, guidance }) {
  return {
    ok: false,
    code,
    message,
    backend,
    paneId,
    guidance,
  };
}

function resolveTarget(request = {}) {
  return {
    backend:
      normalizeNonEmptyString(request.backend)
      ?? normalizeNonEmptyString(request.requestedBackend)
      ?? normalizeNonEmptyString(request.resumePointer?.backend),
    paneId:
      normalizeNonEmptyString(request.paneId)
      ?? normalizeNonEmptyString(request.resumePointer?.paneId),
    title: normalizeNonEmptyString(request.title),
  };
}

async function runBackendCommand({ request, services = {}, backend, args }) {
  const runner = request.runBackendCommand ?? services.runBackendCommand;
  if (typeof runner === "function") {
    return runner({ command: backend, args });
  }

  return execFileAsync(backend, args, {
    cwd: request.cwd ?? process.cwd(),
    env: {
      ...process.env,
      ...(request.env ?? {}),
    },
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
}

function buildTitleArgs(backend, paneId, title) {
  switch (backend) {
    case "tmux":
      return ["select-pane", "-t", paneId, "-T", title];
    default:
      return null;
  }
}

export async function setSubagentTitle({ request = {}, services = {} } = {}) {
  const target = resolveTarget(request);

  if (!target.title) {
    return createTitleFailure({
      code: "INVALID_ARGUMENT",
      message: "title must be a non-empty string.",
      guidance: "Provide the human-readable phase or title to show in the pane.",
    });
  }

  if (!target.backend || !target.paneId) {
    return createTitleFailure({
      code: "TITLE_TARGET_INVALID",
      message: "backend and paneId are required to update a pane title.",
      backend: target.backend,
      paneId: target.paneId,
      guidance: "Pass backend and paneId directly or via a resumePointer from launch/resume.",
    });
  }

  const setPaneTitle = request.setPaneTitle ?? services.setPaneTitle;
  if (typeof setPaneTitle === "function") {
    const result = await setPaneTitle({
      backend: target.backend,
      paneId: target.paneId,
      title: target.title,
      request,
    });

    return {
      ok: true,
      backend: target.backend,
      paneId: target.paneId,
      title: target.title,
      applied: result?.applied !== false,
      source: "runtime",
    };
  }

  const args = buildTitleArgs(target.backend, target.paneId, target.title);
  if (!args) {
    return createTitleFailure({
      code: "TITLE_UNSUPPORTED",
      message: `Backend ${target.backend} does not expose a default title-update command.`,
      backend: target.backend,
      paneId: target.paneId,
      guidance: "Provide a runtime setPaneTitle implementation or use tmux for built-in title support.",
    });
  }

  await runBackendCommand({
    request,
    services,
    backend: target.backend,
    args,
  });

  return {
    ok: true,
    backend: target.backend,
    paneId: target.paneId,
    title: target.title,
    applied: true,
    source: "backend-command",
  };
}
