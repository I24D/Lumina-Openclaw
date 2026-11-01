import { describe, expect, it } from "vitest";
import { AuditLog } from "./audit-log.js";
import { CHILD_REDIRECT, createChildGuard, screenForChild } from "./child-guard.js";
import type { InteractionMode } from "./interaction-mode.js";

describe("child guard", () => {
  it("screens whole words in English and Spanish, ignoring case and accents", () => {
    expect(screenForChild("Esto es una MIERDA")).toEqual(["profanity"]);
    expect(screenForChild("habla de Pornografía y de cocaína")).toEqual(["sexual", "drugs"]);
    expect(screenForChild("never kill yourself")).toEqual(["self-harm"]);
    // Whole words only: these must not match.
    expect(screenForChild("Sussex, Essex y la clase de sextantes")).toEqual([]);
    expect(screenForChild("un cono de helado y una taza")).toEqual([]);
  });

  it("acts only in child mode: rewrite first, replace on the way out, both audited", () => {
    let mode: InteractionMode = "normal";
    const audit = new AuditLog();
    const guard = createChildGuard({ mode: () => mode, audit });
    expect(guard.systemContext()).toBeUndefined();
    expect(guard.revise("qué mierda")).toBeUndefined();
    expect(guard.outgoing("qué mierda")).toBeUndefined();

    mode = "child";
    expect(guard.systemContext()).toContain("Child mode");
    expect(guard.revise("Los dinosaurios eran enormes.")).toBeUndefined();
    expect(guard.revise("qué mierda")).toContain("Rewrite it for a child");
    expect(guard.outgoing("qué mierda")).toBe(CHILD_REDIRECT);
    expect(audit.recent(5).map((r) => r.action)).toEqual([
      "child.filter.replace",
      "child.filter.revise",
    ]);
  });

  it("carries the guidance of any non-normal mode into the prompt", () => {
    const guard = createChildGuard({ mode: () => "maintenance", audit: new AuditLog() });
    expect(guard.systemContext()).toContain("Maintenance mode");
    expect(guard.outgoing("mierda")).toBeUndefined();
  });
});
