// Lumina fork tests: delivery of WhatsApp outage alerts to the operator.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { buildAgentMainSessionKey } from "openclaw/plugin-sdk/routing";
import { describe, expect, it, vi } from "vitest";
import type { WhatsAppOutageAlert } from "./lumina-resilience.js";
import {
  resolveWhatsAppOutageAlertAgentId,
  resolveWhatsAppOutageAlertTarget,
  sendWhatsAppOutageAlert,
} from "./lumina-resilience.runtime.js";

const OWNER = "7054043436";

function configWithTelegram(telegram: Record<string, unknown> | undefined): OpenClawConfig {
  return { channels: telegram ? { telegram } : {} } as OpenClawConfig;
}

const personalBot = configWithTelegram({ enabled: true, allowFrom: [Number(OWNER)] });

const alert: WhatsAppOutageAlert = {
  kind: "down",
  accountId: "default",
  text: "⚠️ WhatsApp de Lumina lleva 10 min sin conexión",
  downSince: 0,
  at: 600_000,
};

describe("WhatsApp outage alert target (Lumina)", () => {
  it("defaults to the single allowlisted Telegram user", () => {
    expect(resolveWhatsAppOutageAlertTarget(personalBot, {})).toEqual({
      channel: "telegram",
      to: OWNER,
    });
  });

  it("honors an explicit chat and lets the operator turn Telegram off", () => {
    expect(
      resolveWhatsAppOutageAlertTarget(personalBot, {
        LUMINA_WHATSAPP_ALERT_TELEGRAM_TO: "-100123",
      }),
    ).toEqual({
      channel: "telegram",
      to: "-100123",
    });
    expect(
      resolveWhatsAppOutageAlertTarget(personalBot, { LUMINA_WHATSAPP_ALERT_TELEGRAM_TO: "none" }),
    ).toBeNull();
  });

  it("does not guess when the owner is ambiguous or Telegram is off", () => {
    expect(
      resolveWhatsAppOutageAlertTarget(configWithTelegram({ allowFrom: [1, 2] }), {}),
    ).toBeNull();
    expect(
      resolveWhatsAppOutageAlertTarget(configWithTelegram({ allowFrom: ["@dal"] }), {}),
    ).toBeNull();
    expect(
      resolveWhatsAppOutageAlertTarget(configWithTelegram({ enabled: false, allowFrom: [1] }), {}),
    ).toBeNull();
    expect(resolveWhatsAppOutageAlertTarget(configWithTelegram(undefined), {})).toBeNull();
  });

  it("routes the alert through the main agent unless configured otherwise", () => {
    expect(resolveWhatsAppOutageAlertAgentId({})).toBe("main");
    expect(resolveWhatsAppOutageAlertAgentId({ LUMINA_WHATSAPP_ALERT_AGENT: "telegram" })).toBe(
      "telegram",
    );
  });
});

describe("sendWhatsAppOutageAlert (Lumina)", () => {
  function createDeps(env: NodeJS.ProcessEnv = {}) {
    return {
      getConfig: () => personalBot,
      enqueueEvent: vi.fn(() => true),
      send: vi.fn(async () => ({ status: "sent" }) as never),
      env,
    };
  }

  it("tells the main agent and sends the alert to Telegram on its behalf", async () => {
    const deps = createDeps();

    await expect(sendWhatsAppOutageAlert(alert, deps)).resolves.toBe("sent");

    expect(deps.enqueueEvent).toHaveBeenCalledWith(alert.text, {
      agentId: "main",
      sessionKey: buildAgentMainSessionKey({ agentId: "main" }),
    });
    expect(deps.send).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: OWNER,
        payloads: [{ text: alert.text }],
        durability: "required",
        session: expect.objectContaining({ agentId: "main" }),
      }),
    );
  });

  it("still informs the agent when there is no Telegram target", async () => {
    const deps = createDeps({ LUMINA_WHATSAPP_ALERT_TELEGRAM_TO: "none" });

    await expect(sendWhatsAppOutageAlert(alert, deps)).resolves.toBe("no-target");

    expect(deps.enqueueEvent).toHaveBeenCalledOnce();
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("sends even if the system event cannot be queued, and never throws on delivery failure", async () => {
    const deps = createDeps();
    deps.enqueueEvent.mockImplementation(() => {
      throw new Error("no session store");
    });
    await expect(sendWhatsAppOutageAlert(alert, deps)).resolves.toBe("sent");

    deps.send.mockRejectedValueOnce(new Error("telegram unreachable"));
    await expect(sendWhatsAppOutageAlert(alert, deps)).resolves.toBe("failed");

    deps.send.mockResolvedValueOnce({ status: "failed" } as never);
    await expect(sendWhatsAppOutageAlert(alert, deps)).resolves.toBe("failed");
  });
});
