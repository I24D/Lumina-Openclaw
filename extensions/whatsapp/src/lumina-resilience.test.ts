// Lumina fork tests: WhatsApp outage alerter and resilience settings.
import { describe, expect, it, vi } from "vitest";
import type { WebChannelStatus } from "./auto-reply/types.js";
import {
  buildWhatsAppOutageAlertText,
  createWhatsAppOutageAlerter,
  formatOutageDuration,
  resolveWhatsAppOutageAlertSettings,
  resolveWhatsAppSlowRetryMs,
  type WhatsAppOutageAlert,
  type WhatsAppOutageAlertSettings,
} from "./lumina-resilience.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DNS_ERROR = "WebSocket Error (getaddrinfo ENOTFOUND web.whatsapp.com)";

function createFakeClock(start = Date.UTC(2026, 8, 25, 15, 0)) {
  let now = start;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => now,
    setTimer: (callback: () => void, delayMs: number) => {
      const id = nextId++;
      timers.set(id, { at: now + delayMs, callback });
      return id;
    },
    clearTimer: (handle: unknown) => {
      timers.delete(handle as number);
    },
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .toSorted((a, b) => a[1].at - b[1].at)[0];
        if (!due) {
          break;
        }
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = target;
    },
    pendingTimers: () => timers.size,
  };
}

function createHarness(settings: Partial<WhatsAppOutageAlertSettings> = {}) {
  const clock = createFakeClock();
  const sent: WhatsAppOutageAlert[] = [];
  const alerter = createWhatsAppOutageAlerter({
    settings: {
      alertAfterMs: 10 * MINUTE,
      repeatAfterMs: 6 * HOUR,
      restartContinuityMs: 2 * MINUTE,
      ...settings,
    },
    send: async (alert) => {
      sent.push(alert);
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    formatTime: () => "25 sept, 11:00",
  });
  return { clock, sent, alerter };
}

function offline(extra: Partial<WebChannelStatus> = {}): WebChannelStatus {
  return {
    running: true,
    connected: false,
    reconnectAttempts: 3,
    healthState: "reconnecting",
    lifecycle: "recovering",
    lastError: DNS_ERROR,
    ...extra,
  };
}

function online(): WebChannelStatus {
  return {
    running: true,
    connected: true,
    reconnectAttempts: 0,
    healthState: "healthy",
    lifecycle: "ready",
  };
}

describe("WhatsApp outage alerter (Lumina)", () => {
  it("stays quiet when WhatsApp reconnects inside the grace window", () => {
    const { clock, sent, alerter } = createHarness();

    alerter.observe(
      "default",
      offline({ healthState: "starting", lifecycle: "starting", lastError: null }),
    );
    clock.advance(5 * MINUTE);
    alerter.observe("default", online());
    clock.advance(24 * HOUR);

    expect(sent).toEqual([]);
    expect(clock.pendingTimers()).toBe(0);
  });

  it("alerts once after 10 minutes offline, reminds every 6 hours and reports the recovery", () => {
    const { clock, sent, alerter } = createHarness();

    alerter.observe("default", offline());
    clock.advance(9 * MINUTE);
    alerter.observe("default", offline({ reconnectAttempts: 9 }));
    expect(sent).toEqual([]);

    clock.advance(MINUTE);
    alerter.observe("default", offline({ reconnectAttempts: 12 }));
    expect(sent.map((alert) => alert.kind)).toEqual(["down"]);
    expect(sent[0]?.text).toContain("lleva 10 min sin conexión");
    expect(sent[0]?.text).toContain("ENOTFOUND web.whatsapp.com");

    clock.advance(6 * HOUR);
    expect(sent.map((alert) => alert.kind)).toEqual(["down", "reminder"]);
    expect(sent[1]?.text).toContain("6 h 10 min");

    alerter.observe("default", online());
    expect(sent.map((alert) => alert.kind)).toEqual(["down", "reminder", "recovered"]);
    expect(sent[2]?.text).toContain("volvió a conectarse tras 6 h 10 min");
    expect(clock.pendingTimers()).toBe(0);
  });

  it("alerts immediately, and only once, when the session is logged out", () => {
    const { clock, sent, alerter } = createHarness();
    const loggedOut = offline({
      running: false,
      healthState: "logged-out",
      lifecycle: "blocked",
      terminalDisconnect: true,
    });

    alerter.observe("default", loggedOut);
    alerter.observe("default", loggedOut);
    clock.advance(12 * HOUR);

    expect(sent.map((alert) => alert.kind)).toEqual(["terminal"]);
    expect(sent[0]?.text).toContain("openclaw channels login --channel whatsapp");
  });

  it("treats retry exhaustion without slow retries as terminal", () => {
    const { sent, alerter } = createHarness();

    alerter.observe(
      "default",
      offline({ running: false, healthState: "stopped", lifecycle: "blocked" }),
    );

    expect(sent.map((alert) => alert.kind)).toEqual(["terminal"]);
    expect(sent[0]?.text).toContain("dejó de reintentar");
  });

  it("an operator stop cancels the pending alert and a later start opens a fresh outage", () => {
    const { clock, sent, alerter } = createHarness();

    alerter.observe("default", offline());
    clock.advance(2 * MINUTE);
    alerter.noteMonitorExit("default", { aborted: true });
    clock.advance(HOUR);
    expect(sent).toEqual([]);

    alerter.observe("default", offline({ healthState: "starting", lifecycle: "starting" }));
    clock.advance(9 * MINUTE);
    expect(sent).toEqual([]);
    clock.advance(MINUTE);
    expect(sent.map((alert) => alert.text)).toEqual([expect.stringContaining("lleva 10 min")]);
  });

  it("keeps the original outage clock across a quick monitor restart", () => {
    const { clock, sent, alerter } = createHarness();

    alerter.observe("default", offline());
    clock.advance(6 * MINUTE);
    alerter.noteMonitorExit("default", { aborted: true });
    clock.advance(30_000);
    alerter.observe("default", offline({ healthState: "starting", lifecycle: "starting" }));
    clock.advance(3.5 * MINUTE);

    expect(sent.map((alert) => alert.kind)).toEqual(["down"]);
    expect(sent[0]?.text).toContain("lleva 10 min");
  });

  it("a monitor that ends on its own still alerts if nothing brings it back", () => {
    const { clock, sent, alerter } = createHarness();

    alerter.observe(
      "default",
      offline({ running: false, healthState: "stopped", lifecycle: "stopped" }),
    );
    alerter.noteMonitorExit("default", { aborted: false });
    clock.advance(10 * MINUTE);

    expect(sent.map((alert) => alert.kind)).toEqual(["down"]);
  });

  it("does nothing when alerts are disabled", () => {
    const { clock, sent, alerter } = createHarness({ alertAfterMs: 0 });

    alerter.observe("default", offline());
    alerter.observe(
      "default",
      offline({ running: false, healthState: "logged-out", lifecycle: "blocked" }),
    );
    clock.advance(48 * HOUR);

    expect(sent).toEqual([]);
    expect(clock.pendingTimers()).toBe(0);
  });

  it("sends no reminders when the repeat interval is 0", () => {
    const { clock, sent, alerter } = createHarness({ repeatAfterMs: 0 });

    alerter.observe("default", offline());
    clock.advance(48 * HOUR);

    expect(sent.map((alert) => alert.kind)).toEqual(["down"]);
  });

  it("tracks accounts separately and names non-default ones", () => {
    const { clock, sent, alerter } = createHarness();

    alerter.observe("work", offline());
    alerter.observe("default", offline());
    clock.advance(5 * MINUTE);
    alerter.observe("default", online());
    clock.advance(5 * MINUTE);

    expect(sent.map((alert) => alert.accountId)).toEqual(["work"]);
    expect(sent[0]?.text).toContain("(cuenta work)");
  });

  it("never throws when delivery fails", async () => {
    const clock = createFakeClock();
    const onSendError = vi.fn();
    const alerter = createWhatsAppOutageAlerter({
      settings: { alertAfterMs: MINUTE, repeatAfterMs: 0, restartContinuityMs: MINUTE },
      send: async () => {
        throw new Error("telegram down");
      },
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      onSendError,
    });

    alerter.observe("default", offline());
    expect(() => clock.advance(MINUTE)).not.toThrow();
    await vi.waitFor(() => expect(onSendError).toHaveBeenCalledOnce());
    expect(onSendError.mock.calls[0]?.[1]).toMatchObject({ kind: "down" });
  });
});

describe("Lumina resilience settings", () => {
  it("reads defaults, disables with 0 and ignores invalid values", () => {
    expect(resolveWhatsAppOutageAlertSettings({})).toEqual({
      alertAfterMs: 10 * MINUTE,
      repeatAfterMs: 6 * HOUR,
      restartContinuityMs: 2 * MINUTE,
    });
    expect(
      resolveWhatsAppOutageAlertSettings({
        LUMINA_WHATSAPP_ALERT_AFTER_MS: "0",
        LUMINA_WHATSAPP_ALERT_REPEAT_MS: "abc",
      }),
    ).toMatchObject({ alertAfterMs: 0, repeatAfterMs: 6 * HOUR });
    expect(resolveWhatsAppSlowRetryMs({})).toBe(5 * MINUTE);
    expect(resolveWhatsAppSlowRetryMs({ LUMINA_WHATSAPP_SLOW_RETRY_MS: "0" })).toBe(0);
    expect(resolveWhatsAppSlowRetryMs({ LUMINA_WHATSAPP_SLOW_RETRY_MS: "-5" })).toBe(5 * MINUTE);
  });

  it("formats outage durations in Spanish", () => {
    expect(formatOutageDuration(20_000)).toBe("1 min");
    expect(formatOutageDuration(59 * MINUTE)).toBe("59 min");
    expect(formatOutageDuration(61 * MINUTE)).toBe("1 h 1 min");
    expect(formatOutageDuration(2 * HOUR)).toBe("2 h");
    expect(formatOutageDuration(3 * 24 * HOUR)).toBe("3 días");
  });

  it("explains a session conflict without suggesting a relink", () => {
    const text = buildWhatsAppOutageAlertText({
      kind: "terminal",
      accountId: "default",
      downSince: 0,
      now: MINUTE,
      lastError: "Stream Errored (conflict)",
      healthState: "conflict",
      formatTime: () => "hoy",
    });
    expect(text).toContain("otra sesión de WhatsApp Web");
    expect(text).not.toContain("channels login");
  });
});
