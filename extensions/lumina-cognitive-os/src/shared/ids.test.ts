/**
 * Tests for persistent identifiers.
 */
import { describe, expect, it } from "vitest";
import { idTimeMs, newEntityId, ulid } from "./ids.js";

describe("ulid", () => {
  it("is 26 Crockford base32 characters", () => {
    expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
  });

  it("sorts in creation order, even within one millisecond", () => {
    const t = Date.parse("2026-10-04T12:00:00.000Z");
    const burst = Array.from({ length: 50 }, () => ulid(t));
    expect(burst.toSorted()).toEqual(burst);
    expect(new Set(burst).size).toBe(50);
    expect(ulid(t + 1) > (burst.at(-1) as string)).toBe(true);
  });
});

describe("newEntityId", () => {
  it("prefixes the kind and never contains the visible name", () => {
    const id = newEntityId("person");
    expect(id).toMatch(/^person_[0-9A-HJKMNP-TV-Z]{26}$/u);
  });

  it("refuses prefixes that would not survive in an id", () => {
    expect(() => newEntityId("Person Dal")).toThrow(/Invalid id prefix/);
  });

  it("encodes the creation time", () => {
    const t = Date.parse("2026-10-04T20:41:00.000Z");
    expect(idTimeMs(newEntityId("object", t))).toBe(t);
    expect(idTimeMs("kitchen")).toBeUndefined();
  });
});
