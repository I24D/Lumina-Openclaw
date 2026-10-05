/**
 * people.ts — The people Lumina knows, and what each of them allowed.
 *
 * M3GAN spec §4.4 (relational memory: name, relationship, preferences, known
 * history, communication style, important dates, permissions), §67 (people
 * view), §93 (user model: preferences, language, knowledge level, routine) and
 * §7/§8 (face and voice recognition only when authorized, with consent).
 *
 * Authority stays with people, enforced here rather than trusted to a prompt:
 *
 *   roles       only the owner channel assigns them (safety/authority.ts); the
 *               agent can never register itself, nor make anyone owner
 *   consent     granting face/voice recognition or recording needs the owner
 *               channel; withdrawing it is accepted from anyone
 *   forgetting  a person can be removed for real on request
 *
 * Biometric templates themselves are not stored here (no camera or voice
 * model is connected yet: INTERFACE ONLY). `canRecognize` is the gate any
 * future recognizer must pass.
 */
import { checkRoleAssignment, isRole, isSelfId, type Role } from "../safety/authority.js";
import { newEntityId } from "../shared/ids.js";
import type { StateStorePort } from "../shared/state-store.js";

export type Consent = {
  readonly faceRecognition: boolean;
  readonly voiceRecognition: boolean;
  readonly recording: boolean;
};

export type Person = {
  readonly id: string;
  readonly name: string;
  readonly aliases: ReadonlyArray<string>;
  /** "unknown" until the owner assigns a role. */
  readonly role: Role | "unknown";
  readonly relationship?: string;
  readonly preferences: Readonly<Record<string, string>>;
  readonly communicationStyle?: string;
  readonly language?: string;
  readonly knowledgeLevel?: string;
  readonly routine: ReadonlyArray<string>;
  readonly importantDates: ReadonlyArray<{ readonly label: string; readonly date: string }>;
  readonly notes: ReadonlyArray<string>;
  readonly consent: Consent;
  /** The matching person entity in the world model, once linked. */
  readonly worldEntityId?: string;
  readonly createdAtISO: string;
  readonly updatedAtISO: string;
  readonly lastInteractionISO?: string;
};

export type PersonInput = {
  readonly name: string;
  readonly aliases?: ReadonlyArray<string>;
  readonly relationship?: string;
  readonly preferences?: Readonly<Record<string, string>>;
  readonly communicationStyle?: string;
  readonly language?: string;
  readonly knowledgeLevel?: string;
  readonly routine?: ReadonlyArray<string>;
  readonly importantDates?: ReadonlyArray<{ readonly label: string; readonly date: string }>;
  readonly note?: string;
  readonly worldEntityId?: string;
};

export type Channel = { readonly channel: "owner" | "agent"; readonly actor: string };

export type PeopleResult =
  | { readonly ok: true; readonly person: Person }
  | { readonly ok: false; readonly reason: string; readonly tamper: boolean };

const NO_CONSENT: Consent = { faceRecognition: false, voiceRecognition: false, recording: false };

function normalize(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, " ");
}

export class PeopleRegistry {
  private readonly people = new Map<string, Person>();
  private readonly now: () => number;
  private readonly store: StateStorePort<Person> | undefined;
  private readonly onError: (error: unknown) => void;
  private writes: Promise<void> = Promise.resolve();
  readonly ready: Promise<void>;

  constructor(
    options: {
      readonly store?: StateStorePort<Person>;
      readonly now?: () => number;
      readonly onError?: (error: unknown) => void;
    } = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.store = options.store;
    this.onError = options.onError ?? (() => undefined);
    this.ready = options.store
      ? options.store.entries().then(
          (rows) => {
            for (const { value } of rows) {
              // People added this session before loading finished win over stored copies.
              if (!this.people.has(value.id)) {
                this.people.set(value.id, value);
              }
            }
          },
          (error: unknown) => this.onError(error),
        )
      : Promise.resolve();
  }

  list(): ReadonlyArray<Person> {
    return structuredClone([...this.people.values()]).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  get(id: string): Person | undefined {
    const person = this.people.get(id);
    return person ? structuredClone(person) : undefined;
  }

  /** By id, name or alias (accent and case insensitive). */
  find(idOrName: string): Person | undefined {
    const byId = this.get(idOrName);
    if (byId) {
      return byId;
    }
    const wanted = normalize(idOrName);
    for (const person of this.people.values()) {
      if (
        normalize(person.name) === wanted ||
        person.aliases.some((a) => normalize(a) === wanted)
      ) {
        return structuredClone(person);
      }
    }
    return undefined;
  }

  owner(): Person | undefined {
    return this.list().find((p) => p.role === "owner");
  }

  /** Create or update a person by name. Never changes role or consent. */
  remember(input: PersonInput, by: Channel): PeopleResult {
    const name = input.name.trim();
    if (!name) {
      return { ok: false, reason: "A person needs a name.", tamper: false };
    }
    if (isSelfId(name)) {
      return {
        ok: false,
        reason: "The agent is not a person in the registry and cannot hold authority.",
        tamper: by.channel !== "owner",
      };
    }
    const nowISO = new Date(this.now()).toISOString();
    const existing = this.find(name);
    const merged: Person = existing
      ? {
          ...existing,
          aliases: [...new Set([...existing.aliases, ...(input.aliases ?? [])])],
          preferences: { ...existing.preferences, ...input.preferences },
          routine: [...new Set([...existing.routine, ...(input.routine ?? [])])],
          importantDates: [...existing.importantDates, ...(input.importantDates ?? [])],
          notes: input.note ? [...existing.notes, input.note] : existing.notes,
          ...(input.relationship ? { relationship: input.relationship } : {}),
          ...(input.communicationStyle ? { communicationStyle: input.communicationStyle } : {}),
          ...(input.language ? { language: input.language } : {}),
          ...(input.knowledgeLevel ? { knowledgeLevel: input.knowledgeLevel } : {}),
          ...(input.worldEntityId ? { worldEntityId: input.worldEntityId } : {}),
          updatedAtISO: nowISO,
        }
      : {
          id: newEntityId("person", this.now()),
          name,
          aliases: [...(input.aliases ?? [])],
          role: "unknown",
          preferences: { ...input.preferences },
          routine: [...(input.routine ?? [])],
          importantDates: [...(input.importantDates ?? [])],
          notes: input.note ? [input.note] : [],
          consent: NO_CONSENT,
          ...(input.relationship ? { relationship: input.relationship } : {}),
          ...(input.communicationStyle ? { communicationStyle: input.communicationStyle } : {}),
          ...(input.language ? { language: input.language } : {}),
          ...(input.knowledgeLevel ? { knowledgeLevel: input.knowledgeLevel } : {}),
          ...(input.worldEntityId ? { worldEntityId: input.worldEntityId } : {}),
          createdAtISO: nowISO,
          updatedAtISO: nowISO,
        };
    this.save(merged);
    return { ok: true, person: structuredClone(merged) };
  }

  /** Only the owner assigns roles (spec §23, §145). */
  setRole(id: string, role: Role, by: Channel): PeopleResult {
    const person = this.people.get(id);
    if (!person) {
      return { ok: false, reason: `No person ${id}.`, tamper: false };
    }
    if (!isRole(role)) {
      return { ok: false, reason: `Unknown role ${String(role)}.`, tamper: false };
    }
    const check = checkRoleAssignment({ personId: person.name, role, channel: by.channel });
    if (!check.ok) {
      return { ok: false, reason: check.reason, tamper: check.tamper };
    }
    const updated: Person = { ...person, role, updatedAtISO: new Date(this.now()).toISOString() };
    this.save(updated);
    return { ok: true, person: structuredClone(updated) };
  }

  /** Granting consent needs the owner channel; withdrawing it is always accepted. */
  setConsent(id: string, change: Partial<Consent>, by: Channel): PeopleResult {
    const person = this.people.get(id);
    if (!person) {
      return { ok: false, reason: `No person ${id}.`, tamper: false };
    }
    const grants = (Object.keys(change) as Array<keyof Consent>).some(
      (k) => change[k] === true && !person.consent[k],
    );
    if (grants && by.channel !== "owner") {
      return {
        ok: false,
        reason: "Consent to be recognized or recorded is given by a person, not by the agent.",
        tamper: true,
      };
    }
    const updated: Person = {
      ...person,
      consent: { ...person.consent, ...change },
      updatedAtISO: new Date(this.now()).toISOString(),
    };
    this.save(updated);
    return { ok: true, person: structuredClone(updated) };
  }

  /** Whether a recognizer may identify this person by face or voice. */
  canRecognize(id: string, kind: "face" | "voice"): boolean {
    const consent = this.people.get(id)?.consent;
    return kind === "face" ? consent?.faceRecognition === true : consent?.voiceRecognition === true;
  }

  touch(id: string): void {
    const person = this.people.get(id);
    if (person) {
      this.save({ ...person, lastInteractionISO: new Date(this.now()).toISOString() });
    }
  }

  /** Forget a person for real (spec §68, §97). */
  forget(id: string): boolean {
    const existed = this.people.delete(id);
    const store = this.store;
    if (existed && store) {
      this.writes = this.writes.then(() =>
        store.delete(id).then(
          () => undefined,
          (error: unknown) => this.onError(error),
        ),
      );
    }
    return existed;
  }

  async flush(): Promise<void> {
    await this.ready;
    await this.writes;
  }

  private save(person: Person): void {
    this.people.set(person.id, person);
    const store = this.store;
    if (store) {
      const snapshot = structuredClone(person);
      this.writes = this.writes.then(() =>
        store.register(snapshot.id, snapshot).catch((error: unknown) => this.onError(error)),
      );
    }
  }
}
