// Whatsapp tests cover outbound reasoning leak protection.
import { describe, expect, it } from "vitest";
import { sanitizeWhatsAppOutboundText } from "./outbound-safety.js";

describe("sanitizeWhatsAppOutboundText", () => {
  it("keeps only the final answer after an internal conversation analysis", () => {
    const result = sanitizeWhatsAppOutboundText(
      "She's saying that they get along well and is being sweet. " +
        "This is a warm moment. Let me respond naturally.\n\n" +
        "Claro que si, nos llevamos bien.",
    );

    expect(result).toEqual({
      action: "send",
      text: "Claro que si, nos llevamos bien.",
      filtered: true,
    });
  });

  it("keeps a multi-paragraph final answer after a reasoning prefix", () => {
    const result = sanitizeWhatsAppOutboundText(
      "Now I have more context. Let me keep the response warm and short.\n\n" +
        "Si, todo esta bien.\n\nGracias por preguntar.",
    );

    expect(result).toEqual({
      action: "send",
      text: "Si, todo esta bien.\n\nGracias por preguntar.",
      filtered: true,
    });
  });

  it("keeps only the final answer after Spanish contact analysis", () => {
    const result = sanitizeWhatsAppOutboundText(
      'El contacto es "\u{1F497}." - relaci\u00f3n desconocida, tono casual biling\u00fce. ' +
        'Dijo solo "Si". Es tarde (23:34). Respuesta corta y casual.\n\n' +
        "ok dale \u{1F44D}",
    );

    expect(result).toEqual({
      action: "send",
      text: "ok dale \u{1F44D}",
      filtered: true,
    });
  });

  it("drops operator-facing narration about tools, bridges and the contact", () => {
    const result = sanitizeWhatsAppOutboundText(
      "Neither WhatsApp nor Phone Link bridges are available right now. I cannot send the " +
        'reply. The contact sent just "?" — a new unknown contact. I\'ve archived the ' +
        "message and created a profile. Since I can't reach Dal via Telegram from this agent " +
        "either, and the bridges are down, I should note this situation.\n\n" +
        "Hola, ¿en qué puedo ayudarte? \u{1F60A}",
    );

    expect(result).toEqual({
      action: "send",
      text: "Hola, ¿en qué puedo ayudarte? \u{1F60A}",
      filtered: true,
    });
  });

  it("suppresses operator narration that has no reply for the contact", () => {
    expect(
      sanitizeWhatsAppOutboundText(
        "I don't have a direct Telegram send tool in this agent's toolset. The AGENTS.md says to notify Dal.",
      ),
    ).toEqual({ action: "suppress" });
    expect(
      sanitizeWhatsAppOutboundText(
        "El contacto envió un mensaje corto. Archivé el mensaje y no puedo enviar la respuesta.",
      ),
    ).toEqual({ action: "suppress" });
  });

  it("keeps ordinary replies that mention people or plans", () => {
    for (const text of [
      "Claro, mañana le digo a Dal que te llame.",
      "Hola! Si, el contacto de la tienda es el mismo de siempre.",
      "I can send you the photos tomorrow.",
    ]) {
      expect(sanitizeWhatsAppOutboundText(text)).toEqual({ action: "send", text, filtered: false });
    }
  });

  it("suppresses recognized internal reasoning without a separable answer", () => {
    expect(
      sanitizeWhatsAppOutboundText(
        "The user is asking about the conversation. I need to re-examine it before replying.",
      ),
    ).toEqual({ action: "suppress" });
  });

  it("suppresses the silent reply token", () => {
    expect(sanitizeWhatsAppOutboundText("  NO_REPLY  ")).toEqual({ action: "suppress" });
  });

  it("suppresses a deliberation leak that ends in the silent reply token", () => {
    expect(
      sanitizeWhatsAppOutboundText(
        "Wait - I need to look at this more carefully before replying.\nNO_REPLY",
      ),
    ).toEqual({ action: "suppress" });
  });

  it("suppresses deliberation even after another normalizer removes its silent token", () => {
    expect(
      sanitizeWhatsAppOutboundText(
        "Hold on, I should re-examine the conversation before I respond naturally.",
      ),
    ).toEqual({ action: "suppress" });
  });

  it.each([
    "D\u00e9jame buscar a este contacto y archivar el mensaje correctamente.",
    "Primero, perm\u00edteme archivar este mensaje y verificar el contacto.",
  ])("suppresses Spanish work narration: %s", (text) => {
    expect(sanitizeWhatsAppOutboundText(text)).toEqual({ action: "suppress" });
  });

  it("does not alter normal multi-paragraph responses", () => {
    const text = "Claro, puedo ayudarte.\n\nEstos son los siguientes pasos.";
    expect(sanitizeWhatsAppOutboundText(text)).toEqual({
      action: "send",
      text,
      filtered: false,
    });
  });

  it("does not treat a normal offer to help as internal reasoning", () => {
    const text = "Let me know when you are ready and I will check it with you.";
    expect(sanitizeWhatsAppOutboundText(text)).toEqual({
      action: "send",
      text,
      filtered: false,
    });
  });

  const contactEnv = { LUMINA_CONTACT_CHANNELS: "whatsapp" };

  it.each([
    "⚠️ API provider returned a billing error — your API key has run out of credits or has an insufficient balance. Check your provider's billing dashboard and top up or switch to a different API key.",
    "⚠️ Something went wrong while processing your request. Please try again, or use /new to start a fresh session.",
    "⚠️ API rate limit reached. Please try again later.",
    "↪️ Model Fallback: google/gemini-3.6-flash (selected ollama-cloud/gemma4:31b; rate limit)",
    "OpenClaw couldn't produce or deliver a reply. Reference: run-1",
  ])("never sends OpenClaw runtime copy to a contact: %s", (text) => {
    expect(sanitizeWhatsAppOutboundText(text, contactEnv)).toEqual({ action: "suppress" });
  });

  it("keeps a warning-led reply that is ordinary Spanish", () => {
    const text = "⚠️ Ojo, mañana cierran la carretera por la lluvia.";
    expect(sanitizeWhatsAppOutboundText(text, contactEnv)).toEqual({
      action: "send",
      text,
      filtered: false,
    });
  });

  it("leaves runtime copy alone when WhatsApp is not a contact channel", () => {
    const text = "⚠️ API rate limit reached. Please try again later.";
    expect(sanitizeWhatsAppOutboundText(text, {})).toEqual({
      action: "send",
      text,
      filtered: false,
    });
  });
});
