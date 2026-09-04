// Transcript record parsers for the read-aloud pipeline.
// Each parser returns the speakable final answer of one assistant turn, or "" for
// anything that is not a completed answer (tool calls, deltas, reasoning, echoes).

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Joins the text blocks of an assistant message, ignoring tool and reasoning blocks. */
export function textFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((entry) => asRecord(entry))
    .filter((block): block is Record<string, unknown> => Boolean(block))
    .filter((block) => block.type === "text" || block.type === "output_text")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("")
    .trim();
}

/** Codex CLI rollout record: only the final answer of a turn is spoken. */
export function parseCodexRecord(record: unknown): string {
  const parsed = asRecord(record);
  if (parsed?.type !== "response_item") {
    return "";
  }
  const payload = asRecord(parsed.payload);
  if (
    payload?.type !== "message" ||
    payload.role !== "assistant" ||
    payload.phase !== "final_answer"
  ) {
    return "";
  }
  return textFromContent(payload.content);
}

/** Claude Code transcript record: `end_turn` marks the answer the user reads. */
export function parseClaudeCodeRecord(record: unknown): string {
  const parsed = asRecord(record);
  if (parsed?.type !== "assistant") {
    return "";
  }
  const message = asRecord(parsed.message);
  if (message?.role !== "assistant") {
    return "";
  }
  const stopReason = parsed.stop_reason ?? message.stop_reason;
  if (stopReason !== "end_turn") {
    return "";
  }
  return textFromContent(message.content);
}

/**
 * True when a transcript message is the voice talking, not the chat.
 *
 * The Talk conversation ("Lumina Start talk") shares its session with the typed chat,
 * so two kinds of message land there that must never be read out loud:
 *
 *  - what the realtime model itself said (`api: "realtime"`, `provenance.kind`);
 *  - the agent consult the voice delegates mid-conversation, whose run carries a
 *    `talk-<callId>-<uuid>` idempotency key. The relay already speaks that answer,
 *    so reading it again would say every delegated reply twice.
 *
 * What survives is the typed chat: the user writes in the session and hears the answer.
 */
export function isVoiceOwnedMessage(message: Record<string, unknown>): boolean {
  if (message.api === "realtime") {
    return true;
  }
  const idempotencyKey = message.idempotencyKey;
  if (typeof idempotencyKey === "string" && idempotencyKey.startsWith("talk-")) {
    return true;
  }
  const provenance = asRecord(message.provenance);
  return provenance?.kind === "realtime_voice" || provenance?.sourceChannel === "talk";
}

/**
 * Decides whether a transcript session is one the user is reading on screen.
 *
 * The main agent's store holds more than the chat: conversations routed in from
 * Telegram or WhatsApp, and scheduled `cron` runs. Narrating the bot's replies to a
 * contact, or a background job, is not what read-aloud is for. What stays is the
 * Control UI chat and the "Lumina Start talk" session.
 */
export function shouldReadTranscriptSession(params: {
  sessionKey?: string | null;
  channel?: string | null;
}): boolean {
  if (typeof params.channel === "string" && params.channel.trim()) {
    return false;
  }
  const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey : "";
  return !sessionKey.includes(":cron:");
}

/** OpenClaw transcript event: a completed assistant turn from the typed chat. */
export function parseOpenClawTranscriptEvent(eventJson: unknown): string {
  let event: unknown = eventJson;
  if (typeof eventJson === "string") {
    try {
      event = JSON.parse(eventJson);
    } catch {
      return "";
    }
  }
  const parsed = asRecord(event);
  if (parsed?.type !== "message") {
    return "";
  }
  const message = asRecord(parsed.message);
  if (message?.role !== "assistant" || isVoiceOwnedMessage(message)) {
    return "";
  }
  const stopReason = message.stopReason ?? message.stop_reason;
  if (stopReason !== "stop" && stopReason !== "end_turn") {
    return "";
  }
  return textFromContent(message.content);
}
