import { describe, expect, it } from "vitest";
import { MemoryStateStore } from "../shared/state-store.js";
import { PeopleRegistry } from "./people.js";
import { createPracticeTool } from "./practice-tool.js";
import { PracticeBook, PracticeError, type PracticeItem } from "./practice.js";

const DAY = 86_400_000;
const START = Date.parse("2026-10-06T12:00:00.000Z");

const book = (store?: MemoryStateStore<PracticeItem>) => {
  const clock = { now: START };
  return { clock, book: new PracticeBook({ now: () => clock.now, ...(store ? { store } : {}) }) };
};

describe("practice book", () => {
  it("spaces reviews out after right answers and brings a miss back tomorrow", () => {
    const { clock, book: b } = book();
    const item = b.add({
      personId: "dal",
      subject: "English",
      kind: "vocabulary",
      prompt: "cuchara",
      answer: "spoon",
    });
    expect(item.subject).toBe("english");
    expect(b.due({ personId: "dal" })).toHaveLength(1);
    const once = b.grade(item.id, true);
    expect(once.box).toBe(2);
    expect(Date.parse(once.dueISO) - START).toBe(2 * DAY);
    expect(b.due({ personId: "dal" })).toHaveLength(0);
    clock.now += 2 * DAY;
    const missed = b.grade(item.id, false);
    expect(missed.box).toBe(1);
    expect(Date.parse(missed.dueISO) - clock.now).toBe(DAY);
  });

  it("keeps a mistake made in conversation as something to practise", () => {
    const { book: b } = book();
    b.correct({
      personId: "dal",
      subject: "english",
      said: "I have 30 years",
      correct: "I am 30 years old",
      why: "age uses to be",
    });
    const [progress] = b.progress("dal");
    expect(progress).toMatchObject({ subject: "english", items: 1, corrections: 1, due: 1 });
    expect(b.due({ personId: "dal", subject: "english" })[0]?.note).toBe("age uses to be");
  });

  it("updates an existing prompt instead of duplicating it, and reports what keeps failing", () => {
    const { book: b } = book();
    const first = b.add({
      personId: "dal",
      subject: "french",
      kind: "grammar",
      prompt: "passé composé of aller",
      answer: "je suis allé",
    });
    const again = b.add({
      personId: "dal",
      subject: "French",
      kind: "grammar",
      prompt: "Passé composé of aller",
      answer: "je suis allé(e)",
    });
    expect(again.id).toBe(first.id);
    b.grade(first.id, false);
    b.grade(first.id, false);
    const [progress] = b.progress("dal");
    expect(progress?.items).toBe(1);
    expect(progress?.accuracy).toBe(0);
    expect(progress?.struggling).toEqual([{ prompt: "Passé composé of aller", wrong: 2 }]);
  });

  it("refuses empty or unknown input and forgets a person's items with them", async () => {
    const store = new MemoryStateStore<PracticeItem>();
    const { book: b } = book(store);
    expect(() =>
      b.add({ personId: "dal", subject: " ", kind: "vocabulary", prompt: "a", answer: "b" }),
    ).toThrow(PracticeError);
    b.add({ personId: "dal", subject: "math", kind: "fact", prompt: "7x8", answer: "56" });
    b.add({ personId: "kid", subject: "math", kind: "fact", prompt: "2+2", answer: "4" });
    await b.flush();
    const reloaded = new PracticeBook({ store, now: () => START });
    await reloaded.ready;
    expect(reloaded.list()).toHaveLength(2);
    expect(reloaded.forgetPerson("kid")).toBe(1);
    await reloaded.flush();
    expect((await store.entries()).map((e) => e.value.personId)).toEqual(["dal"]);
  });

  it("practises with the owner by default through the tool", async () => {
    const people = new PeopleRegistry({ now: () => START });
    const owner = { channel: "owner", actor: "test" } as const;
    const dal = people.remember({ name: "Dal" }, owner);
    if (!dal.ok) {
      throw new Error("setup");
    }
    people.setRole(dal.person.id, "owner", owner);
    const { book: b } = book();
    const tool = createPracticeTool(b, people);
    await tool.execute("1", {
      action: "add",
      subject: "english",
      prompt: "ventana",
      answer: "window",
    } as never);
    const due = (await tool.execute("2", { action: "due" } as never)) as {
      details: { due: PracticeItem[]; person: string };
    };
    expect(due.details.person).toBe("Dal");
    expect(due.details.due.map((i) => i.answer)).toEqual(["window"]);
    await expect(
      tool.execute("3", { action: "grade", id: due.details.due[0]?.id } as never),
    ).rejects.toThrow("right");
  });
});
