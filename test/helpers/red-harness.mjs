import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HELPERS_DIR = dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = resolve(HELPERS_DIR, "..", "..");

function createMissingExport(relativePath, exportName) {
  return async () => {
    assert.fail(
      `Missing implementation: ${relativePath} must export ${exportName}() for these RED tests.`,
    );
  };
}

export async function importProjectModule(relativePath, expectedExports) {
  const absolutePath = resolve(PROJECT_ROOT, relativePath);

  try {
    const module = await import(pathToFileURL(absolutePath).href);

    for (const exportName of expectedExports) {
      assert.ok(
        exportName in module,
        `Expected ${relativePath} to export ${exportName}.`,
      );
    }

    return module;
  } catch (error) {
    if (
      error?.code === "ERR_MODULE_NOT_FOUND" &&
      String(error.message).includes(absolutePath)
    ) {
      return Object.fromEntries(
        expectedExports.map((exportName) => [
          exportName,
          createMissingExport(relativePath, exportName),
        ]),
      );
    }

    throw error;
  }
}
