// Shared shapes for the Lumina read-aloud pipeline.
// A source produces speakable items; the service dedupes them and hands the text
// to every live Talk session so Start Talk reads it out loud.

/** Origin of a speakable item, used for dedupe keys and the spoken prefix. */
export type ReadAloudSource = "claude-code" | "codex" | "openclaw" | "notification";

/** One piece of text queued to be read aloud by Start Talk. */
export type ReadAloudItem = {
  source: ReadAloudSource;
  /** Stable-enough id for logging; dedupe uses the text hash, not this. */
  id: string;
  text: string;
};

/** Callback a source uses to publish a speakable item. */
export type ReadAloudEmit = (item: ReadAloudItem) => void;

/** Spoken label prefixed to each item so the listener knows who is talking. */
export const READ_ALOUD_SOURCE_LABELS: Record<ReadAloudSource, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  openclaw: "OpenClaw",
  notification: "Notificación",
};

/** Upper bound on spoken text; matches the limit the previous Lumina relay used. */
export const READ_ALOUD_MAX_CHARS = 6000;

/**
 * Normalizes transcript text for speech without summarizing it: the user's rule is
 * that Start Talk reads the delivered answer in full, so this only trims and caps.
 */
export function normalizeReadAloudText(text: string): string {
  return text.replace(/\r\n/gu, "\n").trim().slice(0, READ_ALOUD_MAX_CHARS);
}
