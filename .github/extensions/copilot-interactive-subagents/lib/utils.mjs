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
