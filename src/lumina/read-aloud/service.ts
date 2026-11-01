// Orchestrates the read-aloud pipeline: watch sources, dedupe, speak.
//
// Start Talk only reads when the voice is actually on. An item that arrives while no
// session is live is dropped after a short grace window instead of being queued, so
// turning the voice on never triggers a backlog of stale answers.
import { createHash } from "node:crypto";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createNotificationWatcher, type NotificationWatcher } from "./notification-watcher.js";
import { hasLiveTalkSession, speakToLiveTalkSessions } from "./speaker.js";
import { createTranscriptWatcher } from "./transcript-watcher.js";
import { READ_ALOUD_SOURCE_LABELS, type ReadAloudItem } from "./types.js";

const log = createSubsystemLogger("lumina/read-aloud");

const TRANSCRIPT_POLL_MS = 1_500;
const DRAIN_INTERVAL_MS = 750;
/** Minimum gap between two spoken items so the voice does not talk over itself. */
const SPEECH_GAP_MS = 2_500;
/** An item still unspoken after this long is stale news and gets dropped. */
const MAX_WAIT_FOR_VOICE_MS = 20_000;
const MAX_QUEUE_LENGTH = 20;
const SEEN_TTL_MS = 10 * 60_000;

/** Handle for the running pipeline. */
export type ReadAloudService = {
  stop(): void;
};

type QueuedItem = ReadAloudItem & { enqueuedAtMs: number };

function hashItem(item: ReadAloudItem): string {
  return createHash("sha256")
    .update(`${item.source}\n${item.text.replace(/\s+/gu, " ").trim()}`)
    .digest("hex");
}

/** Prefixes transcript answers with their origin; notifications name their own app. */
function speechFor(item: ReadAloudItem): string {
  return item.source === "notification"
    ? item.text
    : `${READ_ALOUD_SOURCE_LABELS[item.source]}: ${item.text}`;
}

/** True unless the operator turned read-aloud off. */
export function isReadAloudEnabled(raw: string | undefined): boolean {
  const flag = (raw ?? "").trim().toLowerCase();
  return !["false", "0", "off", "no"].includes(flag);
}

/**
 * Starts watching Claude Code, Codex, the OpenClaw chat and Windows notifications,
 * reading each new item aloud through the live Talk session.
 */
export function startReadAloudService(params?: {
  now?: () => number;
  home?: string;
  notifications?: NotificationWatcher;
}): ReadAloudService {
  const now = params?.now ?? (() => Date.now());
  const queue: QueuedItem[] = [];
  const seen = new Map<string, number>();
  let lastSpokeAtMs = 0;

  const enqueue = (item: ReadAloudItem): void => {
    const key = hashItem(item);
    if (seen.has(key)) {
      return;
    }
    // Reserve the key up front: the same answer reaching us twice (a transcript
    // rewrite, a duplicated toast) must not be read twice.
    seen.set(key, now());
    queue.push({ ...item, enqueuedAtMs: now() });
    while (queue.length > MAX_QUEUE_LENGTH) {
      queue.shift();
    }
  };

  const transcripts = createTranscriptWatcher({ emit: enqueue, now, home: params?.home });
  const notifications = params?.notifications ?? createNotificationWatcher({ emit: enqueue });

  const pruneSeen = (nowMs: number): void => {
    for (const [key, timestamp] of seen) {
      if (nowMs - timestamp > SEEN_TTL_MS) {
        seen.delete(key);
      }
    }
  };

  const drain = (): void => {
    const nowMs = now();
    for (;;) {
      const head = queue[0];
      if (!head || nowMs - head.enqueuedAtMs <= MAX_WAIT_FOR_VOICE_MS) {
        break;
      }
      queue.shift();
      log.debug(`read-aloud dropped stale item source=${head.source} id=${head.id}`);
    }
    const next = queue[0];
    if (!next || nowMs - lastSpokeAtMs < SPEECH_GAP_MS || !hasLiveTalkSession()) {
      return;
    }
    const delivered = speakToLiveTalkSessions(speechFor(next));
    if (delivered === 0) {
      // The session dropped between the check and the send; retry on the next tick.
      return;
    }
    queue.shift();
    lastSpokeAtMs = nowMs;
    log.info(`read-aloud spoke source=${next.source} chars=${next.text.length}`);
  };

  const transcriptTimer = setInterval(() => {
    try {
      transcripts.poll();
    } catch (err: unknown) {
      log.warn(`read-aloud transcript poll failed: ${formatErrorMessage(err)}`);
    }
  }, TRANSCRIPT_POLL_MS);
  transcriptTimer.unref();

  const drainTimer = setInterval(() => {
    try {
      drain();
      pruneSeen(now());
    } catch (err: unknown) {
      log.warn(`read-aloud drain failed: ${formatErrorMessage(err)}`);
    }
  }, DRAIN_INTERVAL_MS);
  drainTimer.unref();

  // Baseline every source immediately so the first real poll only sees new answers.
  try {
    transcripts.poll();
  } catch (err: unknown) {
    log.warn(`read-aloud baseline failed: ${formatErrorMessage(err)}`);
  }
  notifications.start();

  log.info("read-aloud started (Claude Code, Codex, OpenClaw chat, Windows notifications)");

  return {
    stop(): void {
      clearInterval(transcriptTimer);
      clearInterval(drainTimer);
      notifications.stop();
      queue.length = 0;
    },
  };
}
