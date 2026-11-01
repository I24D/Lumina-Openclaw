/**
 * Lumina fork: keep the WhatsApp channel from dying in silence.
 *
 * Upstream gives up after `maxAttempts` fast reconnects and marks the account terminal, so neither
 * the channel supervisor nor the gateway health monitor ever restarts it. A DNS or network outage of
 * a few minutes after a gateway restart (`getaddrinfo ENOTFOUND web.whatsapp.com`, Baileys status
 * 408) was enough to leave WhatsApp down for days, twice, with inbound messages lost and nobody told.
 *
 * Two independent safeguards live here:
 * - `resolveWhatsAppSlowRetryMs` turns retry exhaustion into slow, endless retries
 *   (see `ReconnectPolicy.slowRetryMs`).
 * - The outage alerter watches the account status stream and tells the operator on Telegram,
 *   through the `main` agent, when the channel stays offline, stops for good, or comes back.
 *
 * Settings come from the operator environment (`~/.openclaw/.env`); `0` disables each one:
 * - `LUMINA_WHATSAPP_SLOW_RETRY_MS`   default 300000 (5 min between retries once the fast ladder is spent)
 * - `LUMINA_WHATSAPP_ALERT_AFTER_MS`  default 600000 (alert after 10 min offline)
 * - `LUMINA_WHATSAPP_ALERT_REPEAT_MS` default 21600000 (reminder every 6 h while still offline)
 * Delivery target settings are read by `lumina-resilience.runtime.ts`.
 */
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { WebChannelStatus } from "./auto-reply/types.js";

const DEFAULT_SLOW_RETRY_MS = 5 * 60_000;
const DEFAULT_ALERT_AFTER_MS = 10 * 60_000;
const DEFAULT_ALERT_REPEAT_MS = 6 * 60 * 60_000;
// A monitor aborted by a supervisor or health-monitor restart is replaced within seconds; a longer
// gap means an operator stop, so the next start opens a fresh outage instead of inheriting one.
const RESTART_CONTINUITY_MS = 2 * 60_000;
const MAX_ERROR_CHARS = 160;

export type WhatsAppOutageAlertKind = "down" | "reminder" | "terminal" | "recovered";

export type WhatsAppOutageAlert = {
  kind: WhatsAppOutageAlertKind;
  accountId: string;
  text: string;
  downSince: number;
  at: number;
};

export type WhatsAppOutageAlertSettings = {
  /** Offline time before the first alert. 0 disables the alerter. */
  alertAfterMs: number;
  /** Time between reminders while still offline. 0 sends no reminders. */
  repeatAfterMs: number;
  restartContinuityMs: number;
};

/** `setTimeout` handle in production (an object in Node), any id in tests. */
type TimerHandle = object | number;

export type WhatsAppOutageAlerterDeps = {
  settings: WhatsAppOutageAlertSettings;
  send: (alert: WhatsAppOutageAlert) => Promise<void>;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  formatTime?: (at: number) => string;
  onSendError?: (error: unknown, alert: WhatsAppOutageAlert) => void;
};

export type WhatsAppOutageAlerter = {
  /** Feed every status the monitor publishes for an account. */
  observe: (accountId: string, status: WebChannelStatus) => void;
  /** Call when the account monitor returns or throws. */
  noteMonitorExit: (accountId: string, params: { aborted: boolean }) => void;
};

type OutageRecord = {
  downSince: number;
  lastError: string | null;
  healthState: WebChannelStatus["healthState"];
  reconnectAttempts: number;
  alertedAt: number | null;
  terminalAlerted: boolean;
  timer: TimerHandle | null;
  detachedAt: number | null;
};

function readMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw.trim());
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/** Slow retry interval once the fast reconnect ladder is spent; 0 restores upstream's give-up. */
export function resolveWhatsAppSlowRetryMs(env: NodeJS.ProcessEnv = process.env): number {
  return readMs(env.LUMINA_WHATSAPP_SLOW_RETRY_MS, DEFAULT_SLOW_RETRY_MS);
}

export function resolveWhatsAppOutageAlertSettings(
  env: NodeJS.ProcessEnv = process.env,
): WhatsAppOutageAlertSettings {
  return {
    alertAfterMs: readMs(env.LUMINA_WHATSAPP_ALERT_AFTER_MS, DEFAULT_ALERT_AFTER_MS),
    repeatAfterMs: readMs(env.LUMINA_WHATSAPP_ALERT_REPEAT_MS, DEFAULT_ALERT_REPEAT_MS),
    restartContinuityMs: RESTART_CONTINUITY_MS,
  };
}

/** Logged-out and conflict need the operator; a stopped monitor with a blocked lifecycle never returns alone. */
function isTerminalStatus(status: WebChannelStatus): boolean {
  return (
    status.healthState === "logged-out" ||
    status.healthState === "conflict" ||
    Boolean(status.terminalDisconnect) ||
    (!status.running && status.lifecycle === "blocked")
  );
}

export function formatOutageDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    const rest = minutes % 60;
    return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`;
  }
  return `${Math.floor(hours / 24)} días`;
}

function defaultFormatTime(at: number): string {
  return new Date(at).toLocaleString("es-MX", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function describeError(lastError: string | null): string {
  if (!lastError) {
    return "";
  }
  const oneLine = lastError.replace(/\s+/g, " ").trim();
  const text =
    oneLine.length > MAX_ERROR_CHARS ? `${oneLine.slice(0, MAX_ERROR_CHARS - 1)}…` : oneLine;
  return ` Último error: ${text}.`;
}

export function buildWhatsAppOutageAlertText(params: {
  kind: WhatsAppOutageAlertKind;
  accountId: string;
  downSince: number;
  now: number;
  lastError: string | null;
  healthState: WebChannelStatus["healthState"];
  formatTime?: (at: number) => string;
}): string {
  const formatTime = params.formatTime ?? defaultFormatTime;
  const who =
    params.accountId && params.accountId !== "default" ? ` (cuenta ${params.accountId})` : "";
  const since = formatTime(params.downSince);
  const duration = formatOutageDuration(params.now - params.downSince);
  const error = describeError(params.lastError);
  switch (params.kind) {
    case "recovered":
      return `✅ WhatsApp de Lumina${who} volvió a conectarse tras ${duration} sin conexión. Revisa si quedaron mensajes sin responder de ese rato.`;
    case "terminal":
      if (params.healthState === "logged-out") {
        return `⛔ WhatsApp de Lumina${who} se desvinculó (sesión cerrada) y no se reconectará solo. Vuelve a vincularlo con "openclaw channels login --channel whatsapp".`;
      }
      if (params.healthState === "conflict") {
        return `⛔ WhatsApp de Lumina${who} se detuvo: otra sesión de WhatsApp Web está usando la cuenta. Cierra esa sesión y reinicia el canal.${error}`;
      }
      return `⛔ WhatsApp de Lumina${who} dejó de reintentar y no volverá solo (sin conexión desde ${since}).${error} Reinicia el canal o el gateway de OpenClaw.`;
    case "reminder":
      return `⚠️ WhatsApp de Lumina${who} sigue sin conexión: ya son ${duration} (desde ${since}).${error} OpenClaw sigue reintentando; si no vuelve, reinicia el canal o el gateway.`;
    default:
      return `⚠️ WhatsApp de Lumina${who} lleva ${duration} sin conexión (desde ${since}): los mensajes entrantes no se están procesando.${error} OpenClaw sigue reintentando y te aviso cuando vuelva.`;
  }
}

export function createWhatsAppOutageAlerter(
  deps: WhatsAppOutageAlerterDeps,
): WhatsAppOutageAlerter {
  const { settings } = deps;
  const now = deps.now ?? Date.now;
  const setTimer =
    deps.setTimer ??
    ((callback: () => void, delayMs: number) => {
      const handle = setTimeout(callback, delayMs);
      handle.unref?.();
      return handle;
    });
  const clearTimer =
    deps.clearTimer ??
    ((handle: TimerHandle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]));
  const records = new Map<string, OutageRecord>();

  const cancelTimer = (record: OutageRecord) => {
    if (record.timer !== null) {
      clearTimer(record.timer);
      record.timer = null;
    }
  };

  const deliver = (accountId: string, record: OutageRecord, kind: WhatsAppOutageAlertKind) => {
    const at = now();
    const alert: WhatsAppOutageAlert = {
      kind,
      accountId,
      downSince: record.downSince,
      at,
      text: buildWhatsAppOutageAlertText({
        kind,
        accountId,
        downSince: record.downSince,
        now: at,
        lastError: record.lastError,
        healthState: record.healthState,
        formatTime: deps.formatTime,
      }),
    };
    // An alert must never break the channel it reports on.
    void deps.send(alert).catch((error: unknown) => deps.onSendError?.(error, alert));
  };

  const schedule = (accountId: string, record: OutageRecord) => {
    if (record.terminalAlerted || record.detachedAt !== null || record.timer !== null) {
      return;
    }
    if (record.alertedAt !== null && settings.repeatAfterMs <= 0) {
      return;
    }
    const dueAt =
      record.alertedAt === null
        ? record.downSince + settings.alertAfterMs
        : record.alertedAt + settings.repeatAfterMs;
    record.timer = setTimer(
      () => {
        record.timer = null;
        if (
          records.get(accountId) !== record ||
          record.detachedAt !== null ||
          record.terminalAlerted
        ) {
          return;
        }
        const kind = record.alertedAt === null ? "down" : "reminder";
        record.alertedAt = now();
        deliver(accountId, record, kind);
        schedule(accountId, record);
      },
      Math.max(0, dueAt - now()),
    );
  };

  return {
    observe(accountId, status) {
      if (settings.alertAfterMs <= 0) {
        return;
      }
      let record = records.get(accountId);
      if (status.connected) {
        if (record) {
          cancelTimer(record);
          records.delete(accountId);
          if (record.alertedAt !== null) {
            deliver(accountId, record, "recovered");
          }
        }
        return;
      }

      const at = now();
      if (record && record.detachedAt !== null) {
        if (at - record.detachedAt > settings.restartContinuityMs) {
          records.delete(accountId);
          record = undefined;
        } else {
          record.detachedAt = null;
        }
      }
      if (!record) {
        record = {
          downSince: at,
          lastError: null,
          healthState: undefined,
          reconnectAttempts: 0,
          alertedAt: null,
          terminalAlerted: false,
          timer: null,
          detachedAt: null,
        };
        records.set(accountId, record);
      }
      record.lastError = status.lastError ?? record.lastError;
      record.healthState = status.healthState ?? record.healthState;
      record.reconnectAttempts = status.reconnectAttempts;

      if (isTerminalStatus(status)) {
        if (!record.terminalAlerted) {
          cancelTimer(record);
          record.terminalAlerted = true;
          record.alertedAt = at;
          deliver(accountId, record, "terminal");
        }
        return;
      }
      schedule(accountId, record);
    },

    noteMonitorExit(accountId, { aborted }) {
      const record = records.get(accountId);
      if (!record || !aborted) {
        // A monitor that ended on its own keeps its pending alert: if the channel supervisor brings
        // it back the next status clears the outage, otherwise the operator still hears about it.
        return;
      }
      // Aborted = operator stop, config reload, gateway shutdown or a health-monitor restart.
      cancelTimer(record);
      record.detachedAt = now();
    },
  };
}

type ResilienceRuntime = typeof import("./lumina-resilience.runtime.js");

const loadResilienceRuntime = createLazyRuntimeModule<ResilienceRuntime>(
  () => import("./lumina-resilience.runtime.js"),
);

let sharedAlerter: WhatsAppOutageAlerter | undefined;

/** Process-wide alerter, so an outage survives the monitor restarts that try to fix it. */
export function getWhatsAppOutageAlerter(): WhatsAppOutageAlerter {
  sharedAlerter ??= createWhatsAppOutageAlerter({
    settings: resolveWhatsAppOutageAlertSettings(),
    send: async (alert) => {
      await (await loadResilienceRuntime()).sendWhatsAppOutageAlert(alert);
    },
    onSendError: (error, alert) => {
      void loadResilienceRuntime()
        .then((runtime) => runtime.logOutageAlertFailure(error, alert))
        .catch(() => {});
    },
  });
  return sharedAlerter;
}
