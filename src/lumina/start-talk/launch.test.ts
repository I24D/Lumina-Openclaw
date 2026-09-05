import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { luminaStartTalkAvailability } from "./launch.js";

const INTERPRETER =
  process.platform === "win32" ? [".venv", "Scripts", "pythonw.exe"] : [".venv", "bin", "python3"];

describe("lumina start talk availability", () => {
  let root: string;
  let previousDir: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lumina-start-talk-"));
    previousDir = process.env.LUMINA_START_TALK_DIR;
    process.env.LUMINA_START_TALK_DIR = root;
  });

  afterEach(() => {
    if (previousDir === undefined) {
      delete process.env.LUMINA_START_TALK_DIR;
    } else {
      process.env.LUMINA_START_TALK_DIR = previousDir;
    }
    rmSync(root, { force: true, recursive: true });
  });

  it("reports the install once entry point and virtualenv are both present", () => {
    writeFileSync(join(root, "main.py"), "");
    mkdirSync(join(root, ...INTERPRETER.slice(0, -1)), { recursive: true });
    writeFileSync(join(root, ...INTERPRETER), "");
    expect(luminaStartTalkAvailability()).toEqual({ available: true });
  });

  it("stays unavailable without a virtualenv, so the composer keeps its fallback", () => {
    writeFileSync(join(root, "main.py"), "");
    const availability = luminaStartTalkAvailability();
    expect(availability.available).toBe(false);
    expect(availability.reason).toContain("virtualenv");
  });

  it("names the missing directory rather than failing silently", () => {
    process.env.LUMINA_START_TALK_DIR = join(root, "absent");
    const availability = luminaStartTalkAvailability();
    expect(availability.available).toBe(false);
    expect(availability.reason).toContain("not installed");
  });
});
