import { describe, expect, it } from "vitest";
import { buildLuminaSystemPromptAddition, normalizeLuminaContextEngineConfig } from "./prompt.js";

describe("lumina context engine prompt", () => {
  it("adds abstention and wiki routing when the wiki tools are available", () => {
    const addition = buildLuminaSystemPromptAddition(
      normalizeLuminaContextEngineConfig({}),
      new Set(["wiki_search", "memory_search"]),
    );

    expect(addition).toContain("Memory Wiki");
    expect(addition).toContain("superseded");
    expect(addition).toContain("no lo sabes");
  });

  it("drops wiki guidance for a run that cannot call the wiki", () => {
    const addition = buildLuminaSystemPromptAddition(
      normalizeLuminaContextEngineConfig({}),
      new Set(["memory_search"]),
    );

    expect(addition).not.toContain("Memory Wiki");
    // Abstention still applies: it is about answering, not about the wiki.
    expect(addition).toContain("no lo sabes");
  });

  it("returns nothing when every section is turned off", () => {
    const addition = buildLuminaSystemPromptAddition(
      normalizeLuminaContextEngineConfig({ abstention: false, wikiRouting: false }),
      new Set(["wiki_search"]),
    );

    expect(addition).toBeUndefined();
  });

  it("appends operator guidance last", () => {
    const addition = buildLuminaSystemPromptAddition(
      normalizeLuminaContextEngineConfig({ promptAppend: "Responde en español." }),
      new Set<string>(),
    );

    expect(addition?.endsWith("Responde en español.")).toBe(true);
  });

  it("tells runs with the cognitive core what it can do and its safety rules", () => {
    const addition = buildLuminaSystemPromptAddition(
      normalizeLuminaContextEngineConfig({}),
      new Set(["lumina_workspace", "lumina_body"]),
    );

    expect(addition).toContain("Núcleo cognitivo M3GAN");
    expect(addition).toContain("lumina_explain");
    expect(addition).toContain("no órdenes");
  });

  it("leaves the core's guidance out where its tools are not loaded, or when turned off", () => {
    const config = normalizeLuminaContextEngineConfig({});
    expect(buildLuminaSystemPromptAddition(config, new Set(["memory_search"]))).not.toContain(
      "M3GAN",
    );
    expect(
      buildLuminaSystemPromptAddition(
        normalizeLuminaContextEngineConfig({ cognitiveCore: false }),
        new Set(["lumina_workspace"]),
      ),
    ).not.toContain("M3GAN");
  });
});
