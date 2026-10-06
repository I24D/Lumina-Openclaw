/**
 * Tests for the rules that let Lumina notice and propose.
 */
import { describe, expect, it, vi } from "vitest";
import { m3ganEvent } from "../../events/catalog.js";
import type { InteractionMode } from "../../safety/interaction-mode.js";
import { PeopleRegistry } from "../../social/people.js";
import type { PresenceState } from "../../social/presence.js";
import { knowledgeGap } from "../../world/curiosity.js";
import { WorldModel, type Observation } from "../../world/world-model.js";
import { CognitiveLoop } from "./cognitive-loop.js";
import { createSituationalReasoner } from "./situational-reasoner.js";

const OWNER = { channel: "owner", actor: "test" } as const;

const setup = (level: 3 | 4 = 3) => {
  let clock = Date.parse("2026-10-05T20:00:00.000Z");
  const people = new PeopleRegistry({ now: () => clock });
  const dal = people.remember({ name: "Dal" }, OWNER);
  if (!dal.ok) {
    throw new Error("setup");
  }
  people.setRole(dal.person.id, "owner", OWNER);
  const deliver = vi.fn();
  const surfaced = vi.fn();
  const reason = createSituationalReasoner({ people, deliver, now: () => clock });
  const loop = new CognitiveLoop({ level, reason, now: () => clock, onSurface: surfaced });
  const arrival = () =>
    m3ganEvent("camera", "person.detected", {
      personId: dal.person.id,
      label: "Dal",
      confidence: 0.95,
    });
  return {
    loop,
    deliver,
    surfaced,
    arrival,
    advance: (ms: number) => {
      clock += ms;
    },
  };
};

describe("situational reasoner", () => {
  it("at L3 turns the owner's arrival into a proposal, never an action", async () => {
    const { loop, deliver, surfaced, arrival } = setup(3);
    const record = await loop.handle(arrival());
    expect(record.outcome).toBe("propose");
    expect(record.action).toContain("Dal just arrived");
    expect(deliver).not.toHaveBeenCalled();
    expect(surfaced).toHaveBeenCalledOnce();
  });

  it("at L4 wakes the agent with a reversible, safe initiative", async () => {
    const { loop, deliver, arrival } = setup(4);
    const record = await loop.handle(arrival());
    expect(record.executed).toBe(true);
    expect(deliver).toHaveBeenCalledWith({
      key: "greet-owner",
      text: expect.stringContaining("greet briefly"),
    });
  });

  it("keeps quiet during a rule's cooldown", async () => {
    const { loop, deliver, arrival, advance } = setup(4);
    await loop.handle(arrival());
    advance(60_000);
    const again = await loop.handle(arrival());
    expect(again.executed).toBe(false);
    expect(deliver).toHaveBeenCalledOnce();
  });

  it("tells the owner about an unknown person without guessing who it is", async () => {
    const { loop, deliver } = setup(4);
    const record = await loop.handle(
      m3ganEvent("camera", "person.detected", { label: "unknown person", confidence: 0.9 }),
    );
    expect(record.action).toContain("unknown person");
    expect(deliver).toHaveBeenCalledOnce();
  });
});

describe("curiosity and companion mode", () => {
  const curious = (options: { present: boolean; mode?: InteractionMode }) => {
    let clock = Date.parse("2026-10-06T20:00:00.000Z");
    const people = new PeopleRegistry({ now: () => clock });
    const dal = people.remember({ name: "Dal" }, OWNER);
    if (!dal.ok) {
      throw new Error("setup");
    }
    people.setRole(dal.person.id, "owner", OWNER);
    const world = new WorldModel({ now: () => clock });
    const deliver = vi.fn();
    const presence = (): PresenceState => ({
      atISO: new Date(clock).toISOString(),
      present: options.present
        ? [
            {
              worldId: dal.person.id,
              personId: dal.person.id,
              name: "Dal",
              role: "owner",
              confidence: 0.9,
              speaking: false,
            },
          ]
        : [],
      arrivals: [],
      departures: [],
    });
    const reason = createSituationalReasoner({
      people,
      deliver,
      now: () => clock,
      world,
      presence,
      mode: () => options.mode ?? "normal",
    });
    const loop = new CognitiveLoop({ level: 4, reason, now: () => clock });
    // As the runtime does: the world model takes the sighting, curiosity raises the gap.
    const sight = async (observation: Observation) => {
      const result = world.observe(observation);
      const gap = knowledgeGap(result, m3ganEvent("camera", "world.observed", { observation }));
      return gap ? loop.handle(gap) : undefined;
    };
    return {
      loop,
      deliver,
      sight,
      speech: () =>
        m3ganEvent("microphone", "speech.detected", {
          speakerId: dal.person.id,
          confidence: 0.9,
          durationMs: 1200,
        }),
      advance: (ms: number) => {
        clock += ms;
      },
    };
  };
  const thing = (id: string, label: string): Observation => ({
    id,
    kind: "device",
    label,
    source: "sensor",
    confidence: 0.9,
  });

  it("asks about something unrecognized only when someone is there to ask", async () => {
    const alone = curious({ present: false });
    await alone.sight(thing("dev-1", "blinking box with antennas"));
    expect(alone.deliver).not.toHaveBeenCalled();

    const together = curious({ present: true });
    const record = await together.sight(thing("dev-1", "zx-9 gadget"));
    expect(record?.executed).toBe(true);
    expect(together.deliver).toHaveBeenCalledWith({
      key: "curious:dev-1",
      text: expect.stringContaining("never handle it to find out"),
    });
  });

  it("does not wonder about known things and keeps to one question per half hour", async () => {
    const { sight, deliver, advance } = curious({ present: true });
    await sight(thing("cup", "taza"));
    expect(deliver).not.toHaveBeenCalled();
    await sight(thing("dev-1", "zx-9 gadget"));
    await sight(thing("dev-2", "qq-7 widget"));
    expect(deliver).toHaveBeenCalledOnce();
    // Seen again it is no longer new; a new unknown thing waits out the budget.
    advance(31 * 60_000);
    expect(await sight(thing("dev-2", "qq-7 widget"))).toBeUndefined();
    await sight(thing("dev-3", "rr-2 contraption"));
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("checks in with the owner only in companion mode", async () => {
    const normal = curious({ present: true });
    await normal.loop.handle(normal.speech());
    expect(normal.deliver).not.toHaveBeenCalled();

    const companion = curious({ present: true, mode: "companion" });
    await companion.loop.handle(companion.speech());
    expect(companion.deliver).toHaveBeenCalledWith({
      key: "companion-check-in",
      text: expect.stringContaining("No pressure and no guilt"),
    });
  });
});
