import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { METADATA_VERSION, createLaunchRecord } from "./state.mjs";
import { normalizeOptionalText } from "./utils.mjs";

export const STATE_INDEX_VERSION = 1;

const DEFAULT_INDEX_PATH = path.join(".copilot-interactive-subagents", "launch-index.json");

function resolveIndexPath({ projectRoot = process.cwd(), indexPath = DEFAULT_INDEX_PATH } = {}) {
  return path.resolve(projectRoot, indexPath);
}

function createEmptyIndex() {
  return {
    indexVersion: STATE_INDEX_VERSION,
    entries: {},
  };
}

function normalizeReference(reference) {
  if (!reference) {
    return null;
  }

  if (typeof reference === "string") {
    return reference;
  }

  return normalizeOptionalText(reference.launchId);
}

export function createLaunchIndexEntry(entry = {}) {
  const manifest = createLaunchRecord({
    ...entry,
    metadataVersion: entry.metadataVersion ?? METADATA_VERSION,
  });

  return {
    ...manifest,
    manifestPath: normalizeOptionalText(entry.manifestPath)
      ? path.resolve(entry.manifestPath)
      : null,
    indexVersion: STATE_INDEX_VERSION,
  };
}

async function readIndexFile(indexPath) {
  try {
    const contents = await readFile(indexPath, "utf8");
    const parsed = JSON.parse(contents);

    return {
      indexVersion: parsed.indexVersion ?? STATE_INDEX_VERSION,
      entries: Object.fromEntries(
        Object.entries(parsed.entries ?? {}).map(([launchId, entry]) => [
          launchId,
          createLaunchIndexEntry(entry),
        ]),
      ),
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return createEmptyIndex();
    }

    throw error;
  }
}

async function writeIndexFile(indexPath, index) {
  await mkdir(path.dirname(indexPath), { recursive: true });
  await writeFile(`${indexPath}.tmp`, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

export function createStateIndex(options = {}) {
  const resolvedIndexPath = resolveIndexPath(options);

  return {
    indexPath: resolvedIndexPath,
    async readLaunchIndex() {
      return readIndexFile(resolvedIndexPath);
    },
    async writeLaunchIndexEntry(entry) {
      const index = await readIndexFile(resolvedIndexPath);
      const normalized = createLaunchIndexEntry(entry);
      const updatedIndex = {
        indexVersion: STATE_INDEX_VERSION,
        entries: {
          ...index.entries,
          [normalized.launchId]: normalized,
        },
      };
      await writeIndexFile(resolvedIndexPath, updatedIndex);
      return normalized;
    },
    async lookupLaunch(reference) {
      const launchId = normalizeReference(reference);
      if (!launchId) {
        return null;
      }

      const index = await readIndexFile(resolvedIndexPath);
      return index.entries[launchId] ?? null;
    },
  };
}
