/**
 * planner.tool-registry.test.ts — Contract test: KNOWN_TOOLS ↔ real tools registered
 *
 * The action planner (Nivel 4) validates that every `toolName` in a proposed
 * plan is a known Lumina tool. `KNOWN_TOOLS` in `planner.ts` is the source of
 * truth. This test guarantees the set stays in sync with the tools each
 * Lumina extension actually registers.
 *
 * When you add a new tool to any lumina-* extension, register it in
 * KNOWN_TOOLS *at the same commit* — this test will fail otherwise.
 *
 * Scope: every lumina-* extension in this checkout, discovered from disk so a
 * new one is covered the day it lands.
 */
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { KNOWN_TOOLS } from "./planner.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSIONS_ROOT = path.resolve(HERE, "..", "..", "..");

async function luminaExtensions(): Promise<string[]> {
  const entries = await readdir(EXTENSIONS_ROOT, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("lumina-"))
    .map((entry) => entry.name)
    .toSorted();
}

/**
 * Walk one Lumina extension's src/ tree and collect every string literal that
 * looks like a tool name declared as `name: "lumina_*"`. We restrict to the
 * `name:` property to avoid false positives (comments, other identifiers).
 */
async function collectDeclaredToolNames(extensionDir: string): Promise<Set<string>> {
  const out = new Set<string>();
  const srcDir = path.join(extensionDir, "src");

  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
        continue;
      }
      const text = readFileSync(full, "utf8");
      // Match declared tool names: `name: "lumina_xyz"` inside object literals.
      const declPattern = /name:\s*"(lumina_[a-z0-9_]+)"/g;
      for (const match of text.matchAll(declPattern)) {
        out.add(match[1]!);
      }
    }
  }

  await walk(srcDir);
  return out;
}

async function collectAllLuminaToolNames(): Promise<Map<string, string>> {
  // toolName → which extension declared it
  const toolOwners = new Map<string, string>();
  for (const ext of await luminaExtensions()) {
    const extDir = path.join(EXTENSIONS_ROOT, ext);
    const declared = await collectDeclaredToolNames(extDir);
    for (const name of declared) {
      const existing = toolOwners.get(name);
      if (existing && existing !== ext) {
        // Duplicate registration across extensions — assert-worthy.
        toolOwners.set(name, `${existing}+${ext}`);
      } else {
        toolOwners.set(name, ext);
      }
    }
  }
  return toolOwners;
}

describe("action planner KNOWN_TOOLS contract", () => {
  it("covers the Lumina extensions in this checkout", async () => {
    expect(await luminaExtensions()).toContain("lumina-cognitive-os");
  });

  it("has every declared lumina_* tool from every Lumina extension", async () => {
    const declared = await collectAllLuminaToolNames();
    // Filter: some `name: "lumina_..."` matches are inline object schemas
    // (parameter objects, sub-fields, etc.) rather than tool declarations.
    // We only care about entries that look like tool root names (no dots or
    // dashes). All valid tool names use lowercase snake_case starting with
    // `lumina_`.
    const missing: string[] = [];
    for (const [tool, owner] of declared.entries()) {
      if (!KNOWN_TOOLS.has(tool)) {
        missing.push(`${tool}  (declared by ${owner})`);
      }
    }
    expect(
      missing,
      `Tools declared in a lumina-* extension but missing from planner KNOWN_TOOLS:\n  ${missing.join("\n  ")}`,
    ).toHaveLength(0);
  });

  it("does not accept a plan that references a fake tool", () => {
    // Sanity: the validator still rejects unknown tools even after our merge.
    // If this ever passes with a fake name, the KNOWN_TOOLS check is
    // silently permissive somewhere.
    expect(KNOWN_TOOLS.has("lumina_totally_made_up_tool_xyz")).toBe(false);
  });

  it("flags any tool registered by more than one lumina-* extension", async () => {
    const declared = await collectAllLuminaToolNames();
    // Two plugins declaring one name collide at load time; one owner per tool.
    const duplicates = [...declared.entries()].filter(([, owner]) => owner.includes("+"));
    expect(
      duplicates,
      `Duplicate tool registrations:\n  ${duplicates.map(([n, o]) => `${n} in ${o}`).join("\n  ")}`,
    ).toHaveLength(0);
  });
});
