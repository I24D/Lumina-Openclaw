/**
 * biometrics.ts — Face and voice templates, kept only with consent.
 *
 * Lumina spec §4.4 (relational memory: face and voice embeddings), §7, §8 and
 * §97 to §99 (privacy and local data control). A template is stored only for
 * a person whose consent for that modality the owner granted
 * (`PeopleRegistry.canRecognize`), and consent is checked again every time the
 * gallery is read, so revoking it stops recognition at once even before the
 * stored template is deleted. Forgetting a person or revoking consent deletes
 * the templates for real.
 *
 * Templates are unit vectors from a recognizer model (SFace for faces); this
 * module never sees an image or a recording.
 */
import type { StateStorePort } from "../shared/state-store.js";
import type { PeopleRegistry } from "./people.js";

export const BIOMETRIC_MODALITIES = ["face", "voice"] as const;
export type BiometricModality = (typeof BIOMETRIC_MODALITIES)[number];

export type BiometricRecord = {
  readonly personId: string;
  readonly modality: BiometricModality;
  readonly samples: ReadonlyArray<ReadonlyArray<number>>;
  readonly updatedAtISO: string;
};

export type BiometricResult =
  | { readonly ok: true; readonly samples: number }
  | { readonly ok: false; readonly reason: string };

/** A few samples per person cover lighting and angle; more only slows matching. */
const MAX_SAMPLES = 5;
const MAX_DIMENSIONS = 1024;

const key = (modality: BiometricModality, personId: string) => `${modality}:${personId}`;

export class BiometricGallery {
  private readonly records = new Map<string, BiometricRecord>();
  private readonly store: StateStorePort<BiometricRecord> | undefined;
  private readonly people: PeopleRegistry;
  private readonly now: () => number;
  private readonly onError: (error: unknown) => void;
  private writes: Promise<void>;
  /** Resolves once stored templates are loaded; nothing is written before. */
  readonly ready: Promise<void>;

  constructor(options: {
    readonly people: PeopleRegistry;
    readonly store?: StateStorePort<BiometricRecord>;
    readonly now?: () => number;
    readonly onError?: (error: unknown) => void;
  }) {
    this.people = options.people;
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.onError = options.onError ?? (() => undefined);
    this.ready = this.load();
    this.writes = this.ready;
  }

  private async load(): Promise<void> {
    if (!this.store) {
      return;
    }
    try {
      for (const { value } of await this.store.entries()) {
        this.records.set(key(value.modality, value.personId), value);
      }
    } catch (error) {
      this.onError(error);
    }
  }

  private persist(action: (store: StateStorePort<BiometricRecord>) => Promise<unknown>): void {
    const store = this.store;
    if (!store) {
      return;
    }
    this.writes = this.writes.then(() =>
      action(store).then(
        () => undefined,
        (error: unknown) => this.onError(error),
      ),
    );
  }

  /** Add a template for a consenting person; the oldest sample goes past the limit. */
  add(
    personId: string,
    modality: BiometricModality,
    sample: ReadonlyArray<number>,
  ): BiometricResult {
    if (!this.people.get(personId)) {
      return { ok: false, reason: `No registered person ${personId}.` };
    }
    if (!this.people.canRecognize(personId, modality)) {
      return {
        ok: false,
        reason: `${modality} recognition needs the person's consent, granted by the owner in the Lumina tab.`,
      };
    }
    if (
      sample.length === 0 ||
      sample.length > MAX_DIMENSIONS ||
      !sample.every((v) => Number.isFinite(v))
    ) {
      return { ok: false, reason: "The template is not a finite vector." };
    }
    const id = key(modality, personId);
    const previous = this.records.get(id)?.samples ?? [];
    const record: BiometricRecord = {
      personId,
      modality,
      samples: [...previous, [...sample]].slice(-MAX_SAMPLES),
      updatedAtISO: new Date(this.now()).toISOString(),
    };
    this.records.set(id, record);
    this.persist((store) => store.register(id, record));
    return { ok: true, samples: record.samples.length };
  }

  /** Delete a person's templates for one modality, or for all of them. */
  remove(personId: string, modality?: BiometricModality): number {
    let removed = 0;
    for (const m of modality ? [modality] : BIOMETRIC_MODALITIES) {
      const id = key(m, personId);
      if (this.records.delete(id)) {
        removed++;
        this.persist((store) => store.delete(id));
      }
    }
    return removed;
  }

  /** Templates usable right now: only people who still exist and still consent. */
  gallery(modality: BiometricModality): ReadonlyArray<{
    readonly personId: string;
    readonly samples: ReadonlyArray<ReadonlyArray<number>>;
  }> {
    return [...this.records.values()]
      .filter((r) => r.modality === modality && this.people.canRecognize(r.personId, modality))
      .map((r) => ({ personId: r.personId, samples: r.samples }));
  }

  /** Who has templates, and how many, without exposing them. */
  summary(): ReadonlyArray<{
    readonly personId: string;
    readonly modality: BiometricModality;
    readonly samples: number;
  }> {
    return [...this.records.values()].map((r) => ({
      personId: r.personId,
      modality: r.modality,
      samples: r.samples.length,
    }));
  }

  /** Resolves once every queued write has been attempted. */
  flush(): Promise<void> {
    return this.writes;
  }
}
