/**
 * Backend operations — tmux/zellij pane management, command execution, and PATH resolution.
 *
 * This is a leaf module: it has no imports from extension.mjs.
 * All functions accept pre-built request objects and runtime services via parameters.
 */

import { execFile } from "node:child_process";
import { access, constants as fsConstants, mkdtemp, readFile, rm } from "node:fs/promises";
import { mkdirSync as defaultMkdirSync, writeFileSync as defaultWriteFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { stripPanePrefix } from "./utils.mjs";

const execFileAsync = promisify(execFile);

export function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

export function encodeBase64(value) {
  return Buffer.from(String(value ?? ""), "utf8").toString("base64");
}

export function listCommandSearchPaths(env = process.env) {
  const directories = new Set();
  const pathValue = env.PATH;

  if (typeof pathValue === "string") {
    for (const directory of pathValue.split(path.delimiter)) {
      if (directory) {
        directories.add(directory);
      }
    }
  }

  const userName = env.USER ?? env.LOGNAME ?? null;
  if (userName) {
    directories.add(path.join("/etc/profiles/per-user", userName, "bin"));
  }

  directories.add("/run/current-system/sw/bin");
  directories.add("/usr/local/bin");
  directories.add("/usr/bin");
  directories.add("/bin");

  return [...directories];
}

export async function resolveCommandPath(commandName, env = process.env) {
  if (path.isAbsolute(commandName)) {
    try {
      await access(commandName, fsConstants.X_OK);
      return commandName;
    } catch {
      return null;
    }
  }

  for (const directory of listCommandSearchPaths(env)) {
    const candidate = path.join(directory, commandName);

    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {}
  }

  return null;
}

export function createRuntimeUnavailableError(operation, backend) {
  const error = new Error(
    `Launch runtime operation ${operation} is not configured for backend ${backend}.`,
  );
  error.code = "LAUNCH_RUNTIME_UNAVAILABLE";
  return error;
}

export function resolveLaunchRuntimeOperation(request = {}, backend, operation) {
  const runtime = request.launchRuntime ?? {};

  if (typeof runtime[operation] === "function") {
    return runtime[operation];
  }

  if (typeof runtime?.backends?.[backend]?.[operation] === "function") {
    return runtime.backends[backend][operation];
  }

  return null;
}

export async function runDefaultBackendCommand({ request, runtimeServices = {}, backend, args }) {
  const runner = request.runBackendCommand ?? runtimeServices.runBackendCommand;
  const env = Object.fromEntries(
    Object.entries({ ...process.env, ...(request.env ?? {}) }).filter(([, v]) => v != null),
  );
  const cwd = request.cwd ?? process.cwd();
  if (typeof runner === "function") {
    return runner({ command: backend, args, cwd, env, request });
  }

  const command = (await resolveCommandPath(backend, env)) ?? backend;
  const { stdout = "", stderr = "" } = await execFileAsync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });

  return { stdout, stderr };
}

export function defaultTmuxSessionName(request = {}) {
  const suffix = path.basename(request.projectRoot ?? process.cwd()).replace(/[^A-Za-z0-9_-]+/g, "-");
  return `copilot-subagents-${suffix || "session"}`.slice(0, 64);
}

export async function createPrivateTempFile(prefix, fileName) {
  const directoryPath = await mkdtemp(path.join(tmpdir(), `${prefix}-`));
  return {
    directoryPath,
    filePath: path.join(directoryPath, fileName),
  };
}

export async function waitForFileText(filePath, {
  timeoutMs = 5000,
  intervalMs = 25,
} = {}) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const text = await readFile(filePath, "utf8");
      if (text.trim()) {
        return text;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  const error = new Error(`Timed out waiting for zellij pane metadata at ${filePath}.`);
  error.code = "LAUNCH_RUNTIME_UNAVAILABLE";
  throw error;
}

export function withoutZellijPaneRequest(request = {}) {
  return {
    ...request,
    env: {
      ...(request.env ?? {}),
      ZELLIJ_PANE_ID: null,
    },
  };
}

export function getPaneCaptureArgs(backend, paneId) {
  switch (backend) {
    case "tmux":
      return ["capture-pane", "-p", "-t", paneId, "-S", "-200"];
    default:
      throw createRuntimeUnavailableError("readPaneOutput", backend);
  }
}

export function buildOpenPaneArgs(backend, context = {}) {
  const orientation = context.layout?.orientation;
  switch (backend) {
    case "tmux":
      return [
        "split-window",
        orientation === "horizontal" ? "-v" : "-h",
        ...(context.launchAction === "start" && context.backendSessionName ? ["-t", context.backendSessionName] : []),
        "-P",
        "-F",
        "#{pane_id}",
      ];
    case "zellij":
      return [
        "action",
        "new-pane",
        "--direction",
        orientation === "horizontal" ? "down" : "right",
        "--name",
        context.agentIdentifier ?? "copilot-subagent",
        "--",
        "bash",
      ];
    default:
      throw createRuntimeUnavailableError("openPane", backend);
  }
}

export function extractPaneId(stdout = "") {
  const paneId = String(stdout).trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!paneId) return null;
  const zellijMatch = paneId.match(/^terminal_(\d+)$/);
  if (zellijMatch) return `pane:${zellijMatch[1]}`;
  return paneId;
}

function buildLaunchEnvParts(request, { agentIdentifierB64, taskB64, copilotSessionId }) {
  const parts = [
    `COPILOT_SUBAGENT_AGENT_B64=${shellEscape(agentIdentifierB64)}`,
    `COPILOT_SUBAGENT_TASK_B64=${shellEscape(taskB64)}`,
  ];
  if (copilotSessionId) {
    parts.push(`COPILOT_SUBAGENT_SESSION_ID=${shellEscape(copilotSessionId)}`);
  }
  if (request.launchId) {
    parts.push(`COPILOT_SUBAGENT_LAUNCH_ID=${shellEscape(request.launchId)}`);
  }
  if (request.stateDir) {
    parts.push(`COPILOT_SUBAGENT_STATE_DIR=${shellEscape(request.stateDir)}`);
  }
  return parts;
}

export function createDefaultAgentLaunchCommand(request = {}, runtimeServices = {}, { agentIdentifier, task, copilotSessionId, interactive, backend }) {
  const createAgentLaunchCommand =
    request.createAgentLaunchCommand ?? runtimeServices.createAgentLaunchCommand;
  if (typeof createAgentLaunchCommand === "function") {
    return createAgentLaunchCommand({ agentIdentifier, task, copilotSessionId, interactive, backend });
  }

  const copilotBinary = request.copilotBinary ?? runtimeServices.copilotBinary ?? "copilot";
  const agentIdentifierB64 = encodeBase64(agentIdentifier);
  const taskB64 = encodeBase64(task ?? "");
  const useDefaultCopilotAgent = agentIdentifier === "github-copilot";
  const promptFlag = interactive ? "-i" : "-p";
  const suppressStats = interactive ? "" : ' "-s",';
  const resumeFlag = copilotSessionId ? `"--resume=${copilotSessionId}",` : "";
  const runnerScript = [
    'const { spawnSync, spawn } = require("node:child_process");',
    'const decode = (name) => Buffer.from(process.env[name] || "", "base64").toString("utf8");',
    useDefaultCopilotAgent
      ? `const args = [${resumeFlag} "${promptFlag}", decode("COPILOT_SUBAGENT_TASK_B64"), "--allow-all-tools", "--allow-all-paths", "--allow-all-urls", "--no-ask-user",${suppressStats}];`
      : `const args = [${resumeFlag} "--agent", decode("COPILOT_SUBAGENT_AGENT_B64"), "${promptFlag}", decode("COPILOT_SUBAGENT_TASK_B64"), "--allow-all-tools", "--allow-all-paths", "--allow-all-urls", "--no-ask-user",${suppressStats}];`,
    `const result = spawnSync(${JSON.stringify(copilotBinary)}, args, { stdio: "inherit" });`,
    'const code = Number.isInteger(result.status) ? result.status : 1;',
    'process.stdout.write("\\n__SUBAGENT_DONE_" + code + "__\\n");',
    'try {',
    '  const zPane = process.env.ZELLIJ_PANE_ID;',
    '  const tPane = process.env.TMUX_PANE;',
    '  if (zPane) {',
    '    const child = spawn("zellij", ["action", "close-pane", "--pane-id", zPane], { detached: true, stdio: "ignore" });',
    '    child.unref();',
    '  } else if (tPane) {',
    '    const child = spawn("tmux", ["kill-pane", "-t", tPane], { detached: true, stdio: "ignore" });',
    '    child.unref();',
    '  }',
    '} catch (_) {}',
    'process.exit(code);',
  ].join("");

  const envParts = buildLaunchEnvParts(request, { agentIdentifierB64, taskB64, copilotSessionId });
  return [...envParts, `node -e ${shellEscape(runnerScript)}`].join(" ");
}

export async function defaultOpenPane({ backend, request, runtimeServices = {}, ...context }) {
  const openPane = resolveLaunchRuntimeOperation(request, backend, "openPane");
  if (openPane) {
    return openPane({ backend, request, ...context });
  }

  const result = await runDefaultBackendCommand({
    request,
    runtimeServices,
    backend,
    args: buildOpenPaneArgs(backend, context),
  });
  let paneId = extractPaneId(result?.stdout);
  if (backend === "zellij" && (!paneId || !/^pane:\d+$/.test(paneId))) {
    const { directoryPath, filePath: paneIdPath } = await createPrivateTempFile(
      "copilot-subagents-zellij-pane",
      "pane-id.txt",
    );
    try {
      const direction = context.layout?.orientation === "horizontal" ? "down" : "right";
      const captureScript = `echo "$ZELLIJ_PANE_ID" > ${shellEscape(paneIdPath)} && exec bash`;
      await runDefaultBackendCommand({
        request: withoutZellijPaneRequest(request),
        runtimeServices,
        backend,
        args: ["run", "--direction", direction, "--name", context.agentIdentifier ?? "copilot-subagent", "--", "bash", "-c", captureScript],
      });
      const capturedPaneId = (await waitForFileText(paneIdPath)).trim();
      if (capturedPaneId) {
        paneId = `pane:${capturedPaneId}`;
      }
    } catch (error) {
      await rm(directoryPath, { force: true, recursive: true }).catch(() => {});
      throw error;
    }
    await rm(directoryPath, { force: true, recursive: true }).catch(() => {});
  }

  if (!paneId) {
    throw createRuntimeUnavailableError("openPane", backend);
  }

  return {
    paneId,
    visible: true,
  };
}

export async function defaultLaunchAgentInPane({ backend, request, runtimeServices = {}, ...context }) {
  const launchAgentInPane = resolveLaunchRuntimeOperation(
    request,
    backend,
    "launchAgentInPane",
  );
  if (launchAgentInPane) {
    return launchAgentInPane({ backend, request, ...context });
  }

  const command = createDefaultAgentLaunchCommand(request, runtimeServices, context);

  switch (backend) {
    case "tmux":
      await runDefaultBackendCommand({
        request,
        runtimeServices,
        backend,
        args: ["select-pane", "-t", context.paneId],
      });
      await runDefaultBackendCommand({
        request,
        runtimeServices,
        backend,
        args: ["send-keys", "-t", context.paneId, "-l", command],
      });
      await runDefaultBackendCommand({
        request,
        runtimeServices,
        backend,
        args: ["send-keys", "-t", context.paneId, "Enter"],
      });
      return {
        sessionId: request.sessionId ?? null,
      };
    case "zellij":
      await runDefaultBackendCommand({
        request: withoutZellijPaneRequest(request),
        runtimeServices,
        backend,
        args: ["action", "write-chars", "--pane-id", stripPanePrefix(context.paneId), command],
      });
      await runDefaultBackendCommand({
        request: withoutZellijPaneRequest(request),
        runtimeServices,
        backend,
        args: ["action", "write", "--pane-id", stripPanePrefix(context.paneId), "13"],
      });
      return {
        sessionId: request.sessionId ?? null,
      };
    default:
      throw createRuntimeUnavailableError("launchAgentInPane", backend);
  }
}

export async function defaultReadPaneOutput({ backend, request, runtimeServices = {}, ...context }) {
  const readPaneOutput = resolveLaunchRuntimeOperation(
    request,
    backend,
    "readPaneOutput",
  );
  if (readPaneOutput) {
    return readPaneOutput({ backend, request, ...context });
  }

  if (backend === "zellij") {
    const args = ["action", "dump-screen", "--pane-id", stripPanePrefix(context.paneId), "-f"];
    const result = await runDefaultBackendCommand({
      request: withoutZellijPaneRequest(request),
      runtimeServices,
      backend,
      args,
    });
    return { output: result?.output ?? result?.stdout ?? "" };
  }

  const result = await runDefaultBackendCommand({
    request,
    runtimeServices,
    backend,
    args: getPaneCaptureArgs(backend, context.paneId),
  });
  return { ...result, output: result?.output ?? result?.stdout ?? "" };
}

export async function defaultReadChildSessionState({ backend, request, runtimeServices = {}, ...context }) {
  const readChildSessionState = resolveLaunchRuntimeOperation(
    request,
    backend,
    "readChildSessionState",
  );
  if (!readChildSessionState) {
    return null;
  }

  return readChildSessionState({ backend, request, ...context });
}

export async function defaultAttachBackendForRuntime(backend) {
  switch (backend) {
    case "tmux":
    case "zellij":
      return {};
    default:
      throw createRuntimeUnavailableError("attach", backend);
  }
}

export async function defaultStartBackendForRuntime(backend, request, runtimeServices = {}) {
  if (backend !== "tmux") {
    throw createRuntimeUnavailableError("start", backend);
  }

  const sessionName = request.tmuxSessionName ?? runtimeServices.tmuxSessionName ?? defaultTmuxSessionName(request);
  await runDefaultBackendCommand({
    request,
    runtimeServices,
    backend,
    args: ["new-session", "-A", "-d", "-s", sessionName],
  });
  return { sessionName };
}
