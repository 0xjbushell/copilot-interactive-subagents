/**
 * Shared utility functions used across multiple extension modules.
 *
 * normalizeNonEmptyString: returns trimmed string or null (non-strings → null)
 * normalizeOptionalText:   returns trimmed string or null (non-strings → value ?? null)
 */

export function normalizeNonEmptyString(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeOptionalText(value) {
  if (typeof value !== "string") {
    return value ?? null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function uniqueStable(values = []) {
  return [...new Set(values.filter(Boolean))];
}

export function uniqueSorted(values = []) {
  return [...new Set(values.filter(Boolean))].sort();
}

/** Returns true for launch/resume statuses that indicate a non-failed outcome. */
export function isActiveOrSuccessful(status) {
  return status === "success" || status === "running" || status === "interactive";
}

/** Strips the "pane:" prefix from a zellij pane identifier (e.g. "pane:5" → "5"). */
export function stripPanePrefix(paneId) {
  return String(paneId).startsWith("pane:") ? String(paneId).slice("pane:".length) : String(paneId);
}
