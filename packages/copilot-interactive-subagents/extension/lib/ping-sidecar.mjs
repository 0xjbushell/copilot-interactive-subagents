import {
  openSync as defaultOpenSync,
  writeSync as defaultWriteSync,
  readSync as defaultReadSync,
  closeSync as defaultCloseSync,
  mkdirSync as defaultMkdirSync,
  statSync as defaultStatSync,
  constants,
} from "node:fs";
import path from "node:path";

export const PING_SIDECAR_DIRNAME = "pings";
const PING_VERSION = 1;

function resolvePingsPath(stateDir, launchId) {
  return path.join(stateDir, PING_SIDECAR_DIRNAME, `${launchId}.jsonl`);
}

export function appendPing({ stateDir, launchId, message, services = {} } = {}) {
  const mkdirSync = services.mkdirSync ?? defaultMkdirSync;
  const openSync = services.openSync ?? defaultOpenSync;
  const writeSync = services.writeSync ?? defaultWriteSync;
  const closeSync = services.closeSync ?? defaultCloseSync;
  const statSync = services.statSync ?? defaultStatSync;
  const now = services.now ?? (() => new Date().toISOString());

  const pingsDir = path.join(stateDir, PING_SIDECAR_DIRNAME);
  mkdirSync(pingsDir, { recursive: true });

  const writtenAt = now();
  const record = {
    version: PING_VERSION,
    type: "message",
    launchId,
    message,
    writtenAt,
  };

  const line = `${JSON.stringify(record)}\n`;
  const filePath = resolvePingsPath(stateDir, launchId);

  const fd = openSync(filePath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT);
  try {
    writeSync(fd, line);
  } finally {
    closeSync(fd);
  }

  const cursor = statSync(filePath).size;
  return { writtenAt, cursor };
}

function readSlice(filePath, offset, length, services) {
  const openSync = services.openSync ?? defaultOpenSync;
  const readSync = services.readSync ?? defaultReadSync;
  const closeSync = services.closeSync ?? defaultCloseSync;

  const fd = openSync(filePath, constants.O_RDONLY);
  try {
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, offset);
    return buf;
  } finally {
    closeSync(fd);
  }
}

function parseLines(raw, sinceCursor, warn) {
  const lines = raw.split("\n");
  const records = [];
  let bytesConsumed = 0;
  let hasMore = false;

  for (const line of lines) {
    if (line.length === 0) continue;

    const lineBytes = Buffer.byteLength(line, "utf8") + 1;

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      hasMore = true;
      break;
    }

    if (parsed.version > PING_VERSION) {
      warn(`ping-sidecar: skipping record with version ${parsed.version} (expected ${PING_VERSION})`);
      bytesConsumed += lineBytes;
      continue;
    }

    const recordCursor = sinceCursor + bytesConsumed + lineBytes;
    records.push({ type: parsed.type, message: parsed.message, writtenAt: parsed.writtenAt, cursor: recordCursor });
    bytesConsumed += lineBytes;
  }

  if (!raw.endsWith("\n") && !hasMore) {
    hasMore = true;
  }

  return { records, bytesConsumed, hasMore };
}

export function readPingsSince({ stateDir, launchId, sinceCursor = 0, services = {} } = {}) {
  const statSync = services.statSync ?? defaultStatSync;
  const warn = services.warn ?? console.warn;
  const filePath = resolvePingsPath(stateDir, launchId);

  let fileSize;
  try {
    fileSize = statSync(filePath).size;
  } catch (err) {
    if (err?.code === "ENOENT") return { records: [], nextCursor: 0, hasMore: false };
    throw err;
  }

  if (sinceCursor >= fileSize) {
    return { records: [], nextCursor: sinceCursor, hasMore: false };
  }

  const buf = readSlice(filePath, sinceCursor, fileSize - sinceCursor, services);
  const { records, bytesConsumed, hasMore } = parseLines(buf.toString("utf8"), sinceCursor, warn);

  return { records, nextCursor: sinceCursor + bytesConsumed, hasMore };
}
