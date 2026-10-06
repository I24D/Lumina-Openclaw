/**
 * Tests for consented face and voice templates.
 */
import { describe, expect, it } from "vitest";
import { MemoryStateStore } from "../shared/state-store.js";
import { BiometricGallery, type BiometricRecord } from "./biometrics.js";
import { PeopleRegistry } from "./people.js";

const OWNER = { channel: "owner", actor: "test" } as const;

const setup = (store = new MemoryStateStore<BiometricRecord>()) => {
  const people = new PeopleRegistry();
  const dal = people.remember({ name: "Dal" }, OWNER);
  if (!dal.ok) {
    throw new Error("setup");
  }
  return { people, store, dalId: dal.person.id, gallery: new BiometricGallery({ people, store }) };
};

describe("BiometricGallery", () => {
  it("stores a template only with consent for that modality", () => {
    const { people, gallery, dalId } = setup();
    expect(gallery.add(dalId, "face", [1, 0]).ok).toBe(false);
    people.setConsent(dalId, { faceRecognition: true }, OWNER);
    expect(gallery.add(dalId, "face", [1, 0])).toEqual({ ok: true, samples: 1 });
    expect(gallery.add(dalId, "voice", [1, 0]).ok).toBe(false);
  });

  it("stops using a template the moment consent is revoked", () => {
    const { people, gallery, dalId } = setup();
    people.setConsent(dalId, { faceRecognition: true }, OWNER);
    gallery.add(dalId, "face", [1, 0]);
    people.setConsent(dalId, { faceRecognition: false }, OWNER);
    expect(gallery.gallery("face")).toEqual([]);
  });

  it("keeps the latest five samples and refuses non-finite vectors", () => {
    const { people, gallery, dalId } = setup();
    people.setConsent(dalId, { voiceRecognition: true }, OWNER);
    for (let i = 0; i < 7; i++) {
      gallery.add(dalId, "voice", [i, 1]);
    }
    expect(gallery.gallery("voice")[0]?.samples.map((s) => s[0])).toEqual([2, 3, 4, 5, 6]);
    expect(gallery.add(dalId, "voice", [Number.NaN]).ok).toBe(false);
  });

  it("persists, reloads and deletes for real", async () => {
    const first = setup();
    first.people.setConsent(first.dalId, { faceRecognition: true }, OWNER);
    first.gallery.add(first.dalId, "face", [0.6, 0.8]);
    await first.gallery.flush();

    const reloaded = new BiometricGallery({ people: first.people, store: first.store });
    await reloaded.ready;
    expect(reloaded.summary()).toEqual([{ personId: first.dalId, modality: "face", samples: 1 }]);

    expect(reloaded.remove(first.dalId)).toBe(1);
    await reloaded.flush();
    expect(await first.store.entries()).toEqual([]);
  });
});
