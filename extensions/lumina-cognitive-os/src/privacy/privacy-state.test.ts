/**
 * Tests for privacy states and the router's admission gate.
 */
import { describe, expect, it, vi } from "vitest";
import { AttentionFilter } from "../cognition/attention.js";
import { ThalamicRouter } from "../cognition/router/thalamic-router.js";
import { MemoryStateStore } from "../shared/state-store.js";
import { PrivacyControls, type PrivacyState } from "./privacy-state.js";

const NOW = Date.parse("2026-10-05T02:00:00.000Z");
const ev = (source: string, kind = "x") => ({ source, kind, atISO: new Date(NOW).toISOString() });

describe("PrivacyControls", () => {
  it("lets anyone make it more private and only the owner less", () => {
    const privacy = new PrivacyControls({ now: () => NOW });
    expect(privacy.set({ camera: false }, { channel: "agent", actor: "agent" }).ok).toBe(true);

    const reopen = privacy.set({ camera: true }, { channel: "agent", actor: "agent" });
    expect(reopen).toMatchObject({ ok: false, tamper: true });
    expect(privacy.state().camera).toBe(false);

    expect(privacy.set({ camera: true }, { channel: "owner", actor: "Dal" }).ok).toBe(true);
  });

  it("drops sensor events at the source when a sensor is off", () => {
    const privacy = new PrivacyControls({ now: () => NOW });
    privacy.set({ microphone: false }, { channel: "agent", actor: "agent" });

    expect(privacy.admits(ev("microphone"))).toBe(false);
    expect(privacy.admits(ev("camera"))).toBe(true);
    expect(privacy.admits(ev("awareness"))).toBe(true);
  });

  it("stops remembering in private mode without touching the sensors", () => {
    const privacy = new PrivacyControls({ now: () => NOW });
    privacy.set({ privateMode: true }, { channel: "agent", actor: "agent" });

    expect(privacy.remembering()).toBe(false);
    expect(privacy.admits(ev("vision", "world.observed"))).toBe(false);
    expect(privacy.admits(ev("vision", "person.detected"))).toBe(true);
  });

  it("keeps sensors off until a person's stored choices are known", async () => {
    const store = new MemoryStateStore<PrivacyState>();
    const privacy = new PrivacyControls({ store, now: () => NOW });
    expect(privacy.admits(ev("camera"))).toBe(false);
    await privacy.ready;
    expect(privacy.admits(ev("camera"))).toBe(true);
  });

  it("remembers an order across a restart and reports every change", async () => {
    const store = new MemoryStateStore<PrivacyState>();
    const first = new PrivacyControls({ store, now: () => NOW });
    await first.ready;
    first.set({ camera: false }, { channel: "agent", actor: "agent" });
    await first.flush();

    const onChange = vi.fn();
    const second = new PrivacyControls({ store, now: () => NOW, onChange });
    await second.ready;
    expect(second.state().camera).toBe(false);
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("applies the owner's order given while loading, with the owner's authority", async () => {
    const store = new MemoryStateStore<PrivacyState>();
    const seed = new PrivacyControls({ store, now: () => NOW });
    await seed.ready;
    seed.set({ camera: false }, { channel: "agent", actor: "agent" });
    await seed.flush();

    const restarted = new PrivacyControls({ store, now: () => NOW });
    restarted.set({ camera: true }, { channel: "owner", actor: "Dal" });
    await restarted.ready;
    expect(restarted.state().camera).toBe(true);
  });
});

describe("router admission gate", () => {
  it("drops refused events before attention, routing and history", () => {
    const privacy = new PrivacyControls({ now: () => NOW });
    privacy.set({ camera: false }, { channel: "agent", actor: "agent" });
    const router = new ThalamicRouter({
      attention: new AttentionFilter({ threshold: 0 }),
      now: () => NOW,
      admit: (e) => privacy.admits(e),
    });
    const seen = vi.fn();
    router.subscribe({}, seen);

    const result = router.ingest({ ...ev("camera", "person.detected"), importance: 1, urgency: 1 });

    expect(result.dropped).toBe(true);
    expect(seen).not.toHaveBeenCalled();
    expect(router.recent()).toHaveLength(0);
    expect(router.pending).toBe(0);
  });
});
