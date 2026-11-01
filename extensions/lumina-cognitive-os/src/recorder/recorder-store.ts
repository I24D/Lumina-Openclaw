/**
 * recorder-store.ts — Disk layout + read helpers for recorded sessions.
 *
 * The recorder.py sidecar writes events directly. This module only:
 *   - manages the recordings root directory
 *   - generates a fresh sessionId + folder layout
 *   - reads back manifests / event slices for the tools
 *   - applies the optional scrubbing pass (PII redaction)
 *
 * On-disk artifact layout per session:
 *
 *   <recordingsDir>/<sessionId>/
 *   ├── events.ndjson
 *   ├── screenshots/000001.png ...
 *   └── uia/000001.json ...
 *
 * Session metadata is durable plugin state in SQLite. Legacy meta.json and
 * events.jsonl recordings are imported/read for backwards compatibility.
 * The sidecar owns event/image writes during a session; this module only
 * rewrites the current event artifact when post-stop scrubbing runs.
 */
import fs from "node:fs";
import path from "node:path";
import { getLuminaEnvVar } from "../env.js";
import type { StateStorePort } from "../shared/state-store.js";
import { redactSecretsInText, type ScrubbingPolicy, defaultScrubbingPolicy } from "./scrubbing.js";

export type RecorderMode = "events" | "screencast";

export type RecordingEventWindow = {
  readonly title: string;
  readonly pid: number | null;
  readonly className: string;
};

export type RecordingEvent = {
  readonly idx: number;
  readonly atMs: number;
  readonly kind: string;
  readonly screenshot?: string | null;
  readonly uia?: string | null;
  readonly window?: RecordingEventWindow | null;
  readonly pos?: { x: number; y: number };
  readonly button?: string;
  readonly key?: string;
  readonly dx?: number;
  readonly dy?: number;
  readonly label?: string;
};

export type RecordingMeta = {
  readonly sessionId: string;
  readonly version: string;
  readonly mode: RecorderMode;
  readonly captureUia: boolean;
  readonly fpsHintHz: number;
  readonly startedAtISO: string;
  readonly stoppedAtISO?: string;
  readonly eventCount?: number;
  readonly platform: string;
  readonly python?: string;
  readonly label?: string;
};

export type RecordingSummary = {
  readonly sessionId: string;
  readonly dir: string;
  readonly mode: RecorderMode;
  readonly startedAtISO: string;
  readonly stoppedAtISO: string | null;
  readonly eventCount: number;
  readonly screenshotCount: number;
  readonly uiaSnapshotCount: number;
  readonly durationMs: number | null;
  readonly label: string | null;
  readonly sizeBytes: number;
};

const DEFAULT_RECORDINGS_DIR = "c:/I24D_WhatsApp/recordings";
export const RECORDER_METADATA_NAMESPACE = "m3gan.recorder.sessions";
const EVENTS_FILE = "events.ndjson";
const LEGACY_EVENTS_FILE = "events.jsonl";
const LEGACY_META_FILE = "meta.json";

export type RecorderStoreOptions = {
  readonly rootDir?: string;
  readonly metadataStore?: StateStorePort<RecordingMeta>;
  readonly onError?: (error: unknown) => void;
};

export function createRecorderStore(
  rootDir: string | undefined,
  openStore: (<T>(namespace: string) => StateStorePort<T>) | undefined,
  onError: (error: unknown) => void,
): RecorderStore {
  const metadataStore = openStore?.<RecordingMeta>(RECORDER_METADATA_NAMESPACE);
  return new RecorderStore({
    ...(rootDir ? { rootDir } : {}),
    ...(metadataStore ? { metadataStore } : {}),
    onError,
  });
}

export function resolveRecordingsDir(override?: string): string {
  if (override && override.trim()) {
    return path.resolve(override.trim());
  }
  const env = getLuminaEnvVar("LUMINA_RECORDINGS_DIR");
  if (env && env.trim()) {
    return path.resolve(env.trim());
  }
  return path.resolve(DEFAULT_RECORDINGS_DIR);
}

export function generateSessionId(prefix = "rec"): string {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  const rand = Math.floor(Math.random() * 0xffff)
    .toString(36)
    .padStart(4, "0");
  return `${prefix}-${stamp}-${rand}`;
}

export class RecorderStore {
  readonly rootDir: string;
  private readonly metadata = new Map<string, RecordingMeta>();
  private readonly metadataStore: StateStorePort<RecordingMeta> | undefined;
  private readonly onError: (error: unknown) => void;
  private writes: Promise<void> = Promise.resolve();
  readonly ready: Promise<void>;

  constructor(input?: string | RecorderStoreOptions) {
    const options: RecorderStoreOptions =
      typeof input === "string" ? { rootDir: input } : (input ?? {});
    this.rootDir = resolveRecordingsDir(options.rootDir);
    this.metadataStore = options.metadataStore;
    this.onError = options.onError ?? (() => undefined);
    try {
      fs.mkdirSync(this.rootDir, { recursive: true });
    } catch {
      /* lazy */
    }

    const legacy = this.scanLegacyMetadata();
    for (const meta of legacy) {
      this.metadata.set(meta.sessionId, meta);
    }

    this.ready = this.metadataStore
      ? this.metadataStore.entries().then(
          async (rows) => {
            for (const { key, value } of rows) {
              this.metadata.set(key, value);
            }
            const durableIds = new Set(rows.map((row) => row.key));
            for (const meta of legacy) {
              if (!durableIds.has(meta.sessionId)) {
                await this.metadataStore!.register(meta.sessionId, meta);
              }
            }
          },
          (error: unknown) => this.onError(error),
        )
      : Promise.resolve();
  }

  sessionDir(sessionId: string): string {
    return path.join(this.rootDir, sessionId);
  }

  prepareNewSessionDir(sessionId: string): string {
    const dir = this.sessionDir(sessionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, "screenshots"), { recursive: true });
    return dir;
  }

  private scanLegacyMetadata(): RecordingMeta[] {
    if (!fs.existsSync(this.rootDir)) {
      return [];
    }
    const out: RecordingMeta[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.rootDir, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const file = path.join(this.rootDir, entry.name, LEGACY_META_FILE);
      if (!fs.existsSync(file)) {
        continue;
      }
      try {
        const meta = JSON.parse(fs.readFileSync(file, "utf8")) as RecordingMeta;
        if (meta.sessionId && meta.startedAtISO) {
          out.push(meta);
        }
      } catch {
        /* skip malformed legacy metadata */
      }
    }
    return out;
  }

  recordMeta(meta: RecordingMeta): void {
    this.metadata.set(meta.sessionId, structuredClone(meta));
    const store = this.metadataStore;
    if (!store) {
      return;
    }
    this.writes = this.writes.then(async () => {
      await this.ready;
      await store.register(meta.sessionId, structuredClone(meta)).catch((error: unknown) => {
        this.onError(error);
      });
    });
  }

  async flush(): Promise<void> {
    await this.ready;
    await this.writes;
  }

  readMeta(sessionId: string): RecordingMeta | null {
    const cached = this.metadata.get(sessionId);
    if (cached) {
      return structuredClone(cached);
    }
    const file = path.join(this.sessionDir(sessionId), LEGACY_META_FILE);
    if (!fs.existsSync(file)) {
      return null;
    }
    try {
      const meta = JSON.parse(fs.readFileSync(file, "utf8")) as RecordingMeta;
      if (!meta.sessionId || !meta.startedAtISO) {
        return null;
      }
      this.recordMeta(meta);
      return structuredClone(meta);
    } catch {
      return null;
    }
  }

  list(): RecordingSummary[] {
    if (!fs.existsSync(this.rootDir)) {
      return [];
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.rootDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: RecordingSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const summary = this.summarize(entry.name);
      if (summary) {
        out.push(summary);
      }
    }
    return out.toSorted((a, b) => b.startedAtISO.localeCompare(a.startedAtISO));
  }

  summarize(sessionId: string): RecordingSummary | null {
    const dir = this.sessionDir(sessionId);
    const meta = this.readMeta(sessionId);
    if (!meta) {
      return null;
    }
    const screenshotsDir = path.join(dir, "screenshots");
    const uiaDir = path.join(dir, "uia");
    const screenshotCount = safeCount(screenshotsDir);
    const uiaSnapshotCount = safeCount(uiaDir);
    const eventCount = meta.eventCount ?? this.countEventLines(sessionId);
    const startedMs = Date.parse(meta.startedAtISO);
    const stoppedMs = meta.stoppedAtISO ? Date.parse(meta.stoppedAtISO) : Number.NaN;
    return {
      sessionId,
      dir,
      mode: meta.mode,
      startedAtISO: meta.startedAtISO,
      stoppedAtISO: meta.stoppedAtISO ?? null,
      eventCount,
      screenshotCount,
      uiaSnapshotCount,
      durationMs:
        Number.isFinite(startedMs) && Number.isFinite(stoppedMs) ? stoppedMs - startedMs : null,
      label: meta.label ?? null,
      sizeBytes: dirSizeShallow(dir),
    };
  }

  private eventFile(sessionId: string): string {
    const dir = this.sessionDir(sessionId);
    const current = path.join(dir, EVENTS_FILE);
    if (fs.existsSync(current)) {
      return current;
    }
    return path.join(dir, LEGACY_EVENTS_FILE);
  }

  countEventLines(sessionId: string): number {
    const file = this.eventFile(sessionId);
    if (!fs.existsSync(file)) {
      return 0;
    }
    try {
      const raw = fs.readFileSync(file, "utf8");
      return raw.split("\n").filter((l) => l.trim().length > 0).length;
    } catch {
      return 0;
    }
  }

  readEvents(sessionId: string, opts: { offset?: number; limit?: number } = {}): RecordingEvent[] {
    const file = this.eventFile(sessionId);
    if (!fs.existsSync(file)) {
      return [];
    }
    const offset = Math.max(0, opts.offset ?? 0);
    const limit = Math.min(5_000, opts.limit ?? 500);
    const out: RecordingEvent[] = [];
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return [];
    }
    const lines = raw.split("\n");
    let kept = 0;
    let skipped = 0;
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      if (skipped < offset) {
        skipped++;
        continue;
      }
      try {
        out.push(JSON.parse(line) as RecordingEvent);
        kept++;
      } catch {
        /* skip corrupt line */
      }
      if (kept >= limit) {
        break;
      }
    }
    return out;
  }

  delete(sessionId: string): boolean {
    const dir = this.sessionDir(sessionId);
    if (!fs.existsSync(dir)) {
      return false;
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      this.metadata.delete(sessionId);
      const store = this.metadataStore;
      if (store) {
        this.writes = this.writes.then(async () => {
          await this.ready;
          await store.delete(sessionId).catch((error: unknown) => {
            this.onError(error);
            return false;
          });
        });
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Apply scrubbing to the recorded event stream in place. New sessions use
   * events.ndjson; events.jsonl remains read-only legacy compatibility.
   */
  scrub(
    sessionId: string,
    policy: ScrubbingPolicy = defaultScrubbingPolicy(),
  ): { ok: boolean; redactions: number; error?: string } {
    const sourceFile = this.eventFile(sessionId);
    if (!fs.existsSync(sourceFile)) {
      return { ok: false, redactions: 0, error: "recorded event stream missing" };
    }
    const file = path.join(this.sessionDir(sessionId), EVENTS_FILE);
    let raw: string;
    try {
      raw = fs.readFileSync(sourceFile, "utf8");
    } catch (e) {
      return { ok: false, redactions: 0, error: (e as Error).message };
    }
    const lines = raw.split("\n");
    let redactions = 0;
    const out: string[] = [];
    for (const line of lines) {
      if (!line.trim()) {
        out.push(line);
        continue;
      }
      try {
        const evt = JSON.parse(line) as Record<string, unknown>;
        if (typeof evt.key === "string") {
          const before = evt.key;
          const after = redactSecretsInText(before, policy);
          if (after !== before) {
            evt.key = after;
            redactions++;
          }
        }
        out.push(JSON.stringify(evt));
      } catch {
        out.push(line);
      }
    }
    try {
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, out.join("\n"), "utf8");
      fs.renameSync(tmp, file);
      return { ok: true, redactions };
    } catch (e) {
      return { ok: false, redactions, error: (e as Error).message };
    }
  }
}

function safeCount(dir: string): number {
  if (!fs.existsSync(dir)) {
    return 0;
  }
  try {
    return fs.readdirSync(dir).length;
  } catch {
    return 0;
  }
}

function dirSizeShallow(dir: string): number {
  let total = 0;
  const stack: string[] = [dir];
  let visits = 0;
  while (stack.length > 0 && visits < 50_000) {
    const cur = stack.pop()!;
    visits++;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      try {
        const stat = fs.statSync(full);
        if (stat.isFile()) {
          total += stat.size;
        } else if (stat.isDirectory()) {
          stack.push(full);
        }
      } catch {
        /* ignore */
      }
    }
  }
  return total;
}
