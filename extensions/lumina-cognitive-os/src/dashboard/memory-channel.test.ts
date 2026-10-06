import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sandbox } from "../evaluation/eval-sandbox.js";
import { EpisodicMemoryStore } from "../memory/episodic-memory.js";
import { MemoryChannelError, memoryCommands, memoryState } from "./memory-channel.js";

const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const setup = () => {
  const episodicDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-memory-"));
  dirs.push(episodicDir);
  const episodic = new EpisodicMemoryStore(episodicDir);
  const { runtime, dir } = sandbox({ now: NOW }, { episodicMemory: episodic });
  dirs.push(dir);
  const audit: string[] = [];
  const commands = memoryCommands(runtime, (action) => audit.push(action));
  return { runtime, episodic, commands, audit };
};

describe("memory channel", () => {
  it("shows every memory with its origin and confidence", async () => {
    const { runtime, episodic } = setup();
    await runtime.ready;
    runtime.lessons.learn({ trigger: "coffee", claim: "Dal drinks coffee at 9", confidence: 0.7 });
    episodic.remember({ kind: "intent", summary: "Dal asked for the news", tags: ["news"] });
    runtime.world.observe({
      id: "cup",
      kind: "object",
      label: "taza",
      confidence: 0.9,
      source: "sensor",
    });
    const memory = memoryState(runtime, NOW);
    expect(memory.lessons[0]).toMatchObject({ claim: "Dal drinks coffee at 9", confidence: 0.7 });
    expect(memory.episodes[0]?.summary).toBe("Dal asked for the news");
    expect(memory.entities.find((e) => e.id === "cup")).toMatchObject({ origin: "sensor" });
    runtime.dispose();
  });

  it("archives, restores, corrects and forgets a lesson; an archived one stops applying", async () => {
    const { runtime, commands, audit } = setup();
    await runtime.ready;
    const lesson = runtime.lessons.learn({ trigger: "coffee", claim: "cold", confidence: 0.7 });
    await commands["lumina.core.memory.lesson"]({ id: lesson.id, action: "archive" });
    expect(runtime.lessons.applicable("coffee")).toHaveLength(0);
    await commands["lumina.core.memory.lesson"]({ id: lesson.id, action: "restore" });
    await commands["lumina.core.memory.lesson"]({ id: lesson.id, action: "contradict" });
    expect(runtime.lessons.get(lesson.id)?.confidence).toBeLessThan(0.7);
    await commands["lumina.core.memory.lesson"]({ id: lesson.id, action: "forget" });
    expect(runtime.lessons.get(lesson.id)).toBeUndefined();
    expect(audit).toEqual([
      "memory.lesson.archive",
      "memory.lesson.restore",
      "memory.lesson.contradict",
      "memory.lesson.forget",
    ]);
    await expect(
      commands["lumina.core.memory.lesson"]({ id: lesson.id, action: "rewrite" }),
    ).rejects.toThrow(MemoryChannelError);
    runtime.dispose();
  });

  it("forgets one episode and merges two entities that are the same thing", async () => {
    const { runtime, episodic, commands } = setup();
    await runtime.ready;
    const episode = episodic.remember({ kind: "intent", summary: "private", tags: [] });
    expect((await commands["lumina.core.memory.episode.forget"]({ id: episode.id })).ok).toBe(true);
    expect(episodic.tail(5)).toHaveLength(0);
    runtime.world.observe({
      id: "mug-a",
      kind: "object",
      label: "taza",
      confidence: 0.9,
      source: "sensor",
    });
    runtime.world.observe({
      id: "mug-b",
      kind: "object",
      label: "taza azul",
      confidence: 0.9,
      source: "sensor",
    });
    const merged = await commands["lumina.core.world.merge"]({ keepId: "mug-a", dropId: "mug-b" });
    expect(merged).toEqual({ ok: true, moved: 1 });
    expect(runtime.world.get("mug-b")).toBeUndefined();
    expect(runtime.world.get("mug-a")?.observations).toBe(2);
    runtime.dispose();
  });
});
