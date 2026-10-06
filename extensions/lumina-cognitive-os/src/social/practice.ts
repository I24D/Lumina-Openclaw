/**
 * practice.ts — What a person is learning, and how it is going.
 *
 * M3GAN spec §94 (teaching mode: ask questions, evaluate understanding, adapt
 * difficulty, remember progress) and §95 (language learning: vocabulary,
 * grammar, pronunciation, practice, contextual correction). The agent does the
 * teaching in conversation; this is its memory of it:
 *   - items to practise (a word, a grammar point, a sound, a fact), each with
 *     a Leitner box: right answers space reviews out (1, 2, 4, 8, 16 days),
 *     a wrong one brings the item back tomorrow;
 *   - contextual corrections ("you said X, it is Y, because Z"), which become
 *     items so a mistake is practised, not only pointed out;
 *   - progress per subject: how much is learned, what is due, how accurate.
 * Difficulty adapts through the boxes: what keeps failing comes back often.
 * Pronunciation is graded by the agent from what it heard; nothing here
 * listens. Items belong to a person and go when the person is forgotten.
 */
import { newEntityId } from "../shared/ids.js";
import type { StateStorePort } from "../shared/state-store.js";

export const PRACTICE_KINDS = [
  "vocabulary",
  "grammar",
  "pronunciation",
  "fact",
  "skill",
  "correction",
] as const;
export type PracticeKind = (typeof PRACTICE_KINDS)[number];

export type PracticeItem = {
  readonly id: string;
  readonly personId: string;
  /** "english", "french", "math"... lower case. */
  readonly subject: string;
  readonly kind: PracticeKind;
  readonly prompt: string;
  readonly answer: string;
  readonly note?: string;
  /** Leitner box 1..5: higher is better known and reviewed less often. */
  readonly box: number;
  readonly dueISO: string;
  readonly right: number;
  readonly wrong: number;
  readonly createdISO: string;
  readonly reviewedISO?: string;
};

export type SubjectProgress = {
  readonly subject: string;
  readonly items: number;
  /** Items in box 4 or 5. */
  readonly learned: number;
  readonly due: number;
  readonly accuracy: number | null;
  readonly corrections: number;
  readonly lastPracticeISO: string | null;
  /** The items that keep failing, to practise or explain differently. */
  readonly struggling: ReadonlyArray<{ readonly prompt: string; readonly wrong: number }>;
};

const DAY_MS = 86_400_000;
/** Days until the next review, by box. */
const INTERVAL_DAYS = [0, 1, 2, 4, 8, 16] as const;
const MAX_TEXT = 500;

const clean = (text: string, field: string): string => {
  const value = text.trim();
  if (!value || value.length > MAX_TEXT) {
    throw new PracticeError(`${field} must be 1 to ${MAX_TEXT} characters`);
  }
  return value;
};

/** Input the book refuses; nothing was changed. */
export class PracticeError extends Error {}

export class PracticeBook {
  private readonly items = new Map<string, PracticeItem>();
  private readonly now: () => number;
  private writes: Promise<void> = Promise.resolve();
  readonly ready: Promise<void>;

  constructor(
    private readonly options: {
      readonly store?: StateStorePort<PracticeItem>;
      readonly now?: () => number;
      readonly onError?: (error: unknown) => void;
    } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.ready = (async () => {
      try {
        for (const { value } of (await options.store?.entries()) ?? []) {
          this.items.set(value.id, value);
        }
      } catch (error) {
        options.onError?.(error);
      }
    })();
  }

  private persist(action: (store: StateStorePort<PracticeItem>) => Promise<unknown>): void {
    const store = this.options.store;
    if (store) {
      this.writes = this.writes.then(() =>
        action(store).then(
          () => undefined,
          (error: unknown) => this.options.onError?.(error),
        ),
      );
    }
  }

  private save(item: PracticeItem): PracticeItem {
    this.items.set(item.id, item);
    const snapshot = structuredClone(item);
    this.persist((store) => store.register(item.id, snapshot));
    return structuredClone(item);
  }

  add(input: {
    readonly personId: string;
    readonly subject: string;
    readonly kind: PracticeKind;
    readonly prompt: string;
    readonly answer: string;
    readonly note?: string;
  }): PracticeItem {
    if (!(PRACTICE_KINDS as ReadonlyArray<string>).includes(input.kind)) {
      throw new PracticeError(`kind must be one of ${PRACTICE_KINDS.join(", ")}`);
    }
    const subject = clean(input.subject, "subject").toLowerCase();
    const prompt = clean(input.prompt, "prompt");
    const existing = [...this.items.values()].find(
      (i) =>
        i.personId === input.personId &&
        i.subject === subject &&
        i.prompt.toLowerCase() === prompt.toLowerCase(),
    );
    const atISO = new Date(this.now()).toISOString();
    const note = input.note?.trim() ? clean(input.note, "note") : undefined;
    // The same prompt again updates the answer and keeps the history.
    return this.save({
      ...(existing ?? {
        id: newEntityId("practice"),
        personId: input.personId,
        subject,
        box: 1,
        dueISO: atISO,
        right: 0,
        wrong: 0,
        createdISO: atISO,
      }),
      kind: input.kind,
      prompt,
      answer: clean(input.answer, "answer"),
      ...(note ? { note } : {}),
    });
  }

  /** A mistake made in conversation, kept so it gets practised. */
  correct(input: {
    readonly personId: string;
    readonly subject: string;
    readonly said: string;
    readonly correct: string;
    readonly why?: string;
  }): PracticeItem {
    return this.add({
      personId: input.personId,
      subject: input.subject,
      kind: "correction",
      prompt: input.said,
      answer: input.correct,
      ...(input.why ? { note: input.why } : {}),
    });
  }

  /** Record how a review went and schedule the next one. */
  grade(id: string, right: boolean): PracticeItem {
    const item = this.items.get(id);
    if (!item) {
      throw new PracticeError(`No practice item ${id}.`);
    }
    const nowMs = this.now();
    const box = right ? Math.min(5, item.box + 1) : 1;
    return this.save({
      ...item,
      box,
      dueISO: new Date(nowMs + (INTERVAL_DAYS[box] ?? 1) * DAY_MS).toISOString(),
      right: item.right + (right ? 1 : 0),
      wrong: item.wrong + (right ? 0 : 1),
      reviewedISO: new Date(nowMs).toISOString(),
    });
  }

  /** What is due now, weakest first. */
  due(filter: { readonly personId?: string; readonly subject?: string }, limit = 10) {
    const nowISO = new Date(this.now()).toISOString();
    return this.list(filter)
      .filter((i) => i.dueISO <= nowISO)
      .toSorted((a, b) => a.box - b.box || a.dueISO.localeCompare(b.dueISO))
      .slice(0, limit);
  }

  list(filter: { readonly personId?: string; readonly subject?: string } = {}): PracticeItem[] {
    const subject = filter.subject?.trim().toLowerCase();
    return [...this.items.values()]
      .filter(
        (i) =>
          (!filter.personId || i.personId === filter.personId) &&
          (!subject || i.subject === subject),
      )
      .map((i) => structuredClone(i));
  }

  progress(personId: string): SubjectProgress[] {
    const nowISO = new Date(this.now()).toISOString();
    const bySubject = new Map<string, PracticeItem[]>();
    for (const item of this.list({ personId })) {
      bySubject.set(item.subject, [...(bySubject.get(item.subject) ?? []), item]);
    }
    return [...bySubject.entries()].map(([subject, items]) => {
      const right = items.reduce((n, i) => n + i.right, 0);
      const wrong = items.reduce((n, i) => n + i.wrong, 0);
      const reviewed = items
        .map((i) => i.reviewedISO)
        .filter((at): at is string => Boolean(at))
        .toSorted();
      return {
        subject,
        items: items.length,
        learned: items.filter((i) => i.box >= 4).length,
        due: items.filter((i) => i.dueISO <= nowISO).length,
        accuracy: right + wrong > 0 ? Math.round((right / (right + wrong)) * 100) / 100 : null,
        corrections: items.filter((i) => i.kind === "correction").length,
        lastPracticeISO: reviewed.at(-1) ?? null,
        struggling: items
          .filter((i) => i.wrong > i.right && i.wrong >= 2)
          .toSorted((a, b) => b.wrong - a.wrong)
          .slice(0, 5)
          .map((i) => ({ prompt: i.prompt, wrong: i.wrong })),
      };
    });
  }

  remove(id: string): boolean {
    const existed = this.items.delete(id);
    if (existed) {
      this.persist((store) => store.delete(id));
    }
    return existed;
  }

  /** Everything about a person, when they are forgotten. */
  forgetPerson(personId: string): number {
    const ids = this.list({ personId }).map((i) => i.id);
    for (const id of ids) {
      this.remove(id);
    }
    return ids.length;
  }

  async flush(): Promise<void> {
    await this.ready;
    await this.writes;
  }
}
