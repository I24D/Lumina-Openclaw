/**
 * luminaCore.ts — HTTP client that forwards requests to the LUMINA AI core (I24D_WhatsApp).
 *
 * Instead of calling an LLM directly, lumina-brain delegates to the full
 * LUMINA intelligence pipeline: memory, reasoning, tools, and all cerebro layers.
 */

const LUMINA_CORE_URL    = process.env.LUMINA_CORE_URL    ?? "";
const LUMINA_BRAIN_SECRET = process.env.LUMINA_BRAIN_SECRET ?? "";
const REQUEST_TIMEOUT_MS  = Number(process.env.LUMINA_CORE_TIMEOUT_MS ?? 60_000);

export class LuminaCoreError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "LuminaCoreError";
  }
}

export async function callLuminaCore(message: string, userId: string): Promise<string> {
  if (!LUMINA_CORE_URL) {
    throw new LuminaCoreError(500, "LUMINA_CORE_URL is not configured");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${LUMINA_CORE_URL}/api/lumina/brain`, {
      method:  "POST",
      headers: {
        "Content-Type":        "application/json",
        "x-lumina-brain-key":  LUMINA_BRAIN_SECRET,
      },
      body:   JSON.stringify({
        message,
        userId,
        channel: "openclaw",
        context: {
          client: "lumina-openclaw",
          source: "lumina-brain",
        },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new LuminaCoreError(503, `LUMINA core unreachable: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new LuminaCoreError(res.status, `LUMINA core error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as { content?: string };
  return data.content ?? "";
}
