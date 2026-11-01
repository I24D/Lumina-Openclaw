// Streams new Windows toast notifications into the read-aloud pipeline.
//
// Windows exposes live toasts through the WinRT UserNotificationListener, which has
// no Node binding here, so a small Python sidecar owns the WinRT call and streams
// JSON lines back. Python rather than PowerShell on purpose: this machine's AMSI
// hook blocks scripted PowerShell.
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeReadAloudText, type ReadAloudEmit } from "./types.js";

const log = createSubsystemLogger("lumina/read-aloud");

const LISTENER_SCRIPT = "notification_listener.py";
const POLL_INTERVAL_MS = 2_000;
const RESTART_DELAY_MS = 5_000;
const MAX_RESTART_DELAY_MS = 60_000;

/**
 * Apps whose toasts are read out loud by default.
 *
 * Phone Link ("Enlace movil") is the one the user asked for; WhatsApp Desktop rides
 * along because it is the other conversation surface on this machine. Matching is a
 * case-insensitive substring test against both the AUMID and the display name, so
 * the Spanish and English builds of Phone Link both hit.
 */
const DEFAULT_APP_MATCHERS = [
  "yourphone",
  "phone link",
  "enlace movil",
  "enlace móvil",
  "whatsapp",
] as const;

type ToastNotification = {
  id?: unknown;
  appName?: unknown;
  appUserModelId?: unknown;
  title?: unknown;
  body?: unknown;
};

/** Controls the sidecar process feeding notifications to the voice. */
export type NotificationWatcher = {
  start(): void;
  stop(): void;
};

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Reads the configured allowlist; `*` opts into every app's toasts. */
export function resolveNotificationAppMatchers(raw: string | undefined): string[] | "all" {
  const configured = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (configured.includes("*")) {
    return "all";
  }
  return configured.length > 0 ? configured : [...DEFAULT_APP_MATCHERS];
}

/** True when a toast comes from an app the user wants read aloud. */
export function matchesNotificationApp(
  notification: ToastNotification,
  matchers: string[] | "all",
): boolean {
  if (matchers === "all") {
    return true;
  }
  const haystack =
    `${asText(notification.appUserModelId)} ${asText(notification.appName)}`.toLowerCase();
  return matchers.some((matcher) => haystack.includes(matcher));
}

/** Builds the spoken sentence for a toast: app, then title and body verbatim. */
export function buildNotificationSpeech(notification: ToastNotification): string {
  const appName = asText(notification.appName) || "Notificación";
  const title = asText(notification.title);
  const body = asText(notification.body);
  const headline = [title, body].filter(Boolean).join(": ");
  return normalizeReadAloudText(headline ? `${appName}. ${headline}` : appName);
}

/** Locates the sidecar next to this module, then in the repo the gateway runs from. */
export function resolveListenerScriptPath(): string | undefined {
  const override = process.env.LUMINA_NOTIFICATION_LISTENER?.trim();
  if (override) {
    return existsSync(override) ? override : undefined;
  }
  const candidates: string[] = [];
  try {
    candidates.push(fileURLToPath(new URL(LISTENER_SCRIPT, import.meta.url)));
  } catch {
    // A bundled module URL may not be a file URL; the repo-relative paths cover it.
  }
  const entry = process.argv[1];
  const moduleRelative = "src/lumina/read-aloud";
  if (entry) {
    // The gateway runs `node dist/index.js`, so the sources sit one level up.
    candidates.push(resolve(dirname(entry), "..", moduleRelative, LISTENER_SCRIPT));
  }
  candidates.push(resolve(process.cwd(), moduleRelative, LISTENER_SCRIPT));
  return candidates.find((candidate) => existsSync(candidate));
}

function pythonCommand(): { command: string; prefixArgs: string[] } {
  const configured = process.env.LUMINA_PYTHON?.trim();
  if (configured) {
    return { command: configured, prefixArgs: [] };
  }
  // The Windows launcher resolves the newest interpreter, which is the one carrying
  // the winsdk package on this machine.
  return process.platform === "win32"
    ? { command: "py", prefixArgs: ["-3"] }
    : { command: "python3", prefixArgs: [] };
}

/** Creates the notification source; it is a no-op away from Windows. */
export function createNotificationWatcher(params: {
  emit: ReadAloudEmit;
  appMatchers?: string[] | "all";
}): NotificationWatcher {
  const matchers =
    params.appMatchers ?? resolveNotificationAppMatchers(process.env.LUMINA_READ_ALOUD_NOTIFY_APPS);
  let child: ChildProcessByStdio<null, Readable, Readable> | undefined;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let restartDelayMs = RESTART_DELAY_MS;
  let stopped = false;
  let pending = "";

  const handleLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let message: { type?: unknown; notification?: ToastNotification; error?: unknown };
    try {
      message = JSON.parse(trimmed);
    } catch {
      log.debug(`read-aloud notification sidecar emitted non-JSON: ${trimmed.slice(0, 200)}`);
      return;
    }
    if (message.type === "ready") {
      // A clean connect means the previous failure, if any, is over.
      restartDelayMs = RESTART_DELAY_MS;
      log.info("read-aloud notification listener ready");
      return;
    }
    if (message.type === "error") {
      log.warn(`read-aloud notification listener unavailable: ${asText(message.error)}`);
      return;
    }
    if (message.type !== "notification" || !message.notification) {
      return;
    }
    const notification = message.notification;
    if (!matchesNotificationApp(notification, matchers)) {
      return;
    }
    const text = buildNotificationSpeech(notification);
    if (text) {
      params.emit({ source: "notification", id: asText(notification.id) || text, text });
    }
  };

  const scheduleRestart = (): void => {
    if (stopped || restartTimer) {
      return;
    }
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      spawnListener();
    }, restartDelayMs);
    restartTimer.unref();
    restartDelayMs = Math.min(restartDelayMs * 2, MAX_RESTART_DELAY_MS);
  };

  const spawnListener = (): void => {
    if (stopped || child) {
      return;
    }
    const script = resolveListenerScriptPath();
    if (!script) {
      log.warn(
        `read-aloud notifications disabled: ${LISTENER_SCRIPT} not found (set LUMINA_NOTIFICATION_LISTENER)`,
      );
      return;
    }
    const { command, prefixArgs } = pythonCommand();
    let spawned: ChildProcessByStdio<null, Readable, Readable>;
    try {
      spawned = spawn(
        command,
        [...prefixArgs, script, "--watch", "--interval-ms", String(POLL_INTERVAL_MS)],
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
    } catch (err: unknown) {
      log.warn(`read-aloud notification listener failed to start: ${formatErrorMessage(err)}`);
      scheduleRestart();
      return;
    }
    child = spawned;
    // The sidecar must never hold the gateway open on shutdown.
    spawned.unref();
    spawned.stdout.setEncoding("utf8");
    spawned.stdout.on("data", (chunk: string) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/u);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        handleLine(line);
      }
    });
    spawned.stderr.setEncoding("utf8");
    spawned.stderr.on("data", (chunk: string) => {
      log.debug(`read-aloud notification listener stderr: ${chunk.trim().slice(0, 400)}`);
    });
    spawned.on("error", (err: Error) => {
      log.warn(`read-aloud notification listener error: ${formatErrorMessage(err)}`);
    });
    spawned.on("exit", (code) => {
      child = undefined;
      pending = "";
      if (!stopped) {
        log.debug(`read-aloud notification listener exited code=${code ?? "null"}; restarting`);
        scheduleRestart();
      }
    });
  };

  return {
    start(): void {
      if (process.platform !== "win32") {
        return;
      }
      stopped = false;
      spawnListener();
    },
    stop(): void {
      stopped = true;
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = undefined;
      }
      child?.kill();
      child = undefined;
    },
  };
}

/** Exposed for tests that assert the default allowlist. */
export const DEFAULT_NOTIFICATION_APP_MATCHERS = DEFAULT_APP_MATCHERS;
