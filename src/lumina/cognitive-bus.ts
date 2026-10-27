/**
 * Lumina fork: gateway lifecycle events on the LUMINA Cognitive Bus.
 *
 * The bus is the Supabase table `lumina_events`, written through PostgREST
 * (see ~/.openclaw/workspace/lumina-cognitive-bus/README.md). Every event is one
 * fire-and-forget insert: never awaited, bounded to 3 s, with every failure
 * swallowed, so a missing credential or an unreachable Supabase leaves the
 * gateway exactly as it was and logs nothing.
 *
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY come from the operator environment
 * (`~/.openclaw/.env`, loaded by src/infra/dotenv-global.ts). Nothing is
 * published until this process starts a gateway, so CLI commands that deliver
 * messages stay off the bus.
 */
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { CronEvent } from "../cron/types.js";
import { redactSensitiveText } from "../logging/redact.js";
import { resolveRuntimeServiceBuildId } from "../version.js";

const BUS_ORIGIN = "openclaw-gateway";
const PUBLISH_TIMEOUT_MS = 3_000;
const ERROR_SUMMARY_MAX_CHARS = 200;

type LuminaBusEvent = {
  type: "gateway.started" | "automation.completed" | "automation.failed" | "message.delivered";
  /** The bus scale: 1 noise, 2 normal, 3 relevant change, 4 error or risk. */
  priority: 1 | 2 | 3 | 4;
  evidence: Record<string, string | null>;
};

let gatewayStarted = false;

function publish(event: LuminaBusEvent, env: NodeJS.ProcessEnv): void {
  const url = env.SUPABASE_URL?.trim().replace(/\/+$/u, "");
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!gatewayStarted || !url || !key) {
    return;
  }
  void fetch(`${url}/rest/v1/lumina_events`, {
    method: "POST",
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      prefer: "return=minimal",
    },
    body: JSON.stringify({
      origin: BUS_ORIGIN,
      event_type: event.type,
      priority: event.priority,
      evidence: event.evidence,
    }),
    signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
  })
    .then((response) => response.body?.cancel())
    .catch(() => undefined);
}

function summarizeError(text: string): string {
  const summary = redactSensitiveText(text, { mode: "tools" }).replace(/\s+/gu, " ").trim();
  return truncateUtf16Safe(summary || "no error detail", ERROR_SUMMARY_MAX_CHARS);
}

/** Marks this process as a gateway and announces the build it serves. */
export function publishLuminaGatewayStarted(env: NodeJS.ProcessEnv = process.env): void {
  try {
    gatewayStarted = true;
    publish(
      {
        type: "gateway.started",
        priority: 3,
        evidence: { buildId: resolveRuntimeServiceBuildId() },
      },
      env,
    );
  } catch {
    // The bus is best-effort: the gateway never depends on it.
  }
}

/**
 * Publishes a finished automation run and ignores every other cron event. A
 * run failed when OpenClaw does not count it as complete: an error, a skip, or
 * an "ok" run whose required delivery failed.
 */
export function publishLuminaAutomationEvent(
  evt: Pick<
    CronEvent,
    "action" | "jobId" | "status" | "completionStatus" | "error" | "deliveryError"
  >,
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    if (evt.action !== "finished") {
      return;
    }
    const status = evt.status ?? "unknown";
    if (status === "ok" && evt.completionStatus !== "failed") {
      publish(
        { type: "automation.completed", priority: 2, evidence: { jobId: evt.jobId, status } },
        env,
      );
      return;
    }
    const error = evt.error ?? evt.deliveryError ?? (status === "ok" ? "result not delivered" : "");
    publish(
      {
        type: "automation.failed",
        priority: 4,
        evidence: { jobId: evt.jobId, status, error: summarizeError(error) },
      },
      env,
    );
  } catch {
    // The bus is best-effort: the gateway never depends on it.
  }
}

/** Publishes a message a gateway channel delivered; failed sends stay off the bus. */
export function publishLuminaMessageSent(
  channel: string,
  sent: { success: boolean },
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    if (sent.success) {
      publish({ type: "message.delivered", priority: 1, evidence: { channel } }, env);
    }
  } catch {
    // The bus is best-effort: the gateway never depends on it.
  }
}

/** Forgets that this process started a gateway. */
export function resetLuminaCognitiveBusForTests(): void {
  gatewayStarted = false;
}
