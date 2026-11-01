/**
 * episodic-memory.ts — Time-stamped events of what happened.
 *
 * The live gateway persists episodes in OpenClaw's SQLite plugin state.
 * Legacy episodic.jsonl is imported once when the durable store is empty.
 * Discovery/tests without a durable store keep the JSONL fallback.
 */
import fs from "node:fs";
import path from "node:path";
import { KeyedLog, type StateStorePort } from "../shared/state-store.js";
import { appendJsonl, newId, readJsonlSync, rewriteJsonl } from "./store.js";

export type EpisodeKind =
  | "window"
  | "file"
  | "voice"
  | "tool"
  | "action"
  | "intent"
  | "system"
  | "note";

export type Episode = {
  readonly id: string;
  readonly atISO: string;
  readonly kind: EpisodeKind;
  readonly summary: string;
  readonly tags: ReadonlyArray<string>;
  readonly ref?: Readonly<Record<string, unknown>>;
};

export type RecallQuery = {
  readonly kinds?: ReadonlyArray<EpisodeKind>;
  readonly tags?: ReadonlyArray<string>;
  readonly substring?: string;
  readonly sinceISO?: string;
  readonly limit?: number;
};

export type EpisodicMemoryOptions = {
  readonly dir: string;
  readonly store?: StateStorePort<Episode>;
  readonly onError?: (error: unknown) => void;
};

export class EpisodicMemoryStore {
  private readonly filePath: string;
  private buf: Episode[] = [];
  private readonly cacheLimit = 5_000;
  private readonly log: KeyedLog<Episode> | undefined;
  private readonly onError: (error: unknown) => void;
  private loading = false;
  private pendingPersist: Episode[] = [];
  private readonly loadingPurges: Array<(episode: Episode) => boolean> = [];
  readonly ready: Promise<void>;

  constructor(input: string | EpisodicMemoryOptions) {
    const options: EpisodicMemoryOptions = typeof input === "string" ? { dir: input } : input;
    this.filePath = path.join(options.dir, "episodic.jsonl");
    this.onError = options.onError ?? (() => undefined);
    const legacy = readJsonlSync<Episode>(this.filePath);
    this.buf = this.cap(legacy);

    if (!options.store) {
      this.ready = Promise.resolve();
      return;
    }

    this.loading = true;
    this.log = new KeyedLog(options.store, this.onError);
    this.ready = this.log.hydrate().then(
      async (stored) => {
        const base = (stored.length > 0 ? stored : legacy).filter(
          (episode) => !this.loadingPurges.some((drop) => drop(episode)),
        );
        const pending = this.pendingPersist.filter(
          (episode) => !this.loadingPurges.some((drop) => drop(episode)),
        );
        this.buf = this.cap([...base, ...pending]);

        if (stored.length === 0 && legacy.length > 0) {
          for (const episode of legacy) {
            if (!this.loadingPurges.some((drop) => drop(episode))) {
              this.log?.append(episode);
            }
          }
        }
        for (const episode of pending) {
          this.log?.append(episode);
        }
        await this.log?.flush();
        this.pendingPersist = [];
        this.loadingPurges.length = 0;
        this.loading = false;
        if (stored.length === 0 && legacy.length > 0) {
          this.archiveLegacy();
        }
      },
      (error: unknown) => {
        this.loading = false;
        this.onError(error);
      },
    );
  }

  private cap(rows: ReadonlyArray<Episode>): Episode[] {
    const list = [...rows];
    return list.length > this.cacheLimit ? list.slice(list.length - this.cacheLimit) : list;
  }

  private archiveLegacy(): void {
    if (!fs.existsSync(this.filePath)) {
      return;
    }
    const archived = `${this.filePath}.migrated`;
    try {
      if (!fs.existsSync(archived)) {
        fs.renameSync(this.filePath, archived);
      }
    } catch (error) {
      this.onError(error);
    }
  }

  remember(input: Omit<Episode, "id" | "atISO">): Episode {
    const ep: Episode = {
      id: newId(),
      atISO: new Date().toISOString(),
      ...input,
      tags: input.tags ?? [],
    };
    if (this.log) {
      if (this.loading) {
        this.pendingPersist.push(structuredClone(ep));
      } else {
        this.log.append(structuredClone(ep));
      }
    } else {
      appendJsonl(this.filePath, ep);
    }
    this.buf.push(ep);
    if (this.buf.length > this.cacheLimit) {
      this.buf.shift();
    }
    return ep;
  }

  recall(query: RecallQuery): Episode[] {
    const limit = Math.max(1, Math.min(500, query.limit ?? 50));
    const since = query.sinceISO ? Date.parse(query.sinceISO) : 0;
    const substr = query.substring?.toLowerCase() ?? "";
    const kinds = query.kinds && query.kinds.length ? new Set(query.kinds) : null;
    const tags = query.tags && query.tags.length ? new Set(query.tags) : null;
    const out: Episode[] = [];
    for (let i = this.buf.length - 1; i >= 0 && out.length < limit; i--) {
      const ep = this.buf[i];
      if (!ep) {
        continue;
      }
      if (kinds && !kinds.has(ep.kind)) {
        continue;
      }
      if (since > 0 && Date.parse(ep.atISO) < since) {
        continue;
      }
      if (tags && !ep.tags.some((tag) => tags.has(tag))) {
        continue;
      }
      if (substr && !ep.summary.toLowerCase().includes(substr)) {
        continue;
      }
      out.push(ep);
    }
    return out;
  }

  /** Remove episodes from a requested session from memory and durable storage. */
  forgetSince(sinceISO: string): number {
    const since = Date.parse(sinceISO);
    if (!Number.isFinite(since)) {
      throw new Error("forgetSince needs a valid ISO timestamp.");
    }
    const drop = (episode: Episode) => Date.parse(episode.atISO) >= since;
    if (this.loading) {
      this.loadingPurges.push(drop);
      this.pendingPersist = this.pendingPersist.filter((episode) => !drop(episode));
    }
    const kept = this.buf.filter((episode) => !drop(episode));
    const removed = this.buf.length - kept.length;
    this.buf = kept;

    if (this.log) {
      void this.ready
        .then(() => this.log?.remove(drop))
        .catch((error: unknown) => this.onError(error));
    } else {
      rewriteJsonl(this.filePath, this.buf);
    }
    return removed;
  }

  /** Forget one episode, from memory and from durable storage (spec §68). */
  forget(id: string): boolean {
    const drop = (episode: Episode) => episode.id === id;
    const kept = this.buf.filter((episode) => !drop(episode));
    if (kept.length === this.buf.length) {
      return false;
    }
    this.buf = kept;
    if (this.log) {
      void this.ready
        .then(() => this.log?.remove(drop))
        .catch((error: unknown) => this.onError(error));
    } else {
      rewriteJsonl(this.filePath, this.buf);
    }
    return true;
  }

  tail(limit = 20): Episode[] {
    return this.buf.slice(-limit).toReversed();
  }

  async flush(): Promise<void> {
    await this.ready;
    await this.log?.flush();
  }
}
