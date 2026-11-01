/**
 * Tests for the event digest.
 *
 * Two invariants carry the weight: the digest never contains message content,
 * and one fact reported by two agents is one line, not two.
 */
import { describe, expect, it } from "vitest";
import {
  buildEventDigest,
  renderEventDigest,
  type DigestEvent,
  type DigestPriority,
} from "./event-digest.js";

function event(overrides: Partial<DigestEvent> & { readonly message_id: string }): DigestEvent {
  return {
    origin: "openclaw-gateway",
    topic: "task.handoff",
    event_type: "task.claimed",
    priority: 2,
    at: "2026-10-31T12:00:00.000Z",
    kind: "work",
    ...overrides,
  };
}

describe("deduplication", () => {
  it("drops a repeated message id", () => {
    const digest = buildEventDigest([
      event({ message_id: "msg_a" }),
      event({ message_id: "msg_a", at: "2026-10-31T12:05:00.000Z" }),
    ]);
    expect(digest.counts.events).toBe(2);
    expect(digest.counts.unique).toBe(1);
    expect(digest.counts.duplicateMessages).toBe(1);
    expect(digest.entries[0]?.occurrences).toBe(1);
  });

  it("merges two agents reporting one fact into one corroborated line", () => {
    const digest = buildEventDigest([
      event({ message_id: "msg_a", origin: "openclaw-gateway", source_ref: "task:T1" }),
      event({
        message_id: "msg_b",
        origin: "muse",
        source_ref: "task:T1",
        at: "2026-10-31T12:01:00.000Z",
      }),
    ]);
    expect(digest.counts.unique).toBe(1);
    expect(digest.counts.mergedBySourceRef).toBe(1);
    const entry = digest.entries[0];
    expect(entry?.occurrences).toBe(2);
    expect(entry?.origins).toEqual(["openclaw-gateway", "muse"]);
    expect(entry?.message_ids).toEqual(["msg_a", "msg_b"]);
    expect(renderEventDigest(digest)).toMatch(/corroborated/u);
  });

  it("keeps the first sighting's timestamp when a later report merges", () => {
    const digest = buildEventDigest([
      event({ message_id: "msg_b", source_ref: "task:T1", at: "2026-10-31T12:09:00.000Z" }),
      event({ message_id: "msg_a", source_ref: "task:T1", at: "2026-10-31T12:01:00.000Z" }),
    ]);
    expect(digest.entries[0]?.at).toBe("2026-10-31T12:01:00.000Z");
    // Processed oldest first, so the first id recorded is the earliest event.
    expect(digest.entries[0]?.message_ids[0]).toBe("msg_a");
  });

  it("lets the loudest report set the priority, so a failure is not buried", () => {
    const digest = buildEventDigest([
      event({ message_id: "msg_a", source_ref: "task:T1", priority: 1 }),
      event({
        message_id: "msg_b",
        source_ref: "task:T1",
        priority: 5,
        at: "2026-10-31T12:02:00.000Z",
      }),
    ]);
    expect(digest.entries[0]?.priority).toBe(5);
    expect(digest.worstPriority).toBe(5);
  });

  it("keeps events without a source ref apart", () => {
    const digest = buildEventDigest([
      event({ message_id: "msg_a" }),
      event({ message_id: "msg_b" }),
    ]);
    expect(digest.counts.unique).toBe(2);
    expect(digest.counts.mergedBySourceRef).toBe(0);
  });

  it("keeps different source refs apart", () => {
    const digest = buildEventDigest([
      event({ message_id: "msg_a", source_ref: "task:T1" }),
      event({ message_id: "msg_b", source_ref: "task:T2" }),
    ]);
    expect(digest.counts.unique).toBe(2);
  });

  it("unions evidence refs across merged reports without repeating one", () => {
    const digest = buildEventDigest([
      event({ message_id: "msg_a", source_ref: "task:T1", evidence_refs: ["sha256:aaa", "run:1"] }),
      event({
        message_id: "msg_b",
        source_ref: "task:T1",
        evidence_refs: ["run:1", "sha256:bbb"],
        at: "2026-10-31T12:02:00.000Z",
      }),
    ]);
    expect(digest.entries[0]?.evidence_refs).toEqual(["sha256:aaa", "run:1", "sha256:bbb"]);
  });
});

describe("what the digest may contain", () => {
  it("falls back to topic and event type when no headline is given", () => {
    const digest = buildEventDigest([
      event({ message_id: "msg_a", topic: "review.verdict", event_type: "review.approved" }),
    ]);
    expect(digest.entries[0]?.headline).toBe("review.verdict: review.approved");
  });

  it("collapses whitespace and truncates a long headline", () => {
    const long = `${"word ".repeat(60)}end`;
    const digest = buildEventDigest([event({ message_id: "msg_a", headline: long })]);
    const headline = digest.entries[0]?.headline ?? "";
    expect(headline.length).toBeLessThanOrEqual(120);
    expect(headline).not.toMatch(/\s{2}/u);
  });

  it("carries no field that could hold a message body", () => {
    // Structural: the event type has no payload field, so there is no path from
    // a message body into a digest line. This asserts the shape stays that way.
    const digest = buildEventDigest([
      event({ message_id: "msg_a", headline: "task claimed", evidence_refs: ["task:T1"] }),
    ]);
    const entry = digest.entries[0];
    expect(Object.keys(entry ?? {}).toSorted()).toEqual([
      "at",
      "event_type",
      "evidence_refs",
      "headline",
      "kind",
      "message_ids",
      "occurrences",
      "origin",
      "origins",
      "priority",
      "topic",
    ]);
  });
});

describe("counts and window", () => {
  it("reports the window from the oldest and newest event", () => {
    const digest = buildEventDigest([
      event({ message_id: "msg_b", at: "2026-10-31T13:00:00.000Z" }),
      event({ message_id: "msg_a", at: "2026-10-31T11:00:00.000Z" }),
    ]);
    expect(digest.window).toEqual({
      from: "2026-10-31T11:00:00.000Z",
      to: "2026-10-31T13:00:00.000Z",
    });
  });

  it("counts by kind", () => {
    const digest = buildEventDigest([
      event({ message_id: "msg_a", kind: "work" }),
      event({ message_id: "msg_b", kind: "decision" }),
      event({ message_id: "msg_c", kind: "decision" }),
    ]);
    expect(digest.counts.byKind).toEqual({ work: 1, decision: 2 });
  });

  it("handles an empty window without inventing anything", () => {
    const digest = buildEventDigest([]);
    expect(digest.counts.unique).toBe(0);
    expect(digest.worstPriority).toBeNull();
    expect(digest.window).toEqual({ from: "", to: "" });
    expect(renderEventDigest(digest)).toBe("No events in this window.");
  });
});

describe("renderEventDigest", () => {
  it("groups decisions and failures before routine work", () => {
    const digest = buildEventDigest([
      event({ message_id: "msg_a", kind: "work", headline: "claimed a task" }),
      event({ message_id: "msg_b", kind: "state", headline: "backlog is 3" }),
      event({ message_id: "msg_c", kind: "decision", headline: "merge upstream 2026.10.9" }),
      event({ message_id: "msg_d", kind: "failure", headline: "muse offline", priority: 4 }),
      event({ message_id: "msg_e", kind: "evidence", headline: "212 tests passed" }),
    ]);
    const text = renderEventDigest(digest);
    const order = ["Decisions:", "Failures:", "Work:", "Evidence:", "State:"].map((heading) =>
      text.indexOf(heading),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order.toSorted((a, b) => a - b)).toEqual(order);
  });

  it("marks priority and repeats, and lists evidence", () => {
    const digest = buildEventDigest([
      event({
        message_id: "msg_a",
        source_ref: "task:T1",
        kind: "failure",
        priority: 4,
        headline: "delivery failed",
        evidence_refs: ["sha256:aaa"],
      }),
      event({
        message_id: "msg_b",
        source_ref: "task:T1",
        kind: "failure",
        priority: 4,
        at: "2026-10-31T12:02:00.000Z",
      }),
    ]);
    const text = renderEventDigest(digest);
    expect(text).toMatch(/\[p4\] delivery failed/u);
    expect(text).toMatch(/x2/u);
    expect(text).toMatch(/evidence: sha256:aaa/u);
  });

  it("sorts the loudest first inside a group", () => {
    const digest = buildEventDigest([
      event({ message_id: "msg_a", kind: "work", priority: 1, headline: "quiet" }),
      event({ message_id: "msg_b", kind: "work", priority: 6, headline: "needs Dal" }),
    ]);
    const text = renderEventDigest(digest);
    expect(text.indexOf("needs Dal")).toBeLessThan(text.indexOf("quiet"));
  });

  it("states the dedup counts so a reader can tell what was collapsed", () => {
    const digest = buildEventDigest([
      event({ message_id: "msg_a", source_ref: "task:T1" }),
      event({ message_id: "msg_a", source_ref: "task:T1" }),
      event({ message_id: "msg_b", source_ref: "task:T1", at: "2026-10-31T12:02:00.000Z" }),
    ]);
    expect(renderEventDigest(digest)).toMatch(
      /1 distinct turns from 3 events \(1 repeated messages dropped, 1 merged by source ref\)/u,
    );
  });

  it("accepts every priority on the 1 to 6 scale", () => {
    for (const priority of [1, 2, 3, 4, 5, 6] as DigestPriority[]) {
      const digest = buildEventDigest([event({ message_id: `msg_${priority}`, priority })]);
      expect(digest.worstPriority, `priority ${priority}`).toBe(priority);
    }
  });
});
