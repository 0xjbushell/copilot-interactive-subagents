/**
 * Parent→child message delivery via mux send-keys/write-chars with
 * bracketed-paste wrapping. Pure orchestration — all I/O injected via services.
 */

const MAX_MESSAGE_BYTES = 65536; // 64 KiB
const BRACKET_OPEN = "\x1b[200~";
const BRACKET_CLOSE = "\x1b[201~";

export async function sendMessage({ launchId, message, services = {} } = {}) {
  const {
    readLaunchRecord,
    probeBackendAvailable,
    probeSessionLiveness,
    runBackendSendKeys,
  } = services;

  // 1. Validate message
  if (typeof message !== "string" || message.trim().length === 0 || message.length > MAX_MESSAGE_BYTES) {
    return { ok: false, error: "INVALID_MESSAGE" };
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

  // 3. Probe backend available
  const backendOk = await probeBackendAvailable(manifest.backend);
  if (!backendOk) {
    return { ok: false, error: "BACKEND_UNAVAILABLE" };
  }

  // 4. Probe session liveness
  const alive = probeSessionLiveness({ backend: manifest.backend, paneId: manifest.paneId });
  if (!alive) {
    return { ok: false, error: "PANE_DEAD" };
  }

  // 5. Wrap in bracketed paste
  const wrapped = `${BRACKET_OPEN}${message}${BRACKET_CLOSE}`;

  // 6. Send via backend
  await runBackendSendKeys({
    backend: manifest.backend,
    paneId: manifest.paneId,
    payload: wrapped,
  });

  // 7. Return success
  return { ok: true, delivered: true, paneId: manifest.paneId, reply: null };
}
