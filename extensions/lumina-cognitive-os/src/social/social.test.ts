/**
 * Tests for people, presence, theory of mind and affect estimates.
 */
import { describe, expect, it } from "vitest";
import { m3ganEvent } from "../events/catalog.js";
import { MemoryStateStore } from "../shared/state-store.js";
import { WorldModel } from "../world/world-model.js";
import { AFFECT_CEILING, estimateAffect } from "./affect.js";
import { PeopleRegistry, type Person } from "./people.js";
import { presenceState } from "./presence.js";
import { INFERENCE_CEILING, MindModel } from "./theory-of-mind.js";

const NOW = Date.parse("2026-10-05T02:00:00.000Z");
const owner = { channel: "owner", actor: "Dal" } as const;
const agent = { channel: "agent", actor: "agent" } as const;

describe("PeopleRegistry", () => {
  it("remembers a person by name and merges what it learns later", () => {
    const people = new PeopleRegistry({ now: () => NOW });
    const first = people.remember({ name: "Cady", preferences: { bebida: "chocolate" } }, agent);
    const again = people.remember(
      { name: "cady", aliases: ["Cadi"], note: "estudia mejor por la mañana" },
      agent,
    );

    expect(first.ok && again.ok).toBe(true);
    const cady = people.find("Cadi");
    expect(cady?.id).toMatch(/^person_/u);
    expect(cady?.preferences).toEqual({ bebida: "chocolate" });
    expect(cady?.notes).toEqual(["estudia mejor por la mañana"]);
    expect(cady?.role).toBe("unknown");
  });

  it("lets only the owner assign roles, and never to the agent itself", () => {
    const people = new PeopleRegistry({ now: () => NOW });
    const dal = people.remember({ name: "Dal" }, owner);
    if (!dal.ok) {
      throw new Error("setup");
    }
    expect(people.setRole(dal.person.id, "owner", agent)).toMatchObject({
      ok: false,
      tamper: true,
    });
    expect(people.setRole(dal.person.id, "owner", owner).ok).toBe(true);
    expect(people.owner()?.name).toBe("Dal");

    expect(people.remember({ name: "Lumina" }, agent)).toMatchObject({ ok: false, tamper: true });
  });

  it("needs the owner to grant recognition consent, but anyone may withdraw it", () => {
    const people = new PeopleRegistry({ now: () => NOW });
    const r = people.remember({ name: "Dal" }, owner);
    if (!r.ok) {
      throw new Error("setup");
    }
    const id = r.person.id;
    expect(people.setConsent(id, { faceRecognition: true }, agent)).toMatchObject({
      ok: false,
      tamper: true,
    });
    expect(people.canRecognize(id, "face")).toBe(false);

    people.setConsent(id, { faceRecognition: true }, owner);
    expect(people.canRecognize(id, "face")).toBe(true);
    expect(people.setConsent(id, { faceRecognition: false }, agent).ok).toBe(true);
    expect(people.canRecognize(id, "face")).toBe(false);
  });

  it("persists people and forgets one for real", async () => {
    const store = new MemoryStateStore<Person>();
    const first = new PeopleRegistry({ store, now: () => NOW });
    const dal = first.remember({ name: "Dal" }, owner);
    const guest = first.remember({ name: "Visitante" }, agent);
    if (!dal.ok || !guest.ok) {
      throw new Error("setup");
    }
    first.forget(guest.person.id);
    await first.flush();

    const second = new PeopleRegistry({ store, now: () => NOW });
    await second.ready;
    expect(second.list().map((p) => p.name)).toEqual(["Dal"]);
  });
});

describe("presenceState", () => {
  it("links sightings to known people and marks who is speaking", () => {
    const world = new WorldModel({ now: () => NOW });
    world.observe({
      id: "w-dal",
      kind: "person",
      label: "Dal",
      position: { placeId: "office", distanceM: 1.2 },
      confidence: 0.97,
      source: "sensor",
    });
    world.observe({
      id: "w-x",
      kind: "person",
      label: "desconocido",
      confidence: 0.9,
      source: "sensor",
    });
    const people = new PeopleRegistry({ now: () => NOW });
    people.remember({ name: "Dal", worldEntityId: "w-dal" }, owner);

    const iso = new Date(NOW - 2000).toISOString();
    const state = presenceState({
      world,
      people,
      nowMs: NOW,
      recentEvents: [
        m3ganEvent(
          "audio",
          "speech.recognized",
          { text: "hola", confidence: 0.9, speakerId: "w-dal" },
          { atISO: iso },
        ),
        m3ganEvent(
          "vision",
          "person.detected",
          { label: "desconocido", confidence: 0.9 },
          { atISO: iso },
        ),
      ],
    });

    const dal = state.present.find((p) => p.worldId === "w-dal");
    expect(dal).toMatchObject({ name: "Dal", speaking: true, placeId: "office", distanceM: 1.2 });
    expect(state.present.find((p) => p.worldId === "w-x")?.role).toBe("unknown");
    expect(state.speakerId).toBe("w-dal");
    expect(state.arrivals).toEqual(["desconocido"]);
  });

  it("ignores speech outside the window", () => {
    const world = new WorldModel({ now: () => NOW });
    const old = new Date(NOW - 60_000).toISOString();
    const state = presenceState({
      world,
      nowMs: NOW,
      recentEvents: [
        m3ganEvent(
          "audio",
          "speech.recognized",
          { text: "hola", confidence: 0.9, speakerId: "x" },
          { atISO: old },
        ),
      ],
    });
    expect(state.speakerId).toBeUndefined();
  });
});

describe("MindModel", () => {
  it("never treats an inference about someone's mind as more than a guess", () => {
    const mind = new MindModel({ now: () => NOW });
    const b = mind.record({
      holderId: "cady",
      stance: "is_looking_for",
      proposition: "su tableta",
      confidence: 0.95,
      provenance: "inferred",
    });
    expect(b.confidence).toBe(INFERENCE_CEILING);
    expect(mind.knows("cady", "su tableta")).toMatchObject({
      answer: "is_looking_for",
      inference: true,
    });
  });

  it("answers unknown when nothing is modeled: absence is not ignorance", () => {
    expect(new MindModel().knows("dal", "la contraseña del wifi")).toEqual({ answer: "unknown" });
  });

  it("lets newer evidence replace older about the same thing", () => {
    let now = NOW;
    const mind = new MindModel({ now: () => now });
    mind.record({
      holderId: "dal",
      stance: "does_not_know",
      proposition: "La reunión se movió",
      confidence: 0.8,
      provenance: "observed",
    });
    now += 1000;
    mind.record({
      holderId: "dal",
      stance: "knows",
      proposition: "la reunión se movió",
      confidence: 0.95,
      provenance: "told",
    });

    expect(mind.about("dal")).toHaveLength(1);
    expect(mind.whoKnows("reunión").map((b) => b.holderId)).toEqual(["dal"]);
  });
});

describe("estimateAffect", () => {
  it("returns an estimate with its cues, never above the ceiling", () => {
    const e = estimateAffect({ text: "OTRA VEZ no funciona!!! estoy harto" });
    expect(e.possibleState).toBe("frustrated");
    expect(e.confidence).toBeLessThanOrEqual(AFFECT_CEILING);
    expect(e.signals.length).toBeGreaterThan(0);
    expect(e.note).toMatch(/estimate/u);
  });

  it("says neutral with low confidence when there is no cue, without concluding anything", () => {
    const e = estimateAffect({ text: "La reunión es a las cinco." });
    expect(e).toMatchObject({ possibleState: "neutral", confidence: 0.2 });
  });

  it("is less sure when cues conflict", () => {
    const clear = estimateAffect({ text: "estoy muy triste" });
    const mixed = estimateAffect({ text: "estoy triste pero qué bien que viniste" });
    expect(mixed.confidence).toBeLessThan(clear.confidence);
  });
});
