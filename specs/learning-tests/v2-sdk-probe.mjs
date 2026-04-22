import { appendFileSync, mkdirSync } from "node:fs";
import { joinSession } from "@github/copilot-sdk/extension";

const LOG_FILE = "/tmp/v2-sdk-probe.log";
const PID = process.pid;

mkdirSync("/tmp", { recursive: true });

function log(tag, payload) {
  const record = {
    t: new Date().toISOString(),
    pid: PID,
    tag,
    payload,
  };
  try {
    appendFileSync(LOG_FILE, JSON.stringify(record) + "\n");
  } catch {
    /* swallow */
  }
}

log("extension.load", { cwd: process.cwd(), argv: process.argv });

let session;
let tickCount = 0;
let intervalHandle = null;
const scheduledSends = [];

function startHeartbeat() {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    tickCount += 1;
    log("heartbeat", { tick: tickCount, scheduled: scheduledSends.length });

    const now = Date.now();
    for (let i = scheduledSends.length - 1; i >= 0; i -= 1) {
      const entry = scheduledSends[i];
      if (now >= entry.fireAt) {
        scheduledSends.splice(i, 1);
        const prompt = entry.message;
        log("sending", { label: entry.label, prompt, mode: entry.mode });
        session
          .send({ prompt, mode: entry.mode })
          .then((messageId) => {
            log("send.resolved", { label: entry.label, messageId });
          })
          .catch((err) => {
            log("send.error", { label: entry.label, error: String(err) });
          });
      }
    }
  }, 2000);
  log("heartbeat.started", {});
}

session = await joinSession({
  tools: [
    {
      name: "probe_start_async",
      description:
        "Start a background setInterval, log heartbeats, and after delaySec call session.send({mode}) with the message. Returns immediately.",
      parameters: {
        type: "object",
        properties: {
          delaySec: { type: "number", description: "Seconds before session.send fires" },
          message: { type: "string", description: "Prompt to inject" },
          mode: {
            type: "string",
            enum: ["enqueue", "immediate"],
            description: "session.send mode",
          },
          label: { type: "string", description: "Free-form label for the log" },
        },
        required: ["delaySec", "message"],
      },
      handler: async (args, invocation) => {
        startHeartbeat();
        const fireAt = Date.now() + args.delaySec * 1000;
        scheduledSends.push({
          label: args.label ?? "unlabeled",
          message: args.message,
          mode: args.mode ?? "enqueue",
          fireAt,
        });
        log("probe_start_async.scheduled", {
          args,
          fireAt,
          toolCallId: invocation.toolCallId,
        });
        return `Scheduled send "${args.label ?? "unlabeled"}" for ${args.delaySec}s from now (mode=${args.mode ?? "enqueue"}).`;
      },
    },
    {
      name: "probe_dump_state",
      description: "Return current heartbeat tick count and pending sends.",
      parameters: { type: "object", properties: {} },
      handler: async () => {
        log("probe_dump_state.called", { tickCount, scheduled: scheduledSends });
        return JSON.stringify({ tickCount, scheduledSends, pid: PID });
      },
    },
    {
      name: "probe_echo",
      description: "Simple echo tool to confirm extension is loaded.",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      handler: async (args) => {
        log("probe_echo.called", { args });
        return `echo: ${args.text} (pid=${PID}, tick=${tickCount})`;
      },
    },
  ],
  hooks: {
    onSessionStart: async (input, invocation) => {
      log("hook.onSessionStart", { input, invocation });
    },
    onSessionEnd: async (input, invocation) => {
      log("hook.onSessionEnd", { input, invocation });
      if (intervalHandle) clearInterval(intervalHandle);
    },
    onUserPromptSubmitted: async (input) => {
      log("hook.onUserPromptSubmitted", { input });
    },
  },
});

log("joinSession.resolved", { sessionId: session.sessionId });

for (const ev of [
  "user.message",
  "assistant.turn_start",
  "assistant.turn_end",
  "assistant.message",
  "session.idle",
  "session.resume",
  "session.end",
  "user_input.requested",
  "user_input.completed",
]) {
  session.on(ev, (event) => {
    log(`event.${ev}`, {
      id: event.id,
      parentId: event.parentId,
      ephemeral: event.ephemeral,
      dataKeys: event.data ? Object.keys(event.data) : null,
      dataSource: event.data?.source,
      dataContentHead:
        typeof event.data?.content === "string"
          ? event.data.content.slice(0, 120)
          : undefined,
    });
  });
}

log("probe.ready", { sessionId: session.sessionId });

process.on("SIGTERM", () => {
  log("signal.SIGTERM", {});
  if (intervalHandle) clearInterval(intervalHandle);
});
process.on("SIGINT", () => {
  log("signal.SIGINT", {});
  if (intervalHandle) clearInterval(intervalHandle);
});
process.on("exit", (code) => {
  log("process.exit", { code });
});
