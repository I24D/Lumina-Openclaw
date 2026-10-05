/**
 * audit-log.ts — A tamper-evident record of what the system decided and did.
 *
 * M3GAN spec §24 and §48: every significant action records who asked, what,
 * why, under which permissions, what happened, with which model and how sure
 * it was; and the critical log lives apart from the memory the agent can edit,
 * resistant to alteration. The film's M3GAN hid her tracks because that
 * separation did not exist.
 *
 * Each entry carries the hash of the previous one (SHA-256 over a canonical
 * serialization). Interior changes break the chain. Tail deletion across a
 * restart needs an external trusted checkpoint and is NOT detected here.
 * `verify()` names the first broken entry. Append-only: there is no update
 * or delete, and no agent tool writes here; tools may only read.
 *
 * Durable copies go to the host's SQLite plugin store (one row per entry,
 * ordered keys). Entries written before the stored chain has loaded wait and
 * are chained after it, so a restart never forks the chain.
 */
import { createHash } from "node:crypto";
import { KeyedLog, type StateStorePort } from "../shared/state-store.js";

export const AUDIT_EXECUTIONS = [
  "executed",
  "modified",
  "pending",
  "refused",
  "stopped",
  "recorded",
] as const;
export type AuditExecution = (typeof AUDIT_EXECUTIONS)[number];

export type AuditEntry = {
  readonly atISO: string;
  /** Who asked: "agent", "owner", "cognitive-loop", "brainstem"... */
  readonly actor: string;
  readonly action: string;
  readonly reason: string;
  readonly execution: AuditExecution;
  readonly permissions?: ReadonlyArray<string>;
  readonly outcome?: string;
  readonly model?: string;
  readonly confidence?: number;
  readonly data?: Readonly<Record<string, unknown>>;
};

export type AuditRecord = AuditEntry & {
  readonly seq: number;
  readonly prev: string;
  readonly hash: string;
};

export type AuditVerification =
  | { readonly ok: true; readonly entries: number }
  | {
      readonly ok: false;
      readonly entries: number;
      readonly brokenAt: number;
      readonly reason: string;
    };

const GENESIS = "0".repeat(64);

/** JSON with keys sorted at every level, so the hash does not depend on key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashOf(record: Omit<AuditRecord, "hash">): string {
  return createHash("sha256").update(canonical(record)).digest("hex");
}

function verifyRecords(records: ReadonlyArray<AuditRecord>): AuditVerification {
  let prev = GENESIS;
  for (const [index, record] of records.entries()) {
    const { hash, ...body } = record;
    if (record.prev !== prev) {
      return {
        ok: false,
        entries: records.length,
        brokenAt: record.seq,
        reason: "chain link does not match the previous entry",
      };
    }
    if (record.seq !== index + 1) {
      return {
        ok: false,
        entries: records.length,
        brokenAt: record.seq,
        reason: "sequence gap or reordering",
      };
    }
    if (hashOf(body) !== hash) {
      return {
        ok: false,
        entries: records.length,
        brokenAt: record.seq,
        reason: "entry was altered after it was written",
      };
    }
    prev = hash;
  }
  return { ok: true, entries: records.length };
}

type StampedEntry = AuditEntry;

export class AuditLog {
  /** Bounded window for `recent()`. */
  private readonly memory: AuditRecord[] = [];
  /** The whole chain this process knows: what was stored plus what it appended. */
  private readonly chain: AuditRecord[] = [];
  private readonly recentLimit: number;
  private readonly now: () => number;
  private readonly store: StateStorePort<AuditRecord> | undefined;
  private readonly log: KeyedLog<AuditRecord> | undefined;
  private readonly waiting: StampedEntry[] = [];
  private hydrated: boolean;
  private last: AuditRecord | undefined;
  /** Resolves once the stored chain is loaded (immediately without a store). */
  readonly ready: Promise<void>;

  /** Without `store` the log is session-only: nothing survives the process. */
  constructor(
    options: {
      readonly store?: StateStorePort<AuditRecord>;
      readonly now?: () => number;
      readonly recentLimit?: number;
      readonly onError?: (error: unknown) => void;
    } = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.recentLimit = Math.max(1, options.recentLimit ?? 512);
    this.store = options.store;
    if (!options.store) {
      this.hydrated = true;
      this.ready = Promise.resolve();
      return;
    }
    this.hydrated = false;
    const onError = options.onError ?? (() => undefined);
    this.log = new KeyedLog(options.store, onError);
    this.ready = this.log.hydrate().then(
      (records) => {
        for (const record of records) {
          this.keep(record);
        }
        this.settle();
      },
      (error: unknown) => {
        // Unknown tail: keep auditing in memory for this session; nothing is written.
        onError(error);
        this.settle();
      },
    );
  }

  private settle(): void {
    this.hydrated = true;
    for (const entry of this.waiting.splice(0)) {
      this.commit(entry);
    }
  }

  private keep(record: AuditRecord): void {
    this.chain.push(record);
    this.memory.push(record);
    if (this.memory.length > this.recentLimit) {
      this.memory.splice(0, this.memory.length - this.recentLimit);
    }
    this.last = record;
  }

  private commit(entry: StampedEntry): AuditRecord {
    const body: Omit<AuditRecord, "hash"> = {
      ...entry,
      seq: (this.last?.seq ?? 0) + 1,
      prev: this.last?.hash ?? GENESIS,
    };
    const record: AuditRecord = { ...body, hash: hashOf(body) };
    this.keep(record);
    this.log?.append(record);
    return structuredClone(record);
  }

  /**
   * Record an entry. Before the stored chain has loaded the entry waits and a
   * provisional copy with `seq` 0 and an empty hash is returned; it is chained
   * in order as soon as loading finishes.
   */
  append(entry: Omit<AuditEntry, "atISO"> & { readonly atISO?: string }): AuditRecord {
    const stamped: StampedEntry = {
      ...structuredClone(entry),
      atISO: entry.atISO ?? new Date(this.now()).toISOString(),
    };
    if (!this.hydrated) {
      this.waiting.push(stamped);
      return { ...structuredClone(stamped), seq: 0, prev: "", hash: "" };
    }
    return this.commit(stamped);
  }

  /** Newest first, optionally filtered. */
  recent(limit = 32, filter?: (record: AuditRecord) => boolean): ReadonlyArray<AuditRecord> {
    const out: AuditRecord[] = [];
    for (let i = this.memory.length - 1; i >= 0 && out.length < limit; i--) {
      const record = structuredClone(this.memory[i] as AuditRecord);
      if (!filter || filter(record)) {
        out.push(record);
      }
    }
    return out;
  }

  get size(): number {
    return this.last?.seq ?? 0;
  }

  /** Re-walk the chain this process holds and report the first break. */
  verify(): AuditVerification {
    return verifyRecords(this.chain);
  }

  /**
   * Re-read the chain from the store itself, so an alteration made in the
   * database after loading is caught. Without a store, same as `verify()`.
   */
  async verifyStored(): Promise<AuditVerification> {
    if (!this.store || !this.log) {
      return this.verify();
    }
    await this.flush();
    const rows = [...(await this.store.entries())].toSorted((a, b) =>
      a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
    );
    return verifyRecords(rows.map((row) => row.value));
  }

  /** Resolves when every entry so far has been handed to the store. */
  async flush(): Promise<void> {
    await this.ready;
    await this.log?.flush();
  }
}
