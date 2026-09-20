/** Tests the Lumina guard that keeps internal notices out of contact channels. */
import { describe, expect, it } from "vitest";
import { isExternalContactChannel, resolveContactChannels } from "./contact-channels.js";

const GUARDED = { LUMINA_CONTACT_CHANNELS: "whatsapp" };

describe("resolveContactChannels", () => {
  it("guards nothing while unset, matching upstream behavior", () => {
    expect(resolveContactChannels({}).size).toBe(0);
  });

  it("accepts a comma-separated list", () => {
    const channels = resolveContactChannels({ LUMINA_CONTACT_CHANNELS: "whatsapp, Signal ,sms" });
    expect([...channels]).toEqual(["whatsapp", "signal", "sms"]);
  });

  it("treats an empty value and 'none' as disabled", () => {
    expect(resolveContactChannels({ LUMINA_CONTACT_CHANNELS: "" }).size).toBe(0);
    expect(resolveContactChannels({ LUMINA_CONTACT_CHANNELS: "none" }).size).toBe(0);
  });
});

describe("isExternalContactChannel", () => {
  it("matches a guarded channel in any candidate slot", () => {
    expect(isExternalContactChannel([undefined, "WhatsApp"], GUARDED)).toBe(true);
  });

  it("leaves operator surfaces and unguarded channels alone", () => {
    expect(isExternalContactChannel(["webchat", "cli"], GUARDED)).toBe(false);
    expect(isExternalContactChannel(["discord"], GUARDED)).toBe(false);
  });

  it("ignores blank candidates", () => {
    expect(isExternalContactChannel([undefined, "", "  "], GUARDED)).toBe(false);
  });

  it("stays inert while the guard lists no channel", () => {
    expect(isExternalContactChannel(["whatsapp"], {})).toBe(false);
  });
});
