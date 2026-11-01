/**
 * state-store.ts — Durable state through the host's SQLite plugin store.
 *
 * The repository is database-first: runtime state goes to the shared SQLite
 * stores, not to ad-hoc JSON files (scripts/check-database-first-legacy-stores).
 * The host exposes a keyed store per plugin (`api.runtime.state.openKeyedStore`).
 * This module narrows it to the few async operations the cognitive core needs,
 * so the core never imports the host and tests can use an in-memory store.
 *
 *   StateStorePort   the subset of the host keyed store the core uses
 *   MemoryStateStore session-only implementation (tests, and the fallback when
 *                    the host has no plugin state)
 *   DeferredStateStore a store whose backend opens only once the host is ready
 *   KeyedLog         an append-only, ordered log on top of a keyed store:
 *                    zero-padded sequence keys sort lexically, writes are
 *                    serialized, and the log hydrates once at startup
 */

/** The subset of `PluginStateKeyedStore` the core relies on. */
export type StateStorePort<T> = {
  register(key: string, value: T): Promise<void>;
  lookup(key: string): Promise<T | undefined>;
  delete(key: string): Promise<boolean>;
  entries(): Promise<ReadonlyArray<{ readonly key: string; readonly value: T }>>;
};

/** Session-only store: same contract, nothing survives the process. */
export class MemoryStateStore<T> implements StateStorePort<T> {
  private readonly rows = new Map<string, T>();

  async register(key: string, value: T): Promise<void> {
    this.rows.set(key, structuredClone(value));
  }

  async lookup(key: string): Promise<T | undefined> {
    const value = this.rows.get(key);
    return value === undefined ? undefined : structuredClone(value);
  }

  async delete(key: string): Promise<boolean> {
    return this.rows.delete(key);
  }

  async entries(): Promise<ReadonlyArray<{ readonly key: string; readonly value: T }>> {
    return [...this.rows.entries()].map(([key, value]) => ({ key, value: structuredClone(value) }));
  }
}

/**
 * A store whose backend opens once `ready` resolves. The host's retained stores
 * belong to the running plugin, not to its registration: a handle opened while
 * the plugin registers loses its admission when the gateway activates the
 * registry. Calls made before `ready` wait for it; the backend opens once.
 */
export class DeferredStateStore<T> implements StateStorePort<T> {
  private backend: StateStorePort<T> | undefined;

  constructor(
    private readonly ready: Promise<void>,
    private readonly open: () => StateStorePort<T>,
  ) {}

  private async store(): Promise<StateStorePort<T>> {
    await this.ready;
    this.backend ??= this.open();
    return this.backend;
  }

  async register(key: string, value: T): Promise<void> {
    await (await this.store()).register(key, value);
  }

  async lookup(key: string): Promise<T | undefined> {
    return (await this.store()).lookup(key);
  }

  async delete(key: string): Promise<boolean> {
    return (await this.store()).delete(key);
  }

  async entries(): Promise<ReadonlyArray<{ readonly key: string; readonly value: T }>> {
    return (await this.store()).entries();
  }
}

/** Twelve digits: a trillion entries before the lexical order breaks. */
export function seqKey(seq: number): string {
  return Math.max(0, Math.floor(seq)).toString().padStart(12, "0");
}

/**
 * Append-only log persisted one entry per key. `hydrate()` reads what earlier
 * processes wrote; `append()` is synchronous for the caller and persists in
 * order on a single write chain. Failures are reported, never thrown at the
 * caller, because the in-memory state stays authoritative for this process.
 */
export class KeyedLog<T> {
  private next = 1;
  /** False until the stored tail is known; without it a write could overwrite a stored key. */
  private ready = false;
  private writes: Promise<void>;
  private readonly hydration: Promise<ReadonlyArray<T>>;

  constructor(
    private readonly store: StateStorePort<T>,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {
    this.hydration = this.load();
    // Appends queue behind hydration so sequence numbers never collide with stored ones.
    this.writes = this.hydration.then(
      () => {
        this.ready = true;
      },
      (error: unknown) => this.onError(error),
    );
  }

  private async load(): Promise<ReadonlyArray<T>> {
    const rows = [...(await this.store.entries())].toSorted((a, b) =>
      a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
    );
    const last = rows.at(-1);
    this.next = last ? Number.parseInt(last.key, 10) + 1 : 1;
    return rows.map((row) => row.value);
  }

  /** Everything earlier processes persisted, oldest first. */
  hydrate(): Promise<ReadonlyArray<T>> {
    return this.hydration;
  }

  append(value: T): void {
    this.writes = this.writes.then(async () => {
      if (!this.ready) {
        this.onError(new Error("Store unavailable at startup: entry kept for this session only."));
        return;
      }
      const key = seqKey(this.next++);
      try {
        await this.store.register(key, value);
      } catch (error) {
        this.onError(error);
      }
    });
  }

  /** Delete every persisted entry matching `drop`. Resolves to how many went. */
  async remove(drop: (value: T) => boolean): Promise<number> {
    await this.flush();
    let removed = 0;
    for (const row of await this.store.entries()) {
      if (drop(row.value) && (await this.store.delete(row.key))) {
        removed++;
      }
    }
    return removed;
  }

  /** Resolves once every queued write has been attempted. */
  flush(): Promise<void> {
    return this.writes;
  }
}
