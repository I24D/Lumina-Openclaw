/**
 * Tests for the persistent lesson ledger.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LessonStore } from "./lessons.js";

let dir = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-lessons-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("LessonStore", () => {
  it("requires both a trigger and a claim", () => {
    const s = new LessonStore(dir);
    expect(() => s.learn({ trigger: " ", claim: "x" })).toThrow();
    expect(() => s.learn({ trigger: "disk.low", claim: "  " })).toThrow();
  });

  it("persists lessons across restarts", () => {
    const first = new LessonStore(dir);
    first.learn({ trigger: "disk.low", claim: "clearing %TEMP% recovers space" });
    const second = new LessonStore(dir);
    expect(second.list("disk.low")).toHaveLength(1);
  });

  it("confirms instead of duplicating an identical claim", () => {
    const s = new LessonStore(dir);
    const a = s.learn({ trigger: "disk.low", claim: "same claim" });
    const b = s.learn({ trigger: "disk.low", claim: "same claim" });
    expect(b.id).toBe(a.id);
    expect(s.list()).toHaveLength(1);
    expect(b.confirmations).toBe(1);
    expect(b.confidence).toBeGreaterThan(a.confidence);
  });

  it("moves confidence with evidence and clamps at the ends", () => {
    const s = new LessonStore(dir);
    const l = s.learn({ trigger: "cpu.high", claim: "it is the indexer", confidence: 0.5 });
    for (let i = 0; i < 20; i += 1) {
      s.confirm(l.id);
    }
    expect(s.get(l.id)?.confidence).toBe(1);
    for (let i = 0; i < 40; i += 1) {
      s.contradict(l.id);
    }
    expect(s.get(l.id)?.confidence).toBe(0);
  });

  it("drops discredited lessons out of the applicable set", () => {
    const s = new LessonStore(dir);
    const good = s.learn({ trigger: "disk.low", claim: "good", confidence: 0.9 });
    const bad = s.learn({ trigger: "disk.low", claim: "bad", confidence: 0.2 });
    const applicable = s.applicable("disk.low");
    expect(applicable.map((l) => l.id)).toEqual([good.id]);
    expect(applicable.map((l) => l.id)).not.toContain(bad.id);
  });

  it("returns undefined when adjusting an unknown lesson", () => {
    const s = new LessonStore(dir);
    expect(s.confirm("nope")).toBeUndefined();
    expect(s.contradict("nope")).toBeUndefined();
  });

  it("orders applicable lessons by confidence", () => {
    const s = new LessonStore(dir);
    s.learn({ trigger: "ram.high", claim: "low", confidence: 0.6 });
    s.learn({ trigger: "ram.high", claim: "high", confidence: 0.95 });
    expect(s.applicable("ram.high")[0].claim).toBe("high");
  });
});
