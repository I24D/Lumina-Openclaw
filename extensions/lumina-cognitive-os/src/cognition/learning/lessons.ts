/**
 * lessons.ts — What the loop learned, kept across restarts.
 *
 * The "learn" step of the cognitive loop is worthless if it evaporates with
 * the process. A lesson is a small, durable claim tied to an event kind:
 *
 *   "disk.low on C: -> clearing %TEMP% recovered space and Dal accepted it"
 *
 * Lessons carry a confidence that moves with evidence: every confirmation
 * nudges it up, every contradiction pulls it down, and a lesson that keeps
 * being wrong decays out of usefulness instead of being trusted forever.
 *
 * This is deliberately not a model: it is a ledger a reasoner can consult
 * cheaply before proposing the same thing twice.
 */
import path from "node:path";
import { appendJsonl, ensureDir, newId, readJsonlSync, rewriteJsonl } from "../../memory/store.js";
import { clampConfidence } from "../uncertainty.js";

export type Lesson = {
  readonly id: string;
  /** Event kind this lesson applies to, e.g. "disk.low". */
  readonly trigger: string;
  /** The durable claim, phrased so it can be judged true or false later. */
  readonly claim: string;
  readonly confidence: number;
  readonly confirmations: number;
  readonly contradictions: number;
  readonly createdAtISO: string;
  readonly updatedAtISO: string;
};

/** How hard a single piece of evidence moves confidence. */
const EVIDENCE_STEP = 0.15;

export class LessonStore {
  private lessons: Lesson[] = [];
  private readonly filePath: string;

  constructor(dir: string) {
    this.filePath = path.join(dir, "lessons.jsonl");
    ensureDir(dir);
    this.lessons = readJsonlSync<Lesson>(this.filePath);
  }

  list(trigger?: string): ReadonlyArray<Lesson> {
    return trigger ? this.lessons.filter((l) => l.trigger === trigger) : [...this.lessons];
  }

  get(id: string): Lesson | undefined {
    return this.lessons.find((l) => l.id === id);
  }

  /**
   * Record a lesson. Re-learning an identical claim for the same trigger
   * confirms the existing one instead of creating a duplicate.
   */
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
    appendJsonl(this.filePath, lesson);
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
    rewriteJsonl(this.filePath, this.lessons);
    return next;
  }

  confirm(id: string, nowISO: string = new Date().toISOString()): Lesson | undefined {
    return this.adjust(id, EVIDENCE_STEP, nowISO);
  }

  contradict(id: string, nowISO: string = new Date().toISOString()): Lesson | undefined {
    return this.adjust(id, -EVIDENCE_STEP, nowISO);
  }

  /**
   * Lessons worth acting on for a trigger, most trusted first.
   * The floor keeps discredited lessons out of the reasoner's context.
   */
  applicable(trigger: string, minConfidence = 0.5): ReadonlyArray<Lesson> {
    return this.lessons
      .filter((l) => l.trigger === trigger && l.confidence >= minConfidence)
      .sort((a, b) => b.confidence - a.confidence);
  }
}
