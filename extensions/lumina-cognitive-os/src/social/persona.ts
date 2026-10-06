/**
 * persona.ts — Lumina's personality stays hers, whatever model runs.
 *
 * Lumina spec §11 (a persistent personality separate from the base model, not
 * only in a system prompt) and §128 (persona continuity). The personality
 * lives in the agent workspace's identity files (IDENTITY.md: name, avatar,
 * vibe; SOUL.md: values, style, boundaries), which OpenClaw gives to whichever
 * model is active, and in the Supabase identity memory. This module keeps the
 * continuity visible: every time those files change, a version is recorded
 * with its hash, size and time, so a change of personality is a recorded
 * event and never a silent drift, and a missing file is reported.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Probe } from "../brainstem/brainstem.js";
import { KeyedLog, type StateStorePort } from "../shared/state-store.js";

export const PERSONA_FILES = ["IDENTITY.md", "SOUL.md"] as const;

export type PersonaVersion = {
  readonly version: number;
  readonly atISO: string;
  /** SHA-256 over every persona file, in order. */
  readonly sha256: string;
  readonly files: ReadonlyArray<{
    readonly name: string;
    readonly bytes: number;
    readonly sha256: string;
  }>;
};

export type PersonaCheck =
  | { readonly status: "ok"; readonly current: PersonaVersion; readonly changed: boolean }
  | { readonly status: "missing"; readonly missing: ReadonlyArray<string> };

export class PersonaLedger {
  private versions: PersonaVersion[] = [];
  private readonly log: KeyedLog<PersonaVersion> | undefined;
  private lastCheck: PersonaCheck | undefined;
  private readonly now: () => number;
  readonly ready: Promise<void>;

  constructor(
    private readonly options: {
      readonly dir: string;
      readonly store?: StateStorePort<PersonaVersion>;
      readonly now?: () => number;
      readonly onError?: (error: unknown) => void;
    },
  ) {
    this.now = options.now ?? Date.now;
    this.log = options.store
      ? new KeyedLog(options.store, options.onError ?? (() => undefined))
      : undefined;
    this.ready = (this.log?.hydrate() ?? Promise.resolve([])).then(
      (stored) => {
        this.versions = [...stored].toSorted((a, b) => a.version - b.version);
      },
      (error: unknown) => options.onError?.(error),
    );
  }

  current(): PersonaVersion | undefined {
    return this.versions.at(-1);
  }

  history(): ReadonlyArray<PersonaVersion> {
    return structuredClone(this.versions);
  }

  /** Read the files; record a new version when they changed. */
  async check(): Promise<PersonaCheck> {
    await this.ready;
    const files: Array<{ name: string; bytes: number; sha256: string }> = [];
    const missing: string[] = [];
    for (const name of PERSONA_FILES) {
      try {
        const content = await fs.readFile(path.join(this.options.dir, name));
        files.push({
          name,
          bytes: content.byteLength,
          sha256: createHash("sha256").update(content).digest("hex"),
        });
      } catch {
        missing.push(name);
      }
    }
    if (missing.length > 0) {
      this.lastCheck = { status: "missing", missing };
      return this.lastCheck;
    }
    const sha256 = createHash("sha256")
      .update(files.map((f) => `${f.name}\0${f.sha256}`).join("\n"))
      .digest("hex");
    const previous = this.current();
    const changed = previous?.sha256 !== sha256;
    if (changed) {
      const version: PersonaVersion = {
        version: (previous?.version ?? 0) + 1,
        atISO: new Date(this.now()).toISOString(),
        sha256,
        files,
      };
      this.versions.push(version);
      this.log?.append(version);
    }
    this.lastCheck = { status: "ok", current: this.current() as PersonaVersion, changed };
    return this.lastCheck;
  }

  probe(): Probe {
    return {
      name: "persona",
      critical: false,
      check: () => {
        const last = this.lastCheck;
        if (!last) {
          return { status: "absent", detail: "Persona files not checked yet." };
        }
        return last.status === "ok"
          ? {
              status: "ok",
              detail: `Persona v${last.current.version} (${last.current.sha256.slice(0, 12)}), kept outside the model.`,
            }
          : {
              status: "degraded",
              detail: `Persona files missing: ${last.missing.join(", ")}.`,
              recommendation: "Restore IDENTITY.md and SOUL.md in the agent workspace.",
            };
      },
    };
  }

  async flush(): Promise<void> {
    await this.ready;
    await this.log?.flush();
  }
}
