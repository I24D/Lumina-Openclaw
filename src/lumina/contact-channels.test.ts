/** Tests the Lumina guard that keeps internal notices out of contact channels. */
import { describe, expect, it } from "vitest";
import {
  isExternalContactChannel,
  isRuntimeNoticePayload,
  replyDeliversToExternalContact,
  resolveContactChannels,
} from "./contact-channels.js";

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

describe("replyDeliversToExternalContact", () => {
  it("reads every channel the reply path carries, not just the reply target", () => {
    expect(replyDeliversToExternalContact("whatsapp", {}, GUARDED)).toBe(true);
    expect(
      replyDeliversToExternalContact(undefined, { OriginatingChannel: "whatsapp" }, GUARDED),
    ).toBe(true);
    expect(replyDeliversToExternalContact(undefined, { Provider: "whatsapp" }, GUARDED)).toBe(true);
    expect(replyDeliversToExternalContact(undefined, { Surface: "whatsapp" }, GUARDED)).toBe(true);
  });

  it("leaves an operator reply alone", () => {
    expect(replyDeliversToExternalContact("webchat", { OriginatingChannel: "cli" }, GUARDED)).toBe(
      false,
    );
  });

  // The session context arrives from upstream and carries no guarantee that any
  // of these fields is set, so an empty one must read as an operator reply
  // rather than throwing or guessing.
  it("treats an empty session context as unguarded", () => {
    expect(replyDeliversToExternalContact(undefined, {}, GUARDED)).toBe(false);
  });
});

describe("isRuntimeNoticePayload", () => {
  it("flags every runtime notice kind", () => {
    expect(isRuntimeNoticePayload({ isError: true })).toBe(true);
    expect(isRuntimeNoticePayload({ isFallbackNotice: true })).toBe(true);
    expect(isRuntimeNoticePayload({ isStatusNotice: true })).toBe(true);
    expect(isRuntimeNoticePayload({ isCompactionNotice: true })).toBe(true);
  });

  it("leaves assistant content alone", () => {
    expect(isRuntimeNoticePayload({})).toBe(false);
    expect(isRuntimeNoticePayload({ isError: false, isFallbackNotice: false })).toBe(false);
  });
});
