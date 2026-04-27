/**
 * Parent→child message delivery via mux send-keys/write-chars with
 * bracketed-paste wrapping. Pure orchestration — all I/O injected via services.
 */

const MAX_MESSAGE_BYTES = 65536; // 64 KiB
const BRACKET_OPEN = "\x1b[200~";
const BRACKET_CLOSE = "\x1b[201~";

const DEFAULT_AWAIT_REPLY_TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 100;

function validateMessage(message) {
  return typeof message === "string" && message.trim().length > 0 && message.length <= MAX_MESSAGE_BYTES;
}

async function pollForReply({ launchId, manifest, sendStartedCursor, awaitReplyTimeoutMs, services }) {
  const { readPingsSince, updateLaunchRecord, probeSessionLiveness, stateDir, now, sleep } = services;

  const deadline = now() + awaitReplyTimeoutMs;
  while (now() < deadline) {
    const { records } = readPingsSince({ stateDir, launchId, sinceCursor: sendStartedCursor });
    if (records.length > 0) {
      const firstReply = records[0];
      await updateLaunchRecord(launchId, { messageCursor: firstReply.cursor });
      return { ok: true, delivered: true, paneId: manifest.paneId, reply: { message: firstReply.message, writtenAt: firstReply.writtenAt, cursor: firstReply.cursor } };
    }

    const stillAlive = probeSessionLiveness({ backend: manifest.backend, paneId: manifest.paneId });
    if (!stillAlive) {
      return { ok: false, error: "PANE_DEAD", delivered: true, paneId: manifest.paneId };
    }

    await sleep(POLL_INTERVAL_MS);
  }

  return { ok: false, error: "AWAIT_REPLY_TIMEOUT", delivered: true, paneId: manifest.paneId };
}

export async function sendMessage({ launchId, message, awaitReply = false, awaitReplyTimeoutMs = DEFAULT_AWAIT_REPLY_TIMEOUT_MS, services = {} } = {}) {
  const {
    readLaunchRecord,
    probeBackendAvailable,
    probeSessionLiveness,
    runBackendSendKeys,
    getPingsFileSize,
  } = services;

  if (!validateMessage(message)) {
    return { ok: false, error: "INVALID_MESSAGE" };
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

  const backendOk = await probeBackendAvailable(manifest.backend);
  if (!backendOk) {
    return { ok: false, error: "BACKEND_UNAVAILABLE" };
  }

  const alive = probeSessionLiveness({ backend: manifest.backend, paneId: manifest.paneId });
  if (!alive) {
    return { ok: false, error: "PANE_DEAD" };
  }

  // Capture cursor BEFORE send so we only see replies that arrive after our message
  const sendStartedCursor = awaitReply ? getPingsFileSize(launchId) : 0;

  // Bracketed paste prevents the mux from interpreting control sequences in the message
  const wrapped = `${BRACKET_OPEN}${message}${BRACKET_CLOSE}`;

  await runBackendSendKeys({
    backend: manifest.backend,
    paneId: manifest.paneId,
    payload: wrapped,
  });

  if (!awaitReply) {
    return { ok: true, delivered: true, paneId: manifest.paneId, reply: null };
  }

  return pollForReply({ launchId, manifest, sendStartedCursor, awaitReplyTimeoutMs, services });
}
