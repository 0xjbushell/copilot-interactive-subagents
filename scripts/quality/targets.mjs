const DEFAULT_DETERMINISTIC_LOGIC_TARGETS = [
  "packages/copilot-interactive-subagents/extension/lib/agents.mjs",
  "packages/copilot-interactive-subagents/extension/lib/backend-ops.mjs",
  "packages/copilot-interactive-subagents/extension/lib/close-pane.mjs",
  "packages/copilot-interactive-subagents/extension/lib/exit-sidecar.mjs",
  "packages/copilot-interactive-subagents/extension/lib/fork-session.mjs",
  "packages/copilot-interactive-subagents/extension/lib/launch.mjs",
  "packages/copilot-interactive-subagents/extension/lib/mux-layout.mjs",
  "packages/copilot-interactive-subagents/extension/lib/mux.mjs",
  "packages/copilot-interactive-subagents/extension/lib/parallel.mjs",
  "packages/copilot-interactive-subagents/extension/lib/progress.mjs",
  "packages/copilot-interactive-subagents/extension/lib/resolve.mjs",
  "packages/copilot-interactive-subagents/extension/lib/session-lock.mjs",
  "packages/copilot-interactive-subagents/extension/lib/state.mjs",
  "packages/copilot-interactive-subagents/extension/lib/summary.mjs",
  "packages/copilot-interactive-subagents/extension/lib/titles.mjs",
  "packages/copilot-interactive-subagents/extension/lib/tool-schemas.mjs",
  "packages/copilot-interactive-subagents/extension/lib/utils.mjs",
  "packages/copilot-interactive-subagents/extension/lib/validation.mjs",
  "packages/copilot-interactive-subagents/extension/extension.mjs",
];

export const RESUME_DETERMINISTIC_LOGIC_TARGETS = [
  "packages/copilot-interactive-subagents/extension/lib/resume.mjs",
  "packages/copilot-interactive-subagents/extension/lib/state-index.mjs",
];

export const DETERMINISTIC_LOGIC_TARGETS = [...DEFAULT_DETERMINISTIC_LOGIC_TARGETS];

const DEFAULT_TARGETED_MUTANTS = [
  {
    id: "agents-exact-name-only",
    file: "packages/copilot-interactive-subagents/extension/lib/agents.mjs",
    from: "exactNameOnly: true,",
    to: "exactNameOnly: false,",
  },
  {
    id: "agents-custom-kind",
    file: "packages/copilot-interactive-subagents/extension/lib/agents.mjs",
    from: 'agentKind: "custom",',
    to: 'agentKind: "built-in",',
  },
  {
    id: "agents-not-found-code",
    file: "packages/copilot-interactive-subagents/extension/lib/agents.mjs",
    from: 'code: "AGENT_NOT_FOUND",',
    to: 'code: "AGENT_VALIDATION_UNAVAILABLE",',
  },
  {
    id: "agents-available-identifiers",
    file: "packages/copilot-interactive-subagents/extension/lib/agents.mjs",
    from: "availableIdentifiers: [...customIdentifiers, ...acceptedBuiltIns],",
    to: "availableIdentifiers: acceptedBuiltIns,",
  },
  {
    id: "mux-attached-source",
    file: "packages/copilot-interactive-subagents/extension/lib/mux.mjs",
    from: 'source: "attached",',
    to: 'source: "startable",',
  },
  {
    id: "mux-manual-setup",
    file: "packages/copilot-interactive-subagents/extension/lib/mux.mjs",
    from: "manualSetupRequired: false,",
    to: "manualSetupRequired: true,",
  },
  {
    id: "mux-start-unsupported-code",
    file: "packages/copilot-interactive-subagents/extension/lib/mux.mjs",
    from: 'code: "BACKEND_START_UNSUPPORTED",',
    to: 'code: "BACKEND_UNAVAILABLE",',
  },
  {
    id: "mux-tmux-detection",
    file: "packages/copilot-interactive-subagents/extension/lib/mux.mjs",
    from: "return Boolean(env.TMUX);",
    to: "return false;",
  },
  {
    id: "extension-agent-list",
    file: "packages/copilot-interactive-subagents/extension/extension.mjs",
    from: "agentIdentifiers: agentResult.runtimeRecognizedIdentifiers,",
    to: "agentIdentifiers: [],",
  },
  {
    id: "extension-builtin-list",
    file: "packages/copilot-interactive-subagents/extension/extension.mjs",
    from: "builtInIdentifiersAcceptedExplicitly: agentResult.builtInIdentifiersAcceptedExplicitly,",
    to: "builtInIdentifiersAcceptedExplicitly: [],",
  },
  {
    id: "extension-normalize-request",
    file: "packages/copilot-interactive-subagents/extension/lib/validation.mjs",
    from: "normalizeNonEmptyString(request.agentIdentifier);",
    to: "null;",
  },
  {
    id: "extension-launch-argument-validation",
    file: "packages/copilot-interactive-subagents/extension/lib/validation.mjs",
    from: '      field: `${prefix}agentIdentifier`,',
    to: '      field: `${prefix}task`,',
  },
  {
    id: "extension-parallel-backend-conflict",
    file: "packages/copilot-interactive-subagents/extension/lib/validation.mjs",
    from: "  if (uniqueBackends.length > 1) {",
    to: "  if (uniqueBackends.length > 2) {",
  },
  {
    id: "titles-unsupported-backend",
    file: "packages/copilot-interactive-subagents/extension/lib/titles.mjs",
    from: '      code: "TITLE_UNSUPPORTED",',
    to: '      code: "TITLE_TARGET_INVALID",',
  },
  {
    id: "launch-action-mapping",
    file: "packages/copilot-interactive-subagents/extension/lib/launch.mjs",
    from: `agentIdentifier: agentValidation.identifier,
    agentKind: agentValidation.agentKind,`,
    to: `agentIdentifier: undefined,
    agentKind: agentValidation.agentKind,`,
  },
  {
    id: "launch-await-completion-default",
    file: "packages/copilot-interactive-subagents/extension/lib/launch.mjs",
    from: "awaitCompletion: request.awaitCompletion ?? !interactive,",
    to: "awaitCompletion: false,",
  },
  {
    id: "mux-layout-tiled-strategy",
    file: "packages/copilot-interactive-subagents/extension/lib/mux-layout.mjs",
    from: '  return "tiled";',
    to: '  return "split";',
  },
  {
    id: "parallel-layout-forwarding",
    file: "packages/copilot-interactive-subagents/extension/lib/parallel.mjs",
    from: "        layout: entry.layout,",
    to: "        layout: undefined,",
  },
  {
    id: "parallel-launch-await",
    file: "packages/copilot-interactive-subagents/extension/lib/parallel.mjs",
    from: "  return controller.completionPromise;",
    to: "  return controller.getProgress();",
  },
  {
    id: "progress-running-priority",
    file: "packages/copilot-interactive-subagents/extension/lib/progress.mjs",
    from: '    return "running";',
    to: '    return "failure";',
  },
  {
    id: "progress-partial-success",
    file: "packages/copilot-interactive-subagents/extension/lib/progress.mjs",
    from: '    return "partial-success";',
    to: '    return "failure";',
  },
  {
    id: "progress-request-order",
    file: "packages/copilot-interactive-subagents/extension/lib/progress.mjs",
    from: "    const results = orderedLaunchIds.map((launchId) => cloneRecord(records.get(launchId)));",
    to: "    const results = [...orderedLaunchIds].reverse().map((launchId) => cloneRecord(records.get(launchId)));",
  },
  {
    id: "state-metadata-version",
    file: "packages/copilot-interactive-subagents/extension/lib/state.mjs",
    from: "metadataVersion = METADATA_VERSION,",
    to: "metadataVersion = 0,",
  },
  {
    id: "state-running-status",
    file: "packages/copilot-interactive-subagents/extension/lib/launch.mjs",
    from: 'const activeStatus = plan.interactive ? "interactive" : "running";',
    to: 'const activeStatus = "pending";',
  },
  {
    id: "summary-explicit-priority",
    file: "packages/copilot-interactive-subagents/extension/lib/summary.mjs",
    from: 'source: "explicit-summary",',
    to: 'source: "assistant-message",',
  },
  {
    id: "summary-exit-mapping",
    file: "packages/copilot-interactive-subagents/extension/lib/summary.mjs",
    from: 'return "success";',
    to: 'return "failure";',
  },
  {
    id: "summary-sidecar-source-tag",
    file: "packages/copilot-interactive-subagents/extension/lib/summary.mjs",
    from: '    source: "sidecar",',
    to: '    source: "sentinel",',
  },
  {
    id: "summary-sentinel-source-tag",
    file: "packages/copilot-interactive-subagents/extension/lib/summary.mjs",
    from: '    source: "sentinel",\n    sidecarType: null,',
    to: '    source: "timeout",\n    sidecarType: null,',
  },
  {
    id: "summary-ping-status",
    file: "packages/copilot-interactive-subagents/extension/lib/summary.mjs",
    from: '    status = "ping";',
    to: '    status = "success";',
  },
  {
    id: "summary-grace-gate",
    file: "packages/copilot-interactive-subagents/extension/lib/summary.mjs",
    from: "if (!sidecarEnabled(launchId, stateDir) || sidecarGraceMs <= 0) return null;",
    to: "if (!sidecarEnabled(launchId, stateDir) || sidecarGraceMs < 0) return null;",
  },
  {
    id: "summary-sidecar-enabled-guard",
    file: "packages/copilot-interactive-subagents/extension/lib/summary.mjs",
    from: "  return Boolean(launchId && stateDir);",
    to: "  return Boolean(launchId || stateDir);",
  },
  {
    id: "resume-task-empty-string-converge",
    file: "packages/copilot-interactive-subagents/extension/lib/resume.mjs",
    from: 'const extraPrompt = (typeof request.task === "string" && request.task.length > 0) ? request.task : null;',
    to: 'const extraPrompt = (typeof request.task === "string") ? request.task : null;',
  },
  {
    id: "resume-task-typeof-guard",
    file: "packages/copilot-interactive-subagents/extension/lib/resume.mjs",
    from: 'const extraPrompt = (typeof request.task === "string" && request.task.length > 0) ? request.task : null;',
    to: 'const extraPrompt = request.task;',
  },
  {
    id: "mux-backend-preference",
    file: "packages/copilot-interactive-subagents/extension/lib/mux.mjs",
    from: 'export const SUPPORTED_BACKENDS = ["cmux", "zellij", "tmux"];',
    to: 'export const SUPPORTED_BACKENDS = ["cmux", "tmux", "zellij"];',
  },
  {
    id: "exit-sidecar-version",
    file: "packages/copilot-interactive-subagents/extension/lib/exit-sidecar.mjs",
    from: "export const SIDECAR_VERSION = 1;",
    to: "export const SIDECAR_VERSION = 2;",
  },
  {
    id: "exit-sidecar-dirname",
    file: "packages/copilot-interactive-subagents/extension/lib/exit-sidecar.mjs",
    from: 'export const SIDECAR_DIRNAME = "exit";',
    to: 'export const SIDECAR_DIRNAME = "done";',
  },
  {
    id: "exit-sidecar-allowed-types",
    file: "packages/copilot-interactive-subagents/extension/lib/exit-sidecar.mjs",
    from: 'const ALLOWED_TYPES = new Set(["done", "ping"]);',
    to: 'const ALLOWED_TYPES = new Set(["done", "ping", "wat"]);',
  },
  {
    id: "exit-sidecar-resolve-default",
    file: "packages/copilot-interactive-subagents/extension/lib/exit-sidecar.mjs",
    from: "  const root = projectRoot ?? process.cwd();",
    to: '  const root = projectRoot ?? "/tmp";',
  },
  {
    id: "backend-ops-state-dir-env",
    file: "packages/copilot-interactive-subagents/extension/lib/backend-ops.mjs",
    from: "    parts.push(`COPILOT_SUBAGENT_STATE_DIR=${shellEscape(request.stateDir)}`);",
    to: "    parts.push(`COPILOT_SUBAGENT_OTHER_DIR=${shellEscape(request.stateDir)}`);",
  },
  {
    id: "state-metadata-version-3",
    file: "packages/copilot-interactive-subagents/extension/lib/state.mjs",
    from: "export const METADATA_VERSION = 3;",
    to: "export const METADATA_VERSION = 2;",
  },
  {
    id: "state-version-assert-code",
    file: "packages/copilot-interactive-subagents/extension/lib/state.mjs",
    from: 'error.code = "MANIFEST_VERSION_UNSUPPORTED";',
    to: 'error.code = "MANIFEST_OTHER_ERROR";',
  },
  {
    id: "state-read-version-check",
    file: "packages/copilot-interactive-subagents/extension/lib/state.mjs",
    from: '      assertSupportedMetadataVersion(parsed, { source: "manifest" });',
    to: "      void parsed;",
  },
  {
    id: "extension-tool-timeout-flag",
    file: "packages/copilot-interactive-subagents/extension/extension.mjs",
    from: "    if (!timedOut) {",
    to: "    if (timedOut) {",
  },
  {
    id: "extension-caller-ping-gate",
    file: "packages/copilot-interactive-subagents/extension/extension.mjs",
    from: '      name: "caller_ping",',
    to: '      name: "caller_xping",',
  },
  {
    id: "extension-caller-ping-type",
    file: "packages/copilot-interactive-subagents/extension/extension.mjs",
    from: "            type: \"ping\",\n            message,",
    to: "            type: \"done\",\n            message,",
  },
  {
    id: "extension-caller-ping-return-message",
    file: "packages/copilot-interactive-subagents/extension/extension.mjs",
    from: "Ping sent. Session is terminating. Do not call further tools. End your turn.",
    to: "Ping sent.",
  },
  {
    id: "extension-child-statedir-strict",
    file: "packages/copilot-interactive-subagents/extension/extension.mjs",
    from: "    error.code = \"STATE_DIR_MISSING\";\n    throw error;",
    to: "    error.code = \"STATE_DIR_MISSING\";\n    return resolveStateDir({ projectRoot: process.cwd() });",
  },
  {
    id: "resume-version-throw",
    file: "packages/copilot-interactive-subagents/extension/lib/resume.mjs",
    from: "  assertSupportedMetadataVersion(manifest, { source: \"manifest\" });",
    to: "  void manifest;",
  },
  {
    id: "resume-failed-status-typo",
    file: "packages/copilot-interactive-subagents/extension/lib/resume.mjs",
    from: '    const isTerminalStatus = manifest.status === "success" || manifest.status === "failure" || manifest.status === "timeout";',
    to: '    const isTerminalStatus = manifest.status === "success" || manifest.status === "failed" || manifest.status === "timeout";',
  },
  {
    id: "utils-active-includes-ping",
    file: "packages/copilot-interactive-subagents/extension/lib/utils.mjs",
    from: 'return status === "success" || status === "running" || status === "interactive" || status === "ping";',
    to: 'return status === "success" || status === "running" || status === "interactive";',
  },
  {
    id: "launch-summary-precedence-sidecar-wins",
    file: "packages/copilot-interactive-subagents/extension/lib/launch.mjs",
    from: '  if (completion.source === "sidecar" && completion.summary) {\n    return { summary: completion.summary, source: "sidecar" };\n  }',
    to: '  if (false && completion.source === "sidecar" && completion.summary) {\n    return { summary: completion.summary, source: "sidecar" };\n  }',
  },
  {
    id: "launch-manifest-sidecar-path-set",
    file: "packages/copilot-interactive-subagents/extension/lib/launch.mjs",
    from: '  if (completion.source === "sidecar") {\n    updates.sidecarPath = completion.sidecarPath;',
    to: '  if (completion.source === "sidecar") {\n    updates.sidecarPath = null;',
  },
  {
    id: "launch-manifest-ping-last-exit-type",
    file: "packages/copilot-interactive-subagents/extension/lib/launch.mjs",
    from: 'updates.lastExitType = completion.sidecarType === "ping" ? "ping" : "done";',
    to: 'updates.lastExitType = "done";',
  },
  {
    id: "launch-manifest-ping-history-append",
    file: "packages/copilot-interactive-subagents/extension/lib/launch.mjs",
    from: 'updates.pingHistory = [\n        ...(activeManifest.pingHistory ?? []),\n        { message: completion.message, sentAt: now() },\n      ];',
    to: 'updates.pingHistory = [{ message: completion.message, sentAt: now() }];',
  },
  {
    id: "launch-shape-ping-summary-null",
    file: "packages/copilot-interactive-subagents/extension/lib/launch.mjs",
    from: '    summary: null,\n    exitCode: 0,\n    ping: { message: completion.message },',
    to: '    summary: "",\n    exitCode: 0,\n    ping: { message: completion.message },',
  },
  {
    id: "subagent-done-gate-launch-id",
    file: "packages/copilot-interactive-subagents/extension/extension.mjs",
    from: '      name: "subagent_done",',
    to: '      name: "subagent_xdone",',
  },
  {
    id: "subagent-done-sidecar-type-done",
    file: "packages/copilot-interactive-subagents/extension/extension.mjs",
    from: '          type: "done",\n          summary: trimmed,',
    to: '          type: "ping",\n          summary: trimmed,',
  },
  {
    id: "subagent-done-summary-trim-guard",
    file: "packages/copilot-interactive-subagents/extension/extension.mjs",
    from: 'const trimmed = (typeof summary === "string" && summary.trim().length > 0) ? summary : null;',
    to: 'const trimmed = summary ?? null;',
  },
  {
    id: "subagent-done-return-message",
    file: "packages/copilot-interactive-subagents/extension/extension.mjs",
    from: '          message: "Session is terminating. Do not call further tools. End your turn.",\n        };\n      },\n    });\n  }\n\n  session = await joinSession',
    to: '          message: "Task marked complete. Session ending.",\n        };\n      },\n    });\n  }\n\n  session = await joinSession',
  },
  {
    id: "resume-d25-ping-cleanup-gate",
    file: "packages/copilot-interactive-subagents/extension/lib/resume.mjs",
    from: 'if (manifest.lastExitType === "ping") {',
    to: 'if (manifest.lastExitType === "done") {',
  },
  {
    id: "resume-d25-ping-history-respondedAt",
    file: "packages/copilot-interactive-subagents/extension/lib/resume.mjs",
    from: 'respondedAt: services.now?.() ?? new Date().toISOString(),',
    to: 'respondedAt: null,',
  },
  {
    id: "resume-d25-reset-last-exit-type",
    file: "packages/copilot-interactive-subagents/extension/lib/resume.mjs",
    from: 'pingHistory,\n        lastExitType: null,',
    to: 'pingHistory,\n        lastExitType: "ping",',
  },
  {
    id: "progress-terminal-includes-ping",
    file: "packages/copilot-interactive-subagents/extension/lib/progress.mjs",
    from: 'const TERMINAL_STATUSES = new Set(["success", "failure", "cancelled", "timeout", "ping"]);',
    to: 'const TERMINAL_STATUSES = new Set(["success", "failure", "cancelled", "timeout"]);',
  },
  {
    id: "progress-non-failure-terminal-aggregate",
    file: "packages/copilot-interactive-subagents/extension/lib/progress.mjs",
    from: 'const NON_FAILURE_TERMINAL = new Set(["success", "ping"]);',
    to: 'const NON_FAILURE_TERMINAL = new Set(["success"]);',
  },
  {
    id: "progress-snapshot-ping-count",
    file: "packages/copilot-interactive-subagents/extension/lib/progress.mjs",
    from: 'pingCount: results.filter((result) => result.status === "ping").length,',
    to: 'pingCount: 0,',
  },
  {
    id: "progress-snapshot-failure-excludes-ping",
    file: "packages/copilot-interactive-subagents/extension/lib/progress.mjs",
    from: "failureCount: results.filter((result) => !NON_FAILURE_STATUSES.has(result.status)).length,",
    to: "failureCount: results.filter((result) => NON_FAILURE_STATUSES.has(result.status)).length,",
  },
  {
    id: "extension-d41-child-filter-gate",
    file: "packages/copilot-interactive-subagents/extension/extension.mjs",
    from: "  if (process.env.COPILOT_SUBAGENT_LAUNCH_ID) {\n    // The childToolServices seam",
    to: "  if (process.env.COPILOT_SUBAGENT_SESSION_ID) {\n    // The childToolServices seam",
  },
  {
    id: "extension-d41-child-filter-applied",
    file: "packages/copilot-interactive-subagents/extension/extension.mjs",
    from: 'tools = tools.filter((tool) => !PUBLIC_SPAWNING_TOOL_NAMES.has(tool.name));',
    to: '/* filter disabled */;',
  },
];

export const RESUME_TARGETED_MUTANTS = [
  {
    id: "resume-workspace-priority",
    file: "packages/copilot-interactive-subagents/extension/lib/resume.mjs",
    from: '      lookupSource: "workspace",',
    to: '      lookupSource: "index",',
  },
  {
    id: "resume-unsupported-code",
    file: "packages/copilot-interactive-subagents/extension/lib/resume.mjs",
    from: '      code: "RESUME_UNSUPPORTED",',
    to: '      code: "RESUME_TARGET_INVALID",',
  },
  {
    id: "resume-missing-fields-check",
    file: "packages/copilot-interactive-subagents/extension/lib/resume.mjs",
    from: '  if (!manifest.backend || !manifest.agentIdentifier || !manifest.paneId) {',
    to: '  if (false) {',
  },
  {
    id: "resume-session-active-code",
    file: "packages/copilot-interactive-subagents/extension/lib/resume.mjs",
    from: '      return shapeResumeFailure({ code: "SESSION_ACTIVE", message: err.message, manifest, request });',
    to: '      return shapeResumeFailure({ code: "RESUME_TARGET_INVALID", message: err.message, manifest, request });',
  },
  {
    id: "resume-running-ok",
    file: "packages/copilot-interactive-subagents/extension/lib/resume.mjs",
    from: '    ok: manifest.status === "running" || manifest.status === "success" || manifest.status === "interactive",',
    to: '    ok: manifest.status === "success",',
  },
  {
    id: "state-index-lookup-entry",
    file: "packages/copilot-interactive-subagents/extension/lib/state-index.mjs",
    from: "      return index.entries[launchId] ?? null;",
    to: "      return null;",
  },
];

export const TARGETED_MUTANTS = [...DEFAULT_TARGETED_MUTANTS];

const QUALITY_TARGET_SCOPES = {
  default: {
    testPattern: "test/*.test.mjs test/unit/*.test.mjs",
    crapTargets: DETERMINISTIC_LOGIC_TARGETS,
    mutationTargets: TARGETED_MUTANTS,
  },
  resume: {
    testPattern: "test/resume.test.mjs",
    crapTargets: RESUME_DETERMINISTIC_LOGIC_TARGETS,
    mutationTargets: RESUME_TARGETED_MUTANTS,
  },
};

export function resolveQualityTargetSet(scope = "default") {
  const targetSet = QUALITY_TARGET_SCOPES[scope];
  if (!targetSet) {
    throw new Error(`Unknown quality target scope: ${scope}`);
  }

  return {
    testPattern: targetSet.testPattern,
    crapTargets: [...targetSet.crapTargets],
    mutationTargets: targetSet.mutationTargets.map((mutant) => ({ ...mutant })),
  };
}
