import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { expect, it } from "vitest";

type SendMessageWhatsApp = typeof import("./send.js").sendMessageWhatsApp;

export function registerWhatsAppSendSafetyTests(params: {
  cfg: OpenClawConfig;
  getSend: () => SendMessageWhatsApp;
  sendComposingTo: unknown;
  sendMessage: unknown;
}): void {
  it("applies the final reasoning safety guard before sending", async () => {
    const result = await params.getSend()(
      "+1555",
      "She's saying the exchange is warm. Let me respond naturally.\n\nTodo esta bien.",
      { verbose: false, cfg: params.cfg },
    );

    expect(result).toEqual({ messageId: "msg123", toJid: "1555@s.whatsapp.net" });
    expect(params.sendMessage).toHaveBeenCalledWith(
      "+1555",
      "Todo esta bien.",
      undefined,
      undefined,
    );
  });

  it("does not send inseparable internal reasoning", async () => {
    const result = await params.getSend()(
      "+1555",
      "The user is asking about the exchange. I need to re-examine it before replying.",
      { verbose: false, cfg: params.cfg },
    );

    expect(result).toEqual({ messageId: "", toJid: "1555@s.whatsapp.net" });
    expect(params.sendComposingTo).not.toHaveBeenCalled();
    expect(params.sendMessage).not.toHaveBeenCalled();
  });
}
