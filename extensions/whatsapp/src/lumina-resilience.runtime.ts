/**
 * Lumina fork: delivery side of the WhatsApp outage alerter (see lumina-resilience.ts).
 *
 * The alert does not wait for a model turn, because the moment WhatsApp breaks may be the moment the
 * model provider is out of credit too. It is sent straight through the Telegram channel on behalf of
 * the alert agent (`main` by default) and is also queued as a system event in that agent's main
 * session, so the agent knows about it on its next turn.
 *
 * Settings (operator environment, `~/.openclaw/.env`):
 * - `LUMINA_WHATSAPP_ALERT_TELEGRAM_TO`  Telegram chat id; `none` disables Telegram delivery. Unset:
 *   the single numeric entry of `channels.telegram.allowFrom` (the owner of a personal bot).
 * - `LUMINA_WHATSAPP_ALERT_AGENT`        agent that owns the alert, default `main`.
 */
import {
  buildOutboundSessionContext,
  sendDurableMessageBatch,
} from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { buildAgentMainSessionKey } from "openclaw/plugin-sdk/routing";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { enqueueRoutedSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import { whatsappLog } from "./auto-reply/loggers.js";
import type { WhatsAppOutageAlert } from "./lumina-resilience.js";

const log = whatsappLog.child("lumina-alert");
const DEFAULT_ALERT_AGENT_ID = "main";

export type WhatsAppOutageAlertTarget = { channel: "telegram"; to: string };

export function resolveWhatsAppOutageAlertTarget(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): WhatsAppOutageAlertTarget | null {
  const explicit = env.LUMINA_WHATSAPP_ALERT_TELEGRAM_TO?.trim();
  if (explicit) {
    return explicit.toLowerCase() === "none" ? null : { channel: "telegram", to: explicit };
  }
  const telegram = (cfg.channels as Record<string, unknown> | undefined)?.telegram;
  if (!telegram || typeof telegram !== "object") {
    return null;
  }
  const { enabled, allowFrom } = telegram as { enabled?: unknown; allowFrom?: unknown };
  if (enabled === false || !Array.isArray(allowFrom) || allowFrom.length !== 1) {
    return null;
  }
  const owner = String(allowFrom[0]).trim();
  return /^-?\d+$/.test(owner) ? { channel: "telegram", to: owner } : null;
}

export function resolveWhatsAppOutageAlertAgentId(env: NodeJS.ProcessEnv = process.env): string {
  return env.LUMINA_WHATSAPP_ALERT_AGENT?.trim() || DEFAULT_ALERT_AGENT_ID;
}

type SendDeps = {
  getConfig: () => OpenClawConfig;
  enqueueEvent: typeof enqueueRoutedSystemEvent;
  send: typeof sendDurableMessageBatch;
  env: NodeJS.ProcessEnv;
};

const defaultDeps: SendDeps = {
  getConfig: getRuntimeConfig,
  enqueueEvent: enqueueRoutedSystemEvent,
  send: sendDurableMessageBatch,
  env: process.env,
};

/** Never throws: a failed alert is logged, it must not take the WhatsApp monitor down with it. */
export async function sendWhatsAppOutageAlert(
  alert: WhatsAppOutageAlert,
  deps: Partial<SendDeps> = {},
): Promise<"sent" | "no-target" | "failed"> {
  const { getConfig, enqueueEvent, send, env } = { ...defaultDeps, ...deps };
  try {
    const cfg = getConfig();
    const agentId = resolveWhatsAppOutageAlertAgentId(env);
    try {
      enqueueEvent(alert.text, {
        agentId,
        sessionKey: buildAgentMainSessionKey({ agentId, mainKey: cfg.session?.mainKey }),
      });
    } catch (error) {
      log.warn(`outage alert (${alert.kind}) not queued for agent ${agentId}: ${String(error)}`);
    }

    const target = resolveWhatsAppOutageAlertTarget(cfg, env);
    if (!target) {
      log.warn(
        `outage alert (${alert.kind}) has no Telegram target: set LUMINA_WHATSAPP_ALERT_TELEGRAM_TO or allow exactly one Telegram user`,
      );
      return "no-target";
    }

    const session = buildOutboundSessionContext({ cfg, agentId });
    const result = await send({
      cfg,
      channel: target.channel,
      to: target.to,
      payloads: [{ text: alert.text }],
      durability: "required",
      ...(session ? { session } : {}),
    });
    if (result.status === "sent") {
      log.info(`outage alert (${alert.kind}) sent to Telegram for account ${alert.accountId}`);
      return "sent";
    }
    log.warn(`outage alert (${alert.kind}) Telegram delivery ended as ${result.status}`);
    return "failed";
  } catch (error) {
    logOutageAlertFailure(error, alert);
    return "failed";
  }
}

export function logOutageAlertFailure(error: unknown, alert: WhatsAppOutageAlert): void {
  log.warn(`outage alert (${alert.kind}) could not be delivered: ${String(error)}`);
}
