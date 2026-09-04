/**
 * Tests for persistent goals and their ranking.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GoalManager } from "./goal-manager.js";

let dir = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-goals-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const HOUR = 3_600_000;

describe("GoalManager", () => {
  it("rejects an empty title", () => {
    const m = new GoalManager(dir);
    expect(() => m.create({ title: "   " })).toThrow(/title/i);
  });

  it("clamps priority into 1..5", () => {
    const m = new GoalManager(dir);
    expect(m.create({ title: "low", priority: -4 }).priority).toBe(1);
    expect(m.create({ title: "high", priority: 99 }).priority).toBe(5);
    expect(m.create({ title: "default" }).priority).toBe(3);
  });

  it("survives a restart, which is the entire point", () => {
    const first = new GoalManager(dir);
    const created = first.create({
      title: "Rotate the Telegram bot token",
      priority: 4,
      successConditions: ["audit reports 0 plaintext for telegram"],
    });

    const second = new GoalManager(dir);
    const reloaded = second.get(created.id);
    expect(reloaded?.title).toBe("Rotate the Telegram bot token");
    expect(reloaded?.priority).toBe(4);
    expect(reloaded?.successConditions).toEqual(["audit reports 0 plaintext for telegram"]);
  });

  it("persists status changes across instances", () => {
    const first = new GoalManager(dir);
    const g = first.create({ title: "ship cognitive core" });
    first.complete(g.id);
    expect(first.open()).toHaveLength(0);

    const second = new GoalManager(dir);
    expect(second.get(g.id)?.status).toBe("done");
    expect(second.open()).toHaveLength(0);
  });

  it("returns undefined when updating an unknown goal", () => {
    const m = new GoalManager(dir);
    expect(m.update("nope", { status: "done" })).toBeUndefined();
  });

  it("ranks an overdue goal above a comfortable one", () => {
    const now = Date.parse("2026-09-01T12:00:00.000Z");
    const m = new GoalManager(dir);
    m.create({ title: "relaxed", priority: 3 }, new Date(now).toISOString());
    const urgent = m.create(
      {
        title: "overdue",
        priority: 3,
        deadlineISO: new Date(now - HOUR).toISOString(),
      },
      new Date(now).toISOString(),
    );
    expect(m.next(now)?.goal.id).toBe(urgent.id);
    expect(m.next(now)?.reason).toContain("overdue");
  });

  it("ranks higher priority first when deadlines match", () => {
    const now = Date.parse("2026-09-01T12:00:00.000Z");
    const iso = new Date(now).toISOString();
    const m = new GoalManager(dir);
    m.create({ title: "minor", priority: 1 }, iso);
    const major = m.create({ title: "major", priority: 5 }, iso);
    expect(m.next(now)?.goal.id).toBe(major.id);
  });

  it("lets a stale goal climb so nothing starves", () => {
    const now = Date.parse("2026-09-01T12:00:00.000Z");
    const m = new GoalManager(dir);
    const old = m.create(
      { title: "old", priority: 2 },
      new Date(now - 30 * 86_400_000).toISOString(),
    );
    m.update(old.id, {}, new Date(now - 30 * 86_400_000).toISOString());
    const fresh = m.create({ title: "fresh", priority: 2 }, new Date(now).toISOString());
    const ranked = m.rank(now);
    const oldScore = ranked.find((r) => r.goal.id === old.id)?.score ?? 0;
    const freshScore = ranked.find((r) => r.goal.id === fresh.id)?.score ?? 0;
    expect(oldScore).toBeGreaterThan(freshScore);
  });

  it("has nothing to do when every goal is closed", () => {
    const m = new GoalManager(dir);
    const g = m.create({ title: "only" });
    m.abandon(g.id);
    expect(m.next()).toBeUndefined();
  });
});
