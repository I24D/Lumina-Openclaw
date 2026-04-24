import { describe, expect, it } from "vitest";
import { normalizeProviderId } from "./provider-id.js";

describe("normalizeProviderId", () => {
  it("maps the legacy Lumina desktop provider ID to lumina", () => {
    expect(normalizeProviderId("custom-i24d-whatsapp-ai-onrender-com")).toBe("lumina");
  });
});
