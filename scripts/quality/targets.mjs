const DEFAULT_DETERMINISTIC_LOGIC_TARGETS = [
  ".github/extensions/copilot-interactive-subagents/lib/agents.mjs",
  ".github/extensions/copilot-interactive-subagents/lib/close-pane.mjs",
  ".github/extensions/copilot-interactive-subagents/lib/fork-session.mjs",
  ".github/extensions/copilot-interactive-subagents/lib/launch.mjs",
  ".github/extensions/copilot-interactive-subagents/lib/mux-layout.mjs",
  ".github/extensions/copilot-interactive-subagents/lib/mux.mjs",
  ".github/extensions/copilot-interactive-subagents/lib/parallel.mjs",
  ".github/extensions/copilot-interactive-subagents/lib/progress.mjs",
  ".github/extensions/copilot-interactive-subagents/lib/session-lock.mjs",
  ".github/extensions/copilot-interactive-subagents/lib/state.mjs",
  ".github/extensions/copilot-interactive-subagents/lib/summary.mjs",
  ".github/extensions/copilot-interactive-subagents/lib/titles.mjs",
  ".github/extensions/copilot-interactive-subagents/extension.mjs",
];

export const RESUME_DETERMINISTIC_LOGIC_TARGETS = [
  ".github/extensions/copilot-interactive-subagents/lib/resume.mjs",
  ".github/extensions/copilot-interactive-subagents/lib/state-index.mjs",
];

export const DETERMINISTIC_LOGIC_TARGETS = [...DEFAULT_DETERMINISTIC_LOGIC_TARGETS];

const DEFAULT_TARGETED_MUTANTS = [
  {
    id: "agents-exact-name-only",
    file: ".github/extensions/copilot-interactive-subagents/lib/agents.mjs",
    from: "exactNameOnly: true,",
    to: "exactNameOnly: false,",
  },
  {
    id: "agents-custom-kind",
    file: ".github/extensions/copilot-interactive-subagents/lib/agents.mjs",
    from: 'agentKind: "custom",',
    to: 'agentKind: "built-in",',
  },
  {
    id: "agents-not-found-code",
    file: ".github/extensions/copilot-interactive-subagents/lib/agents.mjs",
    from: 'code: "AGENT_NOT_FOUND",',
    to: 'code: "AGENT_VALIDATION_UNAVAILABLE",',
  },
  {
    id: "agents-available-identifiers",
    file: ".github/extensions/copilot-interactive-subagents/lib/agents.mjs",
    from: "availableIdentifiers: [...customIdentifiers, ...acceptedBuiltIns],",
    to: "availableIdentifiers: acceptedBuiltIns,",
  },
  {
    id: "mux-attached-source",
    file: ".github/extensions/copilot-interactive-subagents/lib/mux.mjs",
    from: 'source: "attached",',
    to: 'source: "startable",',
  },
  {
    id: "mux-manual-setup",
    file: ".github/extensions/copilot-interactive-subagents/lib/mux.mjs",
    from: "manualSetupRequired: false,",
    to: "manualSetupRequired: true,",
  },
  {
    id: "mux-start-unsupported-code",
    file: ".github/extensions/copilot-interactive-subagents/lib/mux.mjs",
    from: 'code: "BACKEND_START_UNSUPPORTED",',
    to: 'code: "BACKEND_UNAVAILABLE",',
  },
  {
    id: "mux-tmux-detection",
    file: ".github/extensions/copilot-interactive-subagents/lib/mux.mjs",
    from: "return Boolean(env.TMUX);",
    to: "return false;",
  },
  {
    id: "extension-agent-list",
    file: ".github/extensions/copilot-interactive-subagents/extension.mjs",
    from: "agentIdentifiers: agentResult.runtimeRecognizedIdentifiers,",
    to: "agentIdentifiers: [],",
  },
  {
    id: "extension-builtin-list",
    file: ".github/extensions/copilot-interactive-subagents/extension.mjs",
    from: "builtInIdentifiersAcceptedExplicitly: agentResult.builtInIdentifiersAcceptedExplicitly,",
    to: "builtInIdentifiersAcceptedExplicitly: [],",
  },
  {
    id: "extension-normalize-request",
    file: ".github/extensions/copilot-interactive-subagents/extension.mjs",
    from: "normalizeNonEmptyString(request.agentIdentifier);",
    to: "null;",
  },
  {
    id: "extension-launch-argument-validation",
    file: ".github/extensions/copilot-interactive-subagents/extension.mjs",
    from: '      field: `${prefix}agentIdentifier`,',
    to: '      field: `${prefix}task`,',
  },
  {
    id: "extension-parallel-backend-conflict",
    file: ".github/extensions/copilot-interactive-subagents/extension.mjs",
    from: "  if (uniqueBackends.length > 1) {",
    to: "  if (uniqueBackends.length > 2) {",
  },
  {
    id: "titles-unsupported-backend",
    file: ".github/extensions/copilot-interactive-subagents/lib/titles.mjs",
    from: '      code: "TITLE_UNSUPPORTED",',
    to: '      code: "TITLE_TARGET_INVALID",',
  },
  {
    id: "launch-action-mapping",
    file: ".github/extensions/copilot-interactive-subagents/lib/launch.mjs",
    from: `agentIdentifier: agentValidation.identifier,
    agentKind: agentValidation.agentKind,`,
    to: `agentIdentifier: undefined,
    agentKind: agentValidation.agentKind,`,
  },
  {
    id: "launch-await-completion-default",
    file: ".github/extensions/copilot-interactive-subagents/lib/launch.mjs",
    from: "awaitCompletion: request.awaitCompletion ?? (interactive ? false : true),",
    to: "awaitCompletion: false,",
  },
  {
    id: "mux-layout-tiled-strategy",
    file: ".github/extensions/copilot-interactive-subagents/lib/mux-layout.mjs",
    from: '  return "tiled";',
    to: '  return "split";',
  },
  {
    id: "parallel-layout-forwarding",
    file: ".github/extensions/copilot-interactive-subagents/lib/parallel.mjs",
    from: "        layout: entry.layout,",
    to: "        layout: undefined,",
  },
  {
    id: "parallel-launch-await",
    file: ".github/extensions/copilot-interactive-subagents/lib/parallel.mjs",
    from: "  return controller.completionPromise;",
    to: "  return controller.getProgress();",
  },
  {
    id: "progress-running-priority",
    file: ".github/extensions/copilot-interactive-subagents/lib/progress.mjs",
    from: '    return "running";',
    to: '    return "failure";',
  },
  {
    id: "progress-partial-success",
    file: ".github/extensions/copilot-interactive-subagents/lib/progress.mjs",
    from: '    return "partial-success";',
    to: '    return "failure";',
  },
  {
    id: "progress-request-order",
    file: ".github/extensions/copilot-interactive-subagents/lib/progress.mjs",
    from: "    const results = orderedLaunchIds.map((launchId) => cloneRecord(records.get(launchId)));",
    to: "    const results = [...orderedLaunchIds].reverse().map((launchId) => cloneRecord(records.get(launchId)));",
  },
  {
    id: "state-metadata-version",
    file: ".github/extensions/copilot-interactive-subagents/lib/state.mjs",
    from: "metadataVersion = METADATA_VERSION,",
    to: "metadataVersion = 0,",
  },
  {
    id: "state-running-status",
    file: ".github/extensions/copilot-interactive-subagents/lib/launch.mjs",
    from: 'const activeStatus = plan.interactive ? "interactive" : "running";',
    to: 'const activeStatus = "pending";',
  },
  {
    id: "summary-explicit-priority",
    file: ".github/extensions/copilot-interactive-subagents/lib/summary.mjs",
    from: 'source: "explicit-summary",',
    to: 'source: "assistant-message",',
  },
  {
    id: "summary-exit-mapping",
    file: ".github/extensions/copilot-interactive-subagents/lib/summary.mjs",
    from: 'return "success";',
    to: 'return "failure";',
  },
  {
    id: "mux-backend-preference",
    file: ".github/extensions/copilot-interactive-subagents/lib/mux.mjs",
    from: 'export const SUPPORTED_BACKENDS = ["cmux", "zellij", "tmux"];',
    to: 'export const SUPPORTED_BACKENDS = ["cmux", "tmux", "zellij"];',
  },
];

export const RESUME_TARGETED_MUTANTS = [
  {
    id: "resume-workspace-priority",
    file: ".github/extensions/copilot-interactive-subagents/lib/resume.mjs",
    from: '      lookupSource: "workspace",',
    to: '      lookupSource: "index",',
  },
  {
    id: "resume-unsupported-code",
    file: ".github/extensions/copilot-interactive-subagents/lib/resume.mjs",
    from: '      code: "RESUME_UNSUPPORTED",',
    to: '      code: "RESUME_TARGET_INVALID",',
  },
  {
    id: "resume-missing-fields-check",
    file: ".github/extensions/copilot-interactive-subagents/lib/resume.mjs",
    from: '  if (!manifest.backend || !manifest.agentIdentifier || !manifest.paneId) {',
    to: '  if (false) {',
  },
  {
    id: "resume-session-active-code",
    file: ".github/extensions/copilot-interactive-subagents/lib/resume.mjs",
    from: '      return shapeResumeFailure({ code: "SESSION_ACTIVE", message: err.message, manifest, request });',
    to: '      return shapeResumeFailure({ code: "RESUME_TARGET_INVALID", message: err.message, manifest, request });',
  },
  {
    id: "resume-running-ok",
    file: ".github/extensions/copilot-interactive-subagents/lib/resume.mjs",
    from: '    ok: manifest.status === "running" || manifest.status === "success" || manifest.status === "interactive",',
    to: '    ok: manifest.status === "success",',
  },
  {
    id: "state-index-lookup-entry",
    file: ".github/extensions/copilot-interactive-subagents/lib/state-index.mjs",
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
