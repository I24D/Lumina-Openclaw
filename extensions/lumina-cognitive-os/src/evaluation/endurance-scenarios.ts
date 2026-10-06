/**
 * endurance-scenarios.ts — Long-term operation on a fast clock (Lumina spec §142).
 *
 * A simulated week of a webcam seeing the owner and the desk every ten
 * seconds, interleaved with event storms, run against a sandbox runtime. It
 * looks for what a real week would reveal: database growth, task buildup,
 * event storms that swamp attention, and state corruption. Memory leaks of the
 * process itself are measured live by the brainstem, not here.
 */
import { coreEvent } from "../events/catalog.js";
import { MemoryStateStore } from "../shared/state-store.js";
import type { Observation } from "../world/world-model.js";
import { observedEvent } from "../world/world-perception.js";
import { HOUR, type Scenario } from "./eval-sandbox.js";

const DAY = 24 * HOUR;
const FRAME_MS = 10_000;

/** The sighting log of one run, so the scenario can count stored rows. */
function weekOfSightings(): Scenario {
  let store: MemoryStateStore<Observation> | undefined;
  return {
    suite: "endurance",
    name: "a week of sightings stores a row per five minutes, not per frame",
    options: () => {
      store = new MemoryStateStore<Observation>();
      return { stores: { world: store } };
    },
    run: async (rt, clock) => {
      const owner = rt.people.owner();
      const id = `person:${owner?.id ?? "owner"}`;
      const start = clock.now;
      let frames = 0;
      // Eight waking hours a day for a week, a frame every ten seconds.
      for (let day = 0; day < 7; day++) {
        clock.now = start + day * DAY;
        for (let t = 0; t < 8 * HOUR; t += FRAME_MS) {
          clock.now += FRAME_MS;
          frames += 1;
          rt.router.ingest(
            observedEvent("camera", {
              id,
              kind: "person",
              label: owner?.name ?? "owner",
              position: { placeId: "desk" },
              confidence: 0.9,
              source: "sensor",
            }),
          );
        }
      }
      await rt.world.flush();
      const rows = (await store?.entries())?.length ?? 0;
      const ceiling = 7 * 8 * 12 + 7;
      return rows > 0 && rows <= ceiling && rt.world.query({ kind: "person" }).length === 1
        ? undefined
        : `${rows} stored rows for ${frames} frames (ceiling ${ceiling})`;
    },
  };
}

export const ENDURANCE_SCENARIOS: ReadonlyArray<Scenario> = [
  weekOfSightings(),
  {
    suite: "endurance",
    name: "an event storm leaves attention bounded and the audit intact",
    run: async (rt) => {
      for (let i = 0; i < 20_000; i++) {
        rt.router.ingest(coreEvent("screen", "screen.changed", { changedRatio: (i % 100) / 100 }));
      }
      const pending = rt.router.pending;
      const recent = rt.router.recent(1_000).length;
      const audit = rt.audit.verify();
      return pending <= 64 && recent <= 128 && audit.ok
        ? undefined
        : `pending ${pending}, recent ${recent}, audit ${audit.ok}`;
    },
  },
  {
    suite: "endurance",
    name: "the attention queue drains after a burst instead of building up",
    run: async (rt) => {
      for (let i = 0; i < 500; i++) {
        rt.router.ingest(
          coreEvent("eval", "person.detected", { label: `visitor ${i}`, confidence: 0.9 }),
        );
      }
      for (let i = 0; i < 200 && rt.router.pending > 0; i++) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 5);
        });
      }
      return rt.router.pending === 0 ? undefined : `${rt.router.pending} events still waiting`;
    },
  },
  {
    suite: "endurance",
    name: "a month of overrides and privacy changes keeps the audit chain verifiable",
    run: async (rt, clock) => {
      for (let day = 0; day < 30; day++) {
        clock.now += DAY;
        await rt.safety.override({ type: "pause" }, { channel: "owner", actor: "endurance" });
        await rt.safety.override({ type: "resume" }, { channel: "owner", actor: "endurance" });
        rt.privacy.set({ privateMode: day % 2 === 0 }, { channel: "owner", actor: "endurance" });
      }
      const audit = rt.audit.verify();
      return audit.ok && audit.entries >= 90 ? undefined : `audit ${JSON.stringify(audit)}`;
    },
  },
];
