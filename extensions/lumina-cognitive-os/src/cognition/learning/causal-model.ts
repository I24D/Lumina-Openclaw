/**
 * causal-model.ts — What Lumina's actions cause, kept apart from what merely happens together.
 *
 * Lumina spec §123: build, gradually, "action → observed consequence", and
 * separate correlation from causality. The separation is by construction:
 *   - interventions: Lumina chose to act (a body intent, a tool call) and saw
 *     the outcome. Because she did it, the outcome is evidence of what the
 *     action causes, per action: how often it ran, how often it did what was
 *     expected, and what went wrong;
 *   - correlations: two kinds of events that tend to follow each other within a
 *     minute without Lumina doing anything. They are reported with their lift
 *     and always labelled as correlation, never as cause.
 * Counts are small aggregates, persisted so the model grows across days.
 */
import type { CognitiveEvent } from "../../contracts/attention.js";
import type { EmbodiedResult } from "../../embodiment/embodied-controller.js";
import { payloadOf } from "../../events/catalog.js";
import type { StateStorePort } from "../../shared/state-store.js";

export type CausalStats = {
  readonly key: string;
  readonly kind: "intervention" | "correlation" | "frequency";
  /** For an intervention: the action. For a correlation: "A -> B". */
  readonly subject: string;
  readonly count: number;
  /** Interventions: times the expected effect held. Correlations: times B followed A. */
  readonly held: number;
  readonly lastDetail?: string;
  readonly updatedAtISO: string;
};

const WINDOW_MS = 60_000;
const MAX_KEYS = 2_000;
/** Kinds too frequent or too internal to say anything about the world. */
const IGNORED = new Set([
  "screen.changed",
  "tool.completed",
  "memory.retrieved",
  "subsystem.health",
]);

export class CausalModel {
  private readonly stats = new Map<string, CausalStats>();
  private recent: Array<{ readonly kind: string; readonly atMs: number }> = [];
  private readonly now: () => number;
  private writes: Promise<void> = Promise.resolve();
  readonly ready: Promise<void>;

  constructor(
    private readonly options: {
      readonly store?: StateStorePort<CausalStats>;
      readonly now?: () => number;
      readonly onError?: (error: unknown) => void;
    } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.ready = (async () => {
      try {
        for (const { value } of (await options.store?.entries()) ?? []) {
          this.stats.set(value.key, value);
        }
      } catch (error) {
        options.onError?.(error);
      }
    })();
  }

  private bump(
    key: string,
    kind: CausalStats["kind"],
    subject: string,
    held: boolean,
    detail?: string,
  ) {
    const previous = this.stats.get(key);
    if (!previous && this.stats.size >= MAX_KEYS) {
      return;
    }
    const next: CausalStats = {
      key,
      kind,
      subject,
      count: (previous?.count ?? 0) + 1,
      held: (previous?.held ?? 0) + (held ? 1 : 0),
      ...(detail
        ? { lastDetail: detail }
        : previous?.lastDetail
          ? { lastDetail: previous.lastDetail }
          : {}),
      updatedAtISO: new Date(this.now()).toISOString(),
    };
    this.stats.set(key, next);
    const store = this.options.store;
    if (store) {
      this.writes = this.writes.then(() =>
        store.register(key, next).catch((error: unknown) => this.options.onError?.(error)),
      );
    }
  }

  /** A body action Lumina took and what came of it. */
  recordBody(result: EmbodiedResult): void {
    if (!result.outcome || result.intent.type === "stop") {
      return;
    }
    const action = `body.${result.intent.type}`;
    this.bump(`i:${action}`, "intervention", action, result.outcome.ok, result.outcome.detail);
  }

  /** Every event: tool outcomes are interventions; the rest feed co-occurrence. */
  observe(event: CognitiveEvent): void {
    const tool = payloadOf(event, "tool.completed");
    if (tool) {
      const action = `tool.${tool.tool}`;
      this.bump(`i:${action}`, "intervention", action, tool.ok);
      return;
    }
    if (IGNORED.has(event.kind)) {
      return;
    }
    const atMs = Date.parse(event.atISO) || this.now();
    this.recent = this.recent.filter((r) => atMs - r.atMs <= WINDOW_MS);
    for (const before of new Set(this.recent.map((r) => r.kind))) {
      if (before !== event.kind) {
        this.bump(`c:${before}>${event.kind}`, "correlation", `${before} -> ${event.kind}`, true);
      }
    }
    this.bump(`k:${event.kind}`, "frequency", event.kind, true);
    this.recent.push({ kind: event.kind, atMs });
  }

  /** What Lumina's own actions caused: how reliably each did what it was meant to. */
  interventions(): ReadonlyArray<CausalStats & { readonly reliability: number }> {
    return [...this.stats.values()]
      .filter((s) => s.kind === "intervention")
      .map((s) => Object.assign({}, s, { reliability: Math.round((s.held / s.count) * 100) / 100 }))
      .toSorted((a, b) => b.count - a.count);
  }

  /**
   * Events that tend to follow each other. Lift above 1 means B follows A more
   * often than B happens at all; it is still only correlation.
   */
  correlations(
    minCount = 3,
  ): ReadonlyArray<CausalStats & { readonly lift: number; readonly note: string }> {
    const frequency = new Map(
      [...this.stats.values()]
        .filter((s) => s.kind === "frequency")
        .map((s) => [s.subject, s.count]),
    );
    const total = [...frequency.values()].reduce((n, c) => n + c, 0) || 1;
    return [...this.stats.values()]
      .filter((s) => s.kind === "correlation" && s.count >= minCount)
      .map((s) => {
        const [a = "", b = ""] = s.subject.split(" -> ");
        const pa = (frequency.get(a) ?? 0) / total;
        const pb = (frequency.get(b) ?? 0) / total;
        const lift = pa > 0 && pb > 0 ? Math.round((s.count / total / (pa * pb)) * 100) / 100 : 0;
        return Object.assign({}, s, { lift, note: "correlation, not causation" });
      })
      .toSorted((x, y) => y.lift - x.lift || y.count - x.count);
  }

  async flush(): Promise<void> {
    await this.ready;
    await this.writes;
  }
}
