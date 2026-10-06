import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStateStore } from "../shared/state-store.js";
import { EpisodicMemoryStore, type Episode } from "./episodic-memory.js";

let dir = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-episodic-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("EpisodicMemoryStore durable state", () => {
  it("migrates legacy JSONL once and reloads from the keyed store", async () => {
    const legacy = new EpisodicMemoryStore(dir);
    const episode = legacy.remember({ kind: "intent", summary: "seguir LUMINA", tags: ["lumina"] });
    const store = new MemoryStateStore<Episode>();

    const migrated = new EpisodicMemoryStore({ dir, store });
    await migrated.ready;
    await migrated.flush();

    expect(migrated.recall({ tags: ["lumina"] })[0]?.id).toBe(episode.id);
    expect(fs.existsSync(path.join(dir, "episodic.jsonl.migrated"))).toBe(true);

    const restarted = new EpisodicMemoryStore({ dir, store });
    await restarted.ready;
    expect(restarted.recall({ substring: "LUMINA" })[0]?.id).toBe(episode.id);
  });

  it("forgets a session from memory and durable storage", async () => {
    const store = new MemoryStateStore<Episode>();
    const memory = new EpisodicMemoryStore({ dir, store });
    await memory.ready;

    const old = memory.remember({ kind: "note", summary: "old", tags: [] });
    await memory.flush();
    const cutoff = new Date(Date.parse(old.atISO) + 1).toISOString();
    await new Promise((resolve) => {
      setTimeout(resolve, 2);
    });
    memory.remember({ kind: "note", summary: "session secret", tags: ["session"] });
    await memory.flush();

    expect(memory.forgetSince(cutoff)).toBe(1);
    await memory.flush();
    expect(memory.recall({ substring: "session secret" })).toEqual([]);

    const restarted = new EpisodicMemoryStore({ dir, store });
    await restarted.ready;
    expect(restarted.recall({ substring: "session secret" })).toEqual([]);
    expect(restarted.recall({ substring: "old" })).toHaveLength(1);
  });
});
