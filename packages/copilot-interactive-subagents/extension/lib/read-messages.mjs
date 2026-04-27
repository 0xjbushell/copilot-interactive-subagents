/**
 * Parent-side orchestration for reading child→parent messages.
 * Pure logic — all I/O injected via services.
 */

export async function readMessages({ launchId, sinceCursor, services = {} } = {}) {
  const { readLaunchRecord, updateLaunchRecord, readPingsSince, stateDir } = services;

  if (sinceCursor !== undefined && sinceCursor !== null) {
    if (!Number.isInteger(sinceCursor) || sinceCursor < 0) {
      return { ok: false, error: "INVALID_CURSOR" };
    }
  }

  let manifest;
  try {
    manifest = await readLaunchRecord(launchId);
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "LAUNCH_NOT_FOUND") {
      return { ok: false, error: "LAUNCH_NOT_FOUND" };
    }
    throw err;
  }

  const effectiveCursor = sinceCursor ?? manifest.messageCursor ?? 0;

  let result;
  try {
    result = readPingsSince({ stateDir, launchId, sinceCursor: effectiveCursor });
  } catch (err) {
    return { ok: false, error: "SIDECAR_READ_FAILED", message: err?.message ?? String(err) };
  }

  await updateLaunchRecord(launchId, { messageCursor: result.nextCursor });

  return {
    ok: true,
    messages: result.records,
    nextCursor: result.nextCursor,
    hasMore: result.hasMore,
  };
}
