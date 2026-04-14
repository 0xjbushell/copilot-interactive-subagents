/**
 * Request normalization and validation for all public tool endpoints.
 *
 * Each tool has a normalize* function (coerce/merge fields) and a validate*
 * function (reject invalid shapes). Handlers call normalize then validate.
 */

import { normalizeNonEmptyString, uniqueStable } from "./utils.mjs";
import { isValidLaunchId } from "./state.mjs";

export function createArgumentFailure({
  field,
  message,
  guidance,
  code = "INVALID_ARGUMENT",
  ...extras
}) {
  return {
    ok: false,
    code,
    message,
    field,
    guidance,
    ...extras,
  };
}

const AGENT_VALIDATION_GUIDANCE = {
  AGENT_NOT_FOUND:
    "Provide the exact runtime-recognized agent identifier. Use copilot_subagent_list_agents to discover valid names.",
  AGENT_VALIDATION_UNAVAILABLE:
    "Retry agent discovery or target an explicitly allowed built-in identifier if your workflow already knows it.",
  AGENT_DISCOVERY_UNAVAILABLE:
    "Agent discovery is temporarily unavailable. Retry discovery or target an explicitly allowed built-in identifier.",
};

export function addAgentValidationGuidance(result = {}, field) {
  if (result.ok !== false) {
    return result;
  }

  const guidance = AGENT_VALIDATION_GUIDANCE[result.code];
  if (guidance) {
    return { ...result, ...(field ? { field } : {}), guidance };
  }

  return result;
}

export function normalizeLaunchRequest(request = {}) {
  const requestedIdentifier =
    normalizeNonEmptyString(request.requestedIdentifier) ?? normalizeNonEmptyString(request.agentIdentifier);
  const requestedBackend =
    normalizeNonEmptyString(request.requestedBackend) ?? normalizeNonEmptyString(request.backend);

  return {
    ...request,
    ...(requestedIdentifier ? { requestedIdentifier } : {}),
    ...(requestedBackend ? { requestedBackend } : {}),
  };
}

export function validateLaunchRequest(request = {}, { fieldPrefix = "" } = {}) {
  const prefix = fieldPrefix ? `${fieldPrefix}.` : "";

  if (!normalizeNonEmptyString(request.requestedIdentifier)) {
    return createArgumentFailure({
      field: `${prefix}agentIdentifier`,
      message: "agentIdentifier must be a non-empty string.",
      guidance:
        "Provide the exact runtime-recognized agent identifier. Use copilot_subagent_list_agents to discover valid names.",
    });
  }

  if (!normalizeNonEmptyString(request.task)) {
    return createArgumentFailure({
      field: `${prefix}task`,
      message: "task must be a non-empty string.",
      guidance: "Provide the task text that should be sent to the target agent.",
    });
  }

  return null;
}

export function normalizeParallelRequest(request = {}) {
  if (!Array.isArray(request.launches) || request.launches.length === 0) {
    return createArgumentFailure({
      field: "launches",
      message: "launches must be a non-empty array.",
      guidance: "Provide at least one { agentIdentifier, task } entry.",
    });
  }

  const normalizedLaunches = [];
  const requestedBackends = [];

  for (const [index, launch] of request.launches.entries()) {
    const normalizedEntry = normalizeLaunchRequest({
      ...launch,
      awaitCompletion: launch?.awaitCompletion ?? request.awaitCompletion,
      requestedBackend:
        launch?.requestedBackend ?? launch?.backend ?? request.requestedBackend ?? request.backend,
    });

    const validationFailure = validateLaunchRequest(normalizedEntry, {
      fieldPrefix: `launches[${index}]`,
    });
    if (validationFailure) {
      return validationFailure;
    }

    if (normalizedEntry.requestedBackend) {
      requestedBackends.push(normalizedEntry.requestedBackend);
    }

    normalizedLaunches.push({ request: normalizedEntry });
  }

  const uniqueBackends = uniqueStable(requestedBackends);
  if (uniqueBackends.length > 1) {
    return createArgumentFailure({
      code: "PARALLEL_BACKEND_CONFLICT",
      field: "launches",
      message: "Parallel launches must target the same backend when a backend is specified.",
      guidance:
        "Use one backend for the whole batch or omit backend so the extension resolves one shared backend.",
      requestedBackends: uniqueBackends,
    });
  }

  return {
    request: normalizeLaunchRequest({
      ...request,
      ...(uniqueBackends[0] ? { requestedBackend: uniqueBackends[0] } : {}),
    }),
    launches: normalizedLaunches,
  };
}

export function normalizeResumeRequest(request = {}) {
  const launchId =
    normalizeNonEmptyString(request.launchId)
    ?? normalizeNonEmptyString(request.resumeReference)
    ?? normalizeNonEmptyString(request.resumeReference?.launchId)
    ?? normalizeNonEmptyString(request.resumePointer?.launchId);

  return {
    ...request,
    ...(launchId ? { launchId } : {}),
  };
}

export function validateResumeRequest(request = {}) {
  if (!request.launchId) {
    return createArgumentFailure({
      field: "launchId",
      message: "launchId or a stored resume reference is required.",
      guidance: "Pass launchId directly or provide resumeReference/resumePointer with launchId.",
    });
  }

  if (!isValidLaunchId(request.launchId)) {
    return createArgumentFailure({
      field: "launchId",
      message: "launchId must use only letters, numbers, periods, underscores, and hyphens.",
      guidance: "Use the launchId returned by a prior launch or resume response.",
    });
  }

  return null;
}

export function normalizeSetTitleRequest(request = {}) {
  const backend =
    normalizeNonEmptyString(request.backend)
    ?? normalizeNonEmptyString(request.requestedBackend)
    ?? normalizeNonEmptyString(request.resumePointer?.backend);
  const paneId =
    normalizeNonEmptyString(request.paneId)
    ?? normalizeNonEmptyString(request.resumePointer?.paneId);
  const title = normalizeNonEmptyString(request.title);

  return {
    ...request,
    ...(backend ? { backend, requestedBackend: backend } : {}),
    ...(paneId ? { paneId } : {}),
    ...(title ? { title } : {}),
  };
}

export function validateSetTitleRequest(request = {}) {
  if (!normalizeNonEmptyString(request.title)) {
    return createArgumentFailure({
      field: "title",
      message: "title must be a non-empty string.",
      guidance: "Provide the human-readable phase or title to show in the pane.",
    });
  }

  if (!normalizeNonEmptyString(request.backend)) {
    return createArgumentFailure({
      field: "backend",
      message: "backend must be provided directly or via resumePointer.backend.",
      guidance: "Pass the backend that owns the target pane.",
    });
  }

  if (!normalizeNonEmptyString(request.paneId)) {
    return createArgumentFailure({
      field: "paneId",
      message: "paneId must be provided directly or via resumePointer.paneId.",
      guidance: "Pass the pane identifier returned from launch or resume.",
    });
  }

  return null;
}
