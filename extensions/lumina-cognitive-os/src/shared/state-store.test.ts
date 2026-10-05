/**
 * Tests for the keyed log over the durable store port.
 */
import { describe, expect, it, vi } from "vitest";
import {
  DeferredStateStore,
  KeyedLog,
  MemoryStateStore,
  seqKey,
  type StateStorePort,
} from "./state-store.js";

describe("seqKey", () => {
  it("pads so lexical order is numeric order", () => {
    expect([seqKey(10), seqKey(9), seqKey(100)].toSorted()).toEqual([
      seqKey(9),
      seqKey(10),
      seqKey(100),
    ]);
  });
});

describe("KeyedLog", () => {
  it("appends in order and continues after what earlier processes stored", async () => {
    const store = new MemoryStateStore<string>();
    const first = new KeyedLog(store);
    first.append("a");
    first.append("b");
    await first.flush();

    const second = new KeyedLog(store);
    expect(await second.hydrate()).toEqual(["a", "b"]);
    second.append("c");
    await second.flush();
    expect(await new KeyedLog(store).hydrate()).toEqual(["a", "b", "c"]);
  });

  it("removes matching entries for real", async () => {
    const store = new MemoryStateStore<string>();
    const log = new KeyedLog(store);
    for (const v of ["keep", "drop", "keep"]) {
      log.append(v);
    }
    expect(await log.remove((v) => v === "drop")).toBe(1);
    expect(await new KeyedLog(store).hydrate()).toEqual(["keep", "keep"]);
  });

  it("never writes when the stored tail could not be read", async () => {
    const register = vi.fn(async () => undefined);
    const broken: StateStorePort<string> = {
      register,
      lookup: async () => undefined,
      delete: async () => false,
      entries: async () => {
        throw new Error("sqlite unavailable");
      },
    };
    const onError = vi.fn();
    const log = new KeyedLog(broken, onError);
    log.append("would overwrite key 1");
    await log.flush();

    expect(register).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
  });

  it("reports a failed write without throwing at the caller", async () => {
    const store = new MemoryStateStore<string>();
    vi.spyOn(store, "register").mockRejectedValueOnce(new Error("disk full"));
    const onError = vi.fn();
    const log = new KeyedLog(store, onError);
    expect(() => log.append("x")).not.toThrow();
    await log.flush();
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe("DeferredStateStore", () => {
  it("opens its backend once, after the host is ready, and queues earlier calls", async () => {
    let ready: () => void = () => undefined;
    const backend = new MemoryStateStore<number>();
    const open = vi.fn(() => backend);
    const store = new DeferredStateStore<number>(
      new Promise<void>((resolve) => {
        ready = resolve;
      }),
      open,
    );

    const write = store.register("a", 1);
    await Promise.resolve();
    expect(open).not.toHaveBeenCalled();

    ready();
    await write;
    expect(await store.lookup("a")).toBe(1);
    expect(await store.entries()).toEqual([{ key: "a", value: 1 }]);
    expect(await store.delete("a")).toBe(true);
    expect(open).toHaveBeenCalledOnce();
  });
});
