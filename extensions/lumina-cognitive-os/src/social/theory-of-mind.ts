/**
 * theory-of-mind.ts — What other people probably know, believe or want.
 *
 * M3GAN spec §13: a limited model of other people's knowledge ("Dal knows X",
 * "B probably does not know X", "Cady is looking for Y") with explicit
 * uncertainty, never treating a psychological inference as a fact.
 *
 * Every belief records how it was obtained:
 *
 *   observed   the person showed it (searched, said "I didn't know")
 *   told       the person or someone else said it
 *   inferred   Lumina deduced it; capped at INFERENCE_CEILING and always
 *              reported as an inference
 *
 * Newer evidence about the same person and proposition replaces older, so
 * "Dal didn't know" can become "Dal knows" once he is told.
 */
import { clampConfidence } from "../contracts/uncertainty.js";
import { newEntityId } from "../shared/ids.js";
import type { StateStorePort } from "../shared/state-store.js";

export const MIND_STANCES = [
  "knows",
  "believes",
  "does_not_know",
  "is_looking_for",
  "wants",
] as const;
export type MindStance = (typeof MIND_STANCES)[number];

export type MindProvenance = "observed" | "told" | "inferred";

export type Belief = {
  readonly id: string;
  /** The person this is about (people registry id or world-model id). */
  readonly holderId: string;
  readonly stance: MindStance;
  readonly proposition: string;
  readonly confidence: number;
  readonly provenance: MindProvenance;
  readonly atISO: string;
};

/** An inference about someone's mind is never more than a plausible guess. */
export const INFERENCE_CEILING = 0.6;

function key(holderId: string, proposition: string): string {
  return `${holderId}\u0000${proposition.trim().toLowerCase()}`;
}

export class MindModel {
  private readonly beliefs = new Map<string, Belief>();
  private readonly now: () => number;
  private readonly store: StateStorePort<Belief> | undefined;
  private readonly onError: (error: unknown) => void;
  private writes: Promise<void> = Promise.resolve();
  private loading = false;
  private readonly loadingPurges: string[] = [];
  readonly ready: Promise<void>;

  constructor(
    options: {
      readonly store?: StateStorePort<Belief>;
      readonly now?: () => number;
      readonly onError?: (error: unknown) => void;
    } = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.store = options.store;
    this.onError = options.onError ?? (() => undefined);
    this.loading = Boolean(options.store);
    this.ready = options.store
      ? options.store.entries().then(
          (rows) => {
            for (const { value } of rows) {
              if (this.loadingPurges.some((sinceISO) => value.atISO >= sinceISO)) {
                continue;
              }
              const k = key(value.holderId, value.proposition);
              const current = this.beliefs.get(k);
              if (!current || current.atISO < value.atISO) {
                this.beliefs.set(k, value);
              }
            }
            this.loading = false;
          },
          (error: unknown) => {
            this.loading = false;
            this.onError(error);
          },
        )
      : Promise.resolve();
  }

  /** Record what someone knows, believes, lacks, seeks or wants. */
  record(input: {
    readonly holderId: string;
    readonly stance: MindStance;
    readonly proposition: string;
    readonly confidence: number;
    readonly provenance: MindProvenance;
  }): Belief {
    const proposition = input.proposition.trim();
    if (!input.holderId.trim() || !proposition) {
      throw new Error("A belief needs a holder and a proposition.");
    }
    const raw = clampConfidence(input.confidence);
    const k = key(input.holderId, proposition);
    const previous = this.beliefs.get(k);
    const belief: Belief = {
      id: previous?.id ?? newEntityId("belief", this.now()),
      holderId: input.holderId,
      stance: input.stance,
      proposition,
      confidence: input.provenance === "inferred" ? Math.min(INFERENCE_CEILING, raw) : raw,
      provenance: input.provenance,
      atISO: new Date(this.now()).toISOString(),
    };
    this.beliefs.set(k, belief);
    const store = this.store;
    if (store) {
      const snapshot = structuredClone(belief);
      this.writes = this.writes.then(() =>
        store.register(snapshot.id, snapshot).catch((error: unknown) => this.onError(error)),
      );
    }
    return structuredClone(belief);
  }

  /** Everything modeled about one person, most confident first. */
  about(holderId: string): ReadonlyArray<Belief> {
    return structuredClone(
      [...this.beliefs.values()]
        .filter((b) => b.holderId === holderId)
        .toSorted((a, b) => b.confidence - a.confidence),
    );
  }

  /**
   * Does `holderId` know `proposition`? Answers with the stance, confidence and
   * provenance, or "unknown" when nothing is modeled: absence is not ignorance.
   */
  knows(
    holderId: string,
    proposition: string,
  ):
    | { readonly answer: "unknown" }
    | {
        readonly answer: MindStance;
        readonly confidence: number;
        readonly provenance: MindProvenance;
        readonly inference: boolean;
      } {
    const belief = this.beliefs.get(key(holderId, proposition));
    if (!belief) {
      return { answer: "unknown" };
    }
    return {
      answer: belief.stance,
      confidence: belief.confidence,
      provenance: belief.provenance,
      inference: belief.provenance === "inferred",
    };
  }

  /** People modeled as knowing something whose text contains `fragment`. */
  whoKnows(fragment: string): ReadonlyArray<Belief> {
    const wanted = fragment.trim().toLowerCase();
    return structuredClone(
      [...this.beliefs.values()].filter(
        (b) => b.stance === "knows" && b.proposition.toLowerCase().includes(wanted),
      ),
    );
  }

  /** Forget beliefs learned during a requested session, including durable copies. */
  forgetSince(sinceISO: string): number {
    if (!Number.isFinite(Date.parse(sinceISO))) {
      throw new Error("forgetSince needs a valid ISO timestamp.");
    }
    if (this.loading) {
      this.loadingPurges.push(sinceISO);
    }

    const ids = [...this.beliefs.values()]
      .filter((belief) => belief.atISO >= sinceISO)
      .map((belief) => belief.id);
    if (ids.length > 0) {
      const drop = new Set(ids);
      for (const [beliefKey, belief] of this.beliefs) {
        if (drop.has(belief.id)) {
          this.beliefs.delete(beliefKey);
        }
      }
    }

    const store = this.store;
    if (store) {
      this.writes = this.writes.then(async () => {
        await this.ready;
        for (const row of await store.entries()) {
          if (row.value.atISO >= sinceISO) {
            try {
              await store.delete(row.key);
            } catch (error) {
              this.onError(error);
            }
          }
        }
      });
    }
    return ids.length;
  }

  async flush(): Promise<void> {
    await this.ready;
    await this.writes;
  }
}
