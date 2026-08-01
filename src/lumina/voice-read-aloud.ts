// Lumina bridge: forward each finished OpenClaw assistant turn to the Windows
// Bridge voice queue so Start Talk can read it aloud. This mirrors the Claude
// Code `Stop`-hook path — the same bridge endpoint (`/voice/claude-response`)
// and the same downstream (`ClaudeVoiceMonitor` -> orb speech queue) are reused,
// so OpenClaw replies are spoken through the identical, already-verified pipe.
//
// Design notes:
//   * The only chokepoint that carries every assistant reply (control-UI webchat
//     AND external channels) is the in-process agent-event bus. Webchat replies
//     never fire the `message:sent` internal hook, so subscribing here is the
//     only way to cover the OpenClaw chat surface the user actually watches.
//   * Best-effort by design: any error is swallowed so this never disrupts the
//     gateway event loop, and a missing bridge simply drops the POST.
//   * Self-idempotent: a single global subscription is kept, so an in-process
//     gateway restart (config reload) that re-runs the wiring cannot stack
//     duplicate listeners and read a reply twice.
import { onAgentEvent, type AgentEventPayload } from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("lumina-voice-readaloud");

const BRIDGE_URL =
  process.env.LUMINA_VOICE_BRIDGE_URL?.trim() || "http://127.0.0.1:8765/voice/claude-response";
const MAX_CHARS = 6000;
const POST_TIMEOUT_MS = 3000;
const RUN_TTL_MS = 10 * 60_000;
const MAX_RUNS = 64;

type RunAccumulator = { text: string; replaceable: string; updatedAt: number };

/** Env gate mirroring `START_TALK_READ_CLAUDE_CODE`; default ON. */
function readEnabled(): boolean {
  const flag = String(process.env.START_TALK_READ_OPENCLAW ?? "").toLowerCase();
  return flag !== "false" && flag !== "0" && flag !== "off";
}

// A single active subscription across the whole process. Re-running the wiring
// unsubscribes the previous listener first so replies are never read twice.
let currentUnsubscribe: (() => void) | null = null;

function accumulateAssistant(acc: RunAccumulator, evt: AgentEventPayload): void {
  const data = evt.data ?? {};
  // Replaceable snapshots (e.g. interim reasoning) overwrite their own buffer and
  // never contribute to the running answer text.
  if (data.replaceable === true) {
    const snap =
      typeof data.text === "string" ? data.text : typeof data.delta === "string" ? data.delta : "";
    if (snap) {
      acc.replaceable = snap;
    }
    return;
  }
  const text = typeof data.text === "string" ? data.text : undefined;
  const delta = typeof data.delta === "string" ? data.delta : undefined;
  // OpenClaw runtimes emit `text` as the cumulative snapshot and `delta` as the
  // increment. Prefer the growing snapshot; fall back to appending deltas for
  // pure-delta runtimes that never send a full snapshot.
  if (text !== undefined && text.length >= acc.text.length) {
    acc.text = text;
  } else if (delta !== undefined) {
    acc.text += delta;
  } else if (text !== undefined) {
    acc.text += text;
  }
}

function pruneOldRuns(runs: Map<string, RunAccumulator>, now: number): void {
  for (const [runId, acc] of runs) {
    if (now - acc.updatedAt > RUN_TTL_MS) {
      runs.delete(runId);
    }
  }
  while (runs.size > MAX_RUNS) {
    const oldest = runs.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    runs.delete(oldest);
  }
}

function flushRun(runs: Map<string, RunAccumulator>, runId: string): void {
  const acc = runs.get(runId);
  runs.delete(runId);
  if (!acc) {
    return;
  }
  const raw = (acc.text || acc.replaceable || "").trim();
  if (!raw) {
    return;
  }
  const body = JSON.stringify({
    text: raw.slice(0, MAX_CHARS),
    requestId: `openclaw:${runId}`,
  });
  // Fire-and-forget: the bridge queue drains only while a Start Talk voice
  // session is capturing (identical to the Claude Code path). If no voice
  // session is listening, the queued text simply expires after its TTL.
  void fetch(BRIDGE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(POST_TIMEOUT_MS),
  }).catch(() => {
    // Bridge down / unreachable — nothing to do. Never disrupt the gateway.
  });
}

/**
 * Subscribe to the agent-event bus so finished OpenClaw assistant turns are read
 * aloud by Start Talk. Idempotent: safe to call on every gateway start; returns
 * an unsubscribe callback for symmetry (cleanup is also handled internally).
 */
export function startLuminaVoiceReadAloud(): () => void {
  if (currentUnsubscribe) {
    currentUnsubscribe();
    currentUnsubscribe = null;
  }
  if (!readEnabled()) {
    return () => {};
  }

  const runs = new Map<string, RunAccumulator>();

  const unsubscribe = onAgentEvent((evt) => {
    try {
      const now = typeof evt.ts === "number" && Number.isFinite(evt.ts) ? evt.ts : Date.now();
      if (evt.stream === "assistant") {
        let acc = runs.get(evt.runId);
        if (!acc) {
          acc = { text: "", replaceable: "", updatedAt: now };
          runs.set(evt.runId, acc);
        }
        acc.updatedAt = now;
        accumulateAssistant(acc, evt);
        return;
      }
      if (evt.stream === "lifecycle") {
        const phase = typeof evt.data?.phase === "string" ? evt.data.phase : undefined;
        if (phase === "start") {
          runs.set(evt.runId, { text: "", replaceable: "", updatedAt: now });
        } else if (phase === "end") {
          flushRun(runs, evt.runId);
          pruneOldRuns(runs, now);
        } else if (phase === "error") {
          runs.delete(evt.runId);
          pruneOldRuns(runs, now);
        }
      }
    } catch (error) {
      log.debug("voice read-aloud handler error", { error });
    }
  });

  currentUnsubscribe = () => {
    runs.clear();
    unsubscribe();
  };
  log.info("Start Talk read-aloud of OpenClaw replies enabled", { bridge: BRIDGE_URL });
  return currentUnsubscribe;
}
