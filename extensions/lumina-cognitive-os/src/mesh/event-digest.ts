/**
 * event-digest.ts — A human summary built from events, not from chat.
 *
 * Phase E of the mesh order: "generar resumen humano de turnos tecnicos,
 * evidencia, decision y estado desde los eventos, sin contaminar memoria con
 * textos de chat. Deduplicar por message_id y ref de fuente."
 *
 * ## What it will not do
 *
 * It never reads a message body. The input is event metadata — origin, topic,
 * event type, priority, references, hashes — and the output names *what*
 * happened and *where the evidence is*, never what anyone said. That is the
 * whole point: a digest that quoted chat would turn a coordination log into a
 * second copy of private conversation, and `shared_memory` would inherit it.
 *
 * So `DigestEvent` has no field for free text beyond a short, caller-supplied
 * `headline`, and the renderer truncates that. There is no path from a payload
 * to this module's output.
 *
 * ## Deduplication
 *
 * Two keys, both required by the order:
 *
 *   message_id   the same event relayed twice (the mesh is at-least-once, and
 *                the OpenClaw bridge mirrors some messages back into the chat)
 *   source ref   the same underlying fact reported by two agents under
 *                different message ids
 *
 * The second is what stops Muse and OpenClaw both reporting one task and the
 * digest claiming two.
 *
 * Pure: events in, text out. No clock, no I/O.
 */

/** The bus priority scale, 1 noise to 6 a decision for Dal. */
export type DigestPriority = 1 | 2 | 3 | 4 | 5 | 6;

/** What kind of turn this was, for grouping a digest a person reads. */
export type DigestKind = "work" | "evidence" | "decision" | "state" | "failure";

/** One event, reduced to what a summary may legitimately use. */
export type DigestEvent = {
  /** Dedup key one: the message that carried it. */
  readonly message_id: string;
  /**
   * Dedup key two: what the event is *about*. Two agents reporting the same
   * task, hash or artifact share this, whatever message ids they used.
   */
  readonly source_ref?: string;
  readonly origin: string;
  readonly topic: string;
  readonly event_type: string;
  readonly priority: DigestPriority;
  readonly at: string;
  readonly kind: DigestKind;
  /**
   * A short, caller-written label. Never a message body: callers pass something
   * like "task claimed" or "212 tests passed", and it is truncated.
   */
  readonly headline?: string;
  /** Where the proof is: ids and hashes, never content. */
  readonly evidence_refs?: readonly string[];
};

const HEADLINE_MAX = 120;

/**
 * The louder of two priorities. Written as a comparison rather than
 * `Math.max`, which widens to `number` and would need a type assertion back.
 */
function louder(a: DigestPriority, b: DigestPriority): DigestPriority {
  return b > a ? b : a;
}
const KIND_ORDER: readonly DigestKind[] = ["decision", "failure", "work", "evidence", "state"];

const KIND_TITLES: Readonly<Record<DigestKind, string>> = Object.freeze({
  decision: "Decisions",
  failure: "Failures",
  work: "Work",
  evidence: "Evidence",
  state: "State",
});

/** One deduplicated line of the digest. */
export type DigestEntry = {
  readonly kind: DigestKind;
  readonly origin: string;
  readonly topic: string;
  readonly event_type: string;
  readonly priority: DigestPriority;
  readonly at: string;
  readonly headline: string;
  readonly evidence_refs: readonly string[];
  /** How many events collapsed into this line, including the first. */
  readonly occurrences: number;
  /** The message ids that reported it, for an audit back to the bus. */
  readonly message_ids: readonly string[];
  /** Every origin that reported it. More than one is corroboration. */
  readonly origins: readonly string[];
};

export type EventDigest = {
  readonly window: { readonly from: string; readonly to: string };
  readonly entries: readonly DigestEntry[];
  readonly counts: {
    readonly events: number;
    readonly unique: number;
    /** Dropped as a repeat of a message id already seen. */
    readonly duplicateMessages: number;
    /** Merged onto an existing line through a shared source ref. */
    readonly mergedBySourceRef: number;
    readonly byKind: Readonly<Record<string, number>>;
  };
  /** The highest priority seen, so a reader knows whether to care. */
  readonly worstPriority: DigestPriority | null;
};

function clampHeadline(text: string | undefined, fallback: string): string {
  const value = (text ?? "").replace(/\s+/gu, " ").trim();
  return (value || fallback).slice(0, HEADLINE_MAX);
}

/**
 * Builds the digest.
 *
 * Events are processed oldest first so the first sighting of a fact sets its
 * timestamp and later reports only add corroboration. A repeated `message_id`
 * is dropped outright; a repeated `source_ref` merges, which is how two agents
 * reporting one fact become one line with two origins.
 */
export function buildEventDigest(events: readonly DigestEvent[]): EventDigest {
  const ordered = events.toSorted((a, b) => a.at.localeCompare(b.at));
  const seenMessages = new Set<string>();
  const byRef = new Map<string, DigestEntry>();
  const entries: DigestEntry[] = [];
  let duplicateMessages = 0;
  let mergedBySourceRef = 0;

  /** Merges a later sighting into the line already recorded. */
  const merge = (entry: DigestEntry, event: DigestEvent): DigestEntry => ({
    ...entry,
    occurrences: entry.occurrences + 1,
    message_ids: [...entry.message_ids, event.message_id],
    origins: entry.origins.includes(event.origin)
      ? entry.origins
      : [...entry.origins, event.origin],
    evidence_refs: [
      ...entry.evidence_refs,
      ...(event.evidence_refs ?? []).filter((ref) => !entry.evidence_refs.includes(ref)),
    ],
    // The loudest report wins, so a later failure is not hidden by an earlier
    // routine sighting of the same fact.
    priority: louder(entry.priority, event.priority),
  });

  for (const event of ordered) {
    if (seenMessages.has(event.message_id)) {
      duplicateMessages += 1;
      continue;
    }
    seenMessages.add(event.message_id);

    const key = event.source_ref;
    if (key !== undefined) {
      const existing = byRef.get(key);
      if (existing) {
        const merged = merge(existing, event);
        byRef.set(key, merged);
        entries[entries.indexOf(existing)] = merged;
        mergedBySourceRef += 1;
        continue;
      }
    }

    const entry: DigestEntry = {
      kind: event.kind,
      origin: event.origin,
      topic: event.topic,
      event_type: event.event_type,
      priority: event.priority,
      at: event.at,
      headline: clampHeadline(event.headline, `${event.topic}: ${event.event_type}`),
      evidence_refs: [...(event.evidence_refs ?? [])],
      occurrences: 1,
      message_ids: [event.message_id],
      origins: [event.origin],
    };
    entries.push(entry);
    if (key !== undefined) {
      byRef.set(key, entry);
    }
  }

  const byKind: Record<string, number> = {};
  for (const entry of entries) {
    byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1;
  }

  return {
    window: {
      from: ordered[0]?.at ?? "",
      to: ordered.at(-1)?.at ?? "",
    },
    entries,
    counts: {
      events: events.length,
      unique: entries.length,
      duplicateMessages,
      mergedBySourceRef,
      byKind: Object.freeze(byKind),
    },
    worstPriority:
      entries.length === 0
        ? null
        : entries.reduce<DigestPriority>((worst, entry) => louder(worst, entry.priority), 1),
  };
}

/**
 * Renders the digest as plain text for the LUMINA VOICE thread.
 *
 * Plain text on purpose: that thread is read by a person through a browser
 * relay that mangles markdown, and the fork's own reporting rule asks for plain
 * text with links written as paths or URLs.
 */
export function renderEventDigest(digest: EventDigest): string {
  if (digest.entries.length === 0) {
    return "No events in this window.";
  }
  const lines: string[] = [];
  lines.push(
    `${digest.counts.unique} distinct turns from ${digest.counts.events} events` +
      ` (${digest.counts.duplicateMessages} repeated messages dropped,` +
      ` ${digest.counts.mergedBySourceRef} merged by source ref)`,
  );
  lines.push(`window ${digest.window.from} to ${digest.window.to}`);
  lines.push(`highest priority ${digest.worstPriority ?? "none"}`);

  for (const kind of KIND_ORDER) {
    const group = digest.entries.filter((entry) => entry.kind === kind);
    if (group.length === 0) {
      continue;
    }
    lines.push("");
    lines.push(`${KIND_TITLES[kind]}:`);
    for (const entry of group.toSorted(
      (a, b) => b.priority - a.priority || a.at.localeCompare(b.at),
    )) {
      const who =
        entry.origins.length > 1 ? `${entry.origins.join(" + ")} (corroborated)` : entry.origin;
      const repeats = entry.occurrences > 1 ? ` x${entry.occurrences}` : "";
      lines.push(`  [p${entry.priority}] ${entry.headline} - ${who}${repeats}`);
      if (entry.evidence_refs.length > 0) {
        lines.push(`      evidence: ${entry.evidence_refs.join(", ")}`);
      }
    }
  }
  return lines.join("\n");
}
