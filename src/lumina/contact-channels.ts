/**
 * Lumina fork policy: which outbound channels reach third-party contacts.
 *
 * OpenClaw assumes a direct chat is with the operator, so it delivers internal
 * model-fallback notices and run-failure text into DMs. Where an agent answers
 * real contacts autonomously that assumption breaks and the diagnostics leak to
 * them, so every channel named here gets silence instead; the fallback is still
 * recorded by the lifecycle event, the decision receipt and the run log.
 *
 * `LUMINA_CONTACT_CHANNELS` owns the list and is read from the operator
 * environment (`~/.openclaw/.env`, loaded by src/infra/dotenv-global.ts).
 * Unset means no channel is guarded, which is upstream's behavior.
 *
 * Example: `LUMINA_CONTACT_CHANNELS=whatsapp`
 */

function parseContactChannels(raw: string | undefined): ReadonlySet<string> {
  if (!raw) {
    return new Set();
  }
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0 && entry !== "none"),
  );
}

// The parsed set is process-stable in practice; re-parse only when the raw value changes.
let cachedContactChannels: { raw: string | undefined; channels: ReadonlySet<string> } | undefined;

/** Resolves the channels treated as third-party contact surfaces. */
export function resolveContactChannels(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  const raw = env.LUMINA_CONTACT_CHANNELS;
  if (!cachedContactChannels || cachedContactChannels.raw !== raw) {
    cachedContactChannels = { raw, channels: parseContactChannels(raw) };
  }
  return cachedContactChannels.channels;
}

/** True when any candidate identifies a channel that reaches an external contact. */
export function isExternalContactChannel(
  candidates: readonly (string | undefined)[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const channels = resolveContactChannels(env);
  if (channels.size === 0) {
    return false;
  }
  return candidates.some((candidate) => {
    const normalized = candidate?.trim().toLowerCase();
    return normalized ? channels.has(normalized) : false;
  });
}
