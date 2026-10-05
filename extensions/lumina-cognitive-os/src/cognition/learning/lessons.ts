/**
 * lessons.ts — Durable lesson ledger for the cognitive loop.
 *
 * In the live gateway, lessons are stored as snapshots in OpenClaw's SQLite
 * plugin state. Legacy lessons.jsonl is imported once when the durable store
 * is empty. Non-live discovery/tests keep the JSONL fallback.
 */
import fs from "node:fs";
import path from "node:path";
import { appendJsonl, ensureDir, newId, readJsonlSync, rewriteJsonl } from "../../memory/store.js";
import { KeyedLog, type StateStorePort } from "../../shared/state-store.js";
import { clampConfidence } from "../uncertainty.js";

export type Lesson = {
  readonly id: string;
  readonly trigger: string;
  readonly claim: string;
  readonly confidence: number;
  readonly confirmations: number;
  readonly contradictions: number;
  readonly createdAtISO: string;
  readonly updatedAtISO: string;
};

export type LessonStoreOptions = {
  readonly dir: string;
  readonly store?: StateStorePort<Lesson>;
  readonly onError?: (error: unknown) => void;
};

const EVIDENCE_STEP = 0.15;

function latestSnapshots(rows: ReadonlyArray<Lesson>): Lesson[] {
  const byId = new Map<string, Lesson>();
  for (const row of rows) {
    const current = byId.get(row.id);
    if (!current || current.updatedAtISO <= row.updatedAtISO) {
      byId.set(row.id, row);
    }
  }
  return [...byId.values()];
}

export class LessonStore {
  private lessons: Lesson[] = [];
  private readonly filePath: string;
  private readonly log: KeyedLog<Lesson> | undefined;
  private readonly onError: (error: unknown) => void;
  private loading = false;
  private pendingPersist: Lesson[] = [];
  readonly ready: Promise<void>;

  constructor(input: string | LessonStoreOptions) {
    const options: LessonStoreOptions = typeof input === "string" ? { dir: input } : input;
    this.filePath = path.join(options.dir, "lessons.jsonl");
    this.onError = options.onError ?? (() => undefined);
    ensureDir(options.dir);
    const legacy = readJsonlSync<Lesson>(this.filePath);
    this.lessons = latestSnapshots(legacy);

    if (!options.store) {
      this.ready = Promise.resolve();
      return;
    }

    this.loading = true;
    this.log = new KeyedLog(options.store, this.onError);
    this.ready = this.log.hydrate().then(
      async (stored) => {
        const durable = stored.length > 0 ? latestSnapshots(stored) : latestSnapshots(legacy);
        this.lessons = latestSnapshots([...durable, ...this.pendingPersist]);
        if (stored.length === 0 && legacy.length > 0) {
          for (const row of legacy) {
            this.log?.append(row);
          }
        }
        for (const row of this.pendingPersist) {
          this.log?.append(row);
        }
        await this.log?.flush();
        this.pendingPersist = [];
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

  private persistSnapshot(lesson: Lesson, rewriteFallback = false): void {
    if (this.log) {
      if (this.loading) {
        this.pendingPersist.push(structuredClone(lesson));
      } else {
        this.log.append(structuredClone(lesson));
      }
      return;
    }
    if (rewriteFallback) {
      rewriteJsonl(this.filePath, this.lessons);
    } else {
      appendJsonl(this.filePath, lesson);
    }
  }

  async flush(): Promise<void> {
    await this.ready;
    await this.log?.flush();
  }

  list(trigger?: string): ReadonlyArray<Lesson> {
    return trigger ? this.lessons.filter((l) => l.trigger === trigger) : [...this.lessons];
  }

  get(id: string): Lesson | undefined {
    return this.lessons.find((l) => l.id === id);
  }

  learn(
    params: { readonly trigger: string; readonly claim: string; readonly confidence?: number },
    nowISO: string = new Date().toISOString(),
  ): Lesson {
    const trigger = params.trigger.trim();
    const claim = params.claim.trim();
    if (!trigger || !claim) {
      throw new Error("A lesson needs both a trigger and a claim.");
    }
    const existing = this.lessons.find((l) => l.trigger === trigger && l.claim === claim);
    if (existing) {
      return this.confirm(existing.id, nowISO) ?? existing;
    }
    const lesson: Lesson = {
      id: newId(),
      trigger,
      claim,
      confidence: clampConfidence(params.confidence ?? 0.5),
      confirmations: 0,
      contradictions: 0,
      createdAtISO: nowISO,
      updatedAtISO: nowISO,
    };
    this.lessons.push(lesson);
    this.persistSnapshot(lesson);
    return lesson;
  }

  private adjust(id: string, delta: number, nowISO: string): Lesson | undefined {
    const current = this.lessons.find((l) => l.id === id);
    if (!current) {
      return undefined;
    }
    const next: Lesson = {
      ...current,
      confidence: clampConfidence(current.confidence + delta),
      confirmations: current.confirmations + (delta > 0 ? 1 : 0),
      contradictions: current.contradictions + (delta < 0 ? 1 : 0),
      updatedAtISO: nowISO,
    };
    this.lessons = this.lessons.map((l) => (l.id === id ? next : l));
    this.persistSnapshot(next, true);
    return next;
  }

  confirm(id: string, nowISO: string = new Date().toISOString()): Lesson | undefined {
    return this.adjust(id, EVIDENCE_STEP, nowISO);
  }

  contradict(id: string, nowISO: string = new Date().toISOString()): Lesson | undefined {
    return this.adjust(id, -EVIDENCE_STEP, nowISO);
  }

  applicable(trigger: string, minConfidence = 0.5): ReadonlyArray<Lesson> {
    return this.lessons
      .filter((l) => l.trigger === trigger && l.confidence >= minConfidence)
      .toSorted((a, b) => b.confidence - a.confidence);
  }
}
