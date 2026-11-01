/**
 * practice-tool.ts — Tool: lumina_practice.
 *
 * "Enséñame inglés", "¿cómo voy con el francés?", "dije 'I have 30 years'":
 * the agent teaches in conversation and keeps the memory of it here: what the
 * person practises, what is due, how a review went, the corrections made in
 * context, and progress per subject. Items belong to a person (the owner when
 * none is named).
 */
import { Type } from "typebox";
import type { Transcript } from "../perception/voice-bridge.js";
import { jsonResult, ToolInputError, type AnyAgentTool } from "../shared/tool-result.js";
import type { PeopleRegistry } from "./people.js";
import { PRACTICE_KINDS, PracticeError, type PracticeBook, type PracticeKind } from "./practice.js";
import { scorePronunciation } from "./pronunciation.js";

const PRACTICE_ACTIONS = [
  "add",
  "correct",
  "due",
  "grade",
  "pronounce",
  "progress",
  "remove",
] as const;

/** Listens for the learner's next utterance and returns its words (the microphone sidecar). */
export type Listen = (language: string) => Promise<Transcript>;

export function createPracticeTool(
  book: PracticeBook,
  people: PeopleRegistry,
  listen?: Listen,
): AnyAgentTool {
  return {
    name: "lumina_practice",
    label: "Lumina Practice",
    description:
      "Teaching and language practice memory. 'add' an item to practise (subject e.g. 'english', kind " +
      "vocabulary/grammar/pronunciation/fact/skill, prompt and answer); 'correct' records a mistake made in " +
      "conversation (said, correct, why) so it gets practised; 'due' lists what to review now, weakest first: " +
      "ask the person, then 'grade' with right true/false (right answers space reviews out, a wrong one brings " +
      "it back tomorrow); 'pronounce' listens to the person's next utterance (tell them to speak first) and " +
      "compares it with 'expected' or with item 'id''s answer, naming the words that did not come through, " +
      "and grades the item; 'progress' summarizes learned, due, accuracy and what keeps failing. Teach by " +
      "explaining and asking, adapt to what the progress shows, and let the person answer for themselves.",
    parameters: Type.Object({
      action: Type.Union(PRACTICE_ACTIONS.map((a) => Type.Literal(a))),
      person: Type.Optional(
        Type.String({ maxLength: 160, description: "Id or name; the owner when omitted." }),
      ),
      subject: Type.Optional(Type.String({ maxLength: 80 })),
      kind: Type.Optional(Type.Union(PRACTICE_KINDS.map((k) => Type.Literal(k)))),
      prompt: Type.Optional(Type.String({ maxLength: 500 })),
      answer: Type.Optional(Type.String({ maxLength: 500 })),
      note: Type.Optional(Type.String({ maxLength: 500 })),
      said: Type.Optional(Type.String({ maxLength: 500 })),
      correct: Type.Optional(Type.String({ maxLength: 500 })),
      why: Type.Optional(Type.String({ maxLength: 500 })),
      id: Type.Optional(Type.String({ maxLength: 128 })),
      right: Type.Optional(Type.Boolean()),
      expected: Type.Optional(Type.String({ maxLength: 500 })),
      language: Type.Optional(
        Type.String({
          maxLength: 8,
          description: "Spoken language for 'pronounce', e.g. en, es, fr.",
        }),
      ),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50, default: 10 })),
    }),
    async execute(_id, rawParams) {
      const p = rawParams as {
        action: (typeof PRACTICE_ACTIONS)[number];
        person?: string;
        subject?: string;
        kind?: PracticeKind;
        prompt?: string;
        answer?: string;
        note?: string;
        said?: string;
        correct?: string;
        why?: string;
        id?: string;
        right?: boolean;
        expected?: string;
        language?: string;
        limit?: number;
      };
      await book.ready;
      const person = p.person?.trim() ? people.find(p.person.trim()) : people.owner();
      if (!person) {
        throw new ToolInputError(
          p.person ? `Nobody called ${p.person} is known.` : "No owner is known yet.",
        );
      }
      const need = (value: string | undefined, name: string) => {
        if (!value?.trim()) {
          throw new ToolInputError(`${name} is required for ${p.action}`);
        }
        return value;
      };
      try {
        switch (p.action) {
          case "add":
            return jsonResult({
              ok: true,
              item: book.add({
                personId: person.id,
                subject: need(p.subject, "subject"),
                kind: p.kind ?? "vocabulary",
                prompt: need(p.prompt, "prompt"),
                answer: need(p.answer, "answer"),
                ...(p.note ? { note: p.note } : {}),
              }),
            });
          case "correct":
            return jsonResult({
              ok: true,
              item: book.correct({
                personId: person.id,
                subject: need(p.subject, "subject"),
                said: need(p.said, "said"),
                correct: need(p.correct, "correct"),
                ...(p.why ? { why: p.why } : {}),
              }),
            });
          case "due":
            return jsonResult({
              ok: true,
              person: person.name,
              due: book.due(
                { personId: person.id, ...(p.subject ? { subject: p.subject } : {}) },
                p.limit ?? 10,
              ),
            });
          case "grade":
            if (typeof p.right !== "boolean") {
              throw new ToolInputError("right (true or false) is required for grade");
            }
            return jsonResult({ ok: true, item: book.grade(need(p.id, "id"), p.right) });
          case "progress":
            return jsonResult({
              ok: true,
              person: person.name,
              subjects: book.progress(person.id),
            });
          case "pronounce": {
            if (!listen) {
              return jsonResult({ ok: false, error: "No microphone is connected to the core." });
            }
            const item = p.id
              ? book.list({ personId: person.id }).find((i) => i.id === p.id)
              : undefined;
            const expected = p.expected?.trim() || item?.answer;
            if (!expected) {
              throw new ToolInputError("expected or the id of an item is required for pronounce");
            }
            const heard = await listen(p.language?.trim() || "en");
            if (!heard.ok) {
              return jsonResult({ ok: false, error: heard.reason });
            }
            const result = scorePronunciation(expected, heard.text);
            return jsonResult({
              ok: true,
              ...result,
              ...(item ? { item: book.grade(item.id, result.right) } : {}),
            });
          }
          case "remove":
            return jsonResult({ ok: book.remove(need(p.id, "id")) });
          default:
            throw new ToolInputError(`Unknown action: ${String(p.action)}`);
        }
      } catch (error) {
        if (error instanceof PracticeError) {
          throw new ToolInputError(error.message);
        }
        throw error;
      }
    },
  };
}
