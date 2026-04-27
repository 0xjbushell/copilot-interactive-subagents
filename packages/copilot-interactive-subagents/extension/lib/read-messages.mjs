/**
 * Parent-side orchestration for reading child→parent messages.
 * Pure logic — all I/O injected via services.
 */

export async function readMessages({ launchId, sinceCursor, services = {} } = {}) {
  const { readLaunchRecord, updateLaunchRecord, readPingsSince, stateDir } = services;

  // 1. Validate sinceCursor when explicitly provided
  if (sinceCursor !== undefined && sinceCursor !== null) {
    if (!Number.isInteger(sinceCursor) || sinceCursor < 0) {
      return { ok: false, error: "INVALID_CURSOR" };
    }
  }

  // 2. Read manifest
  let manifest;
  try {
    manifest = await readLaunchRecord(launchId);
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "LAUNCH_NOT_FOUND") {
      return { ok: false, error: "LAUNCH_NOT_FOUND" };
    }
    throw err;
  }

  if (!manifest) {
    return { ok: false, error: "LAUNCH_NOT_FOUND" };
  }

  // 3. Determine effective cursor
  const effectiveCursor = sinceCursor ?? manifest.messageCursor ?? 0;

  // 4. Read pings
  const result = readPingsSince({ stateDir, launchId, sinceCursor: effectiveCursor });

  // 5. Persist cursor unconditionally on success
  await updateLaunchRecord(launchId, { messageCursor: result.nextCursor });

  // 6. Return
  return {
    ok: true,
    messages: result.records,
    nextCursor: result.nextCursor,
    hasMore: result.hasMore,
  };
}
