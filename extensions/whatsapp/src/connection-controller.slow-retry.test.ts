// Lumina fork tests: the WhatsApp connection controller keeps retrying slowly instead of giving up.
import { describe, expect, it } from "vitest";
import { WhatsAppConnectionController } from "./connection-controller.js";

describe("WhatsAppConnectionController slow retries (Lumina)", () => {
  function createRetryController(params: {
    slowRetryMs?: number;
    isNonRetryableStatus?: (statusCode: unknown) => boolean;
  }) {
    return new WhatsAppConnectionController({
      accountId: "work",
      authDir: "/tmp/wa-auth",
      verbose: false,
      keepAlive: false,
      heartbeatSeconds: 30,
      transportTimeoutMs: 60_000,
      messageTimeoutMs: 60_000,
      watchdogCheckMs: 5_000,
      reconnectPolicy: {
        initialMs: 250,
        maxMs: 1_000,
        factor: 2,
        jitter: 0,
        maxAttempts: 3,
        ...(params.slowRetryMs ? { slowRetryMs: params.slowRetryMs } : {}),
      },
      ...(params.isNonRetryableStatus ? { isNonRetryableStatus: params.isNonRetryableStatus } : {}),
    });
  }

  it("keeps upstream's give-up behavior without slowRetryMs", () => {
    const retryController = createRetryController({});

    expect(retryController.consumeReconnectAttempt().action).toBe("retry");
    expect(retryController.consumeReconnectAttempt().action).toBe("retry");
    expect(retryController.consumeReconnectAttempt()).toMatchObject({
      action: "stop",
      healthState: "stopped",
      reconnectAttempts: 3,
    });
  });

  it("switches to slow retries once the fast ladder is spent instead of stopping", () => {
    const retryController = createRetryController({ slowRetryMs: 300_000 });

    const decisions = Array.from({ length: 8 }, () => retryController.consumeReconnectAttempt());

    expect(decisions.map((decision) => decision.action)).toEqual(Array(8).fill("retry"));
    expect(decisions.slice(0, 2).map((decision) => decision.delayMs)).toEqual([250, 500]);
    for (const decision of decisions.slice(2)) {
      expect(decision).toMatchObject({ delayMs: 300_000, healthState: "reconnecting" });
    }
  });

  it("retries a DNS failure during setup (Baileys status 408) past maxAttempts", () => {
    const retryController = createRetryController({ slowRetryMs: 300_000 });
    const enotfound = {
      output: { statusCode: 408 },
      message: "getaddrinfo ENOTFOUND web.whatsapp.com",
    };

    for (let attempt = 1; attempt <= 6; attempt += 1) {
      expect(retryController.resolveSetupErrorDecision(enotfound)).toMatchObject({
        action: "retry",
        healthState: "reconnecting",
        reconnectAttempts: attempt,
      });
    }
  });

  it("still stops on logged-out and session-conflict closes", () => {
    const retryController = createRetryController({
      slowRetryMs: 300_000,
      isNonRetryableStatus: (statusCode) => statusCode === 440,
    });

    expect(retryController.resolveCloseDecision({ status: 401, isLoggedOut: true })).toMatchObject({
      action: "stop",
      healthState: "logged-out",
    });
    expect(retryController.resolveCloseDecision({ status: 440, isLoggedOut: false })).toMatchObject(
      {
        action: "stop",
        healthState: "conflict",
      },
    );
  });
});
