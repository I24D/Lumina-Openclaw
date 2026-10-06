/**
 * social-tools.ts — Voice-first access to people and to models of their minds.
 *
 *   lumina_people  "Cady prefiere chocolate", "¿quién está aquí?", "¿qué sabes de Dal?"
 *   lumina_mind    "Dal no sabe que se movió la reunión", "¿cómo me veo?"
 *
 * Roles, consent and forgetting a person are not here: they belong to the
 * owner in the dashboard. What the agent records about minds and feelings is
 * kept as estimates with provenance, never as facts.
 */
import { Type } from "typebox";
import type { Recognition } from "../perception/recognition.js";
import { jsonResult, ToolInputError, type AnyAgentTool } from "../shared/tool-result.js";
import { estimateAffect } from "./affect.js";
import { BIOMETRIC_MODALITIES, type BiometricModality } from "./biometrics.js";
import type { PeopleRegistry, PersonInput } from "./people.js";
import type { PresenceState } from "./presence.js";
import {
  MIND_STANCES,
  type MindModel,
  type MindProvenance,
  type MindStance,
} from "./theory-of-mind.js";

const PEOPLE_ACTIONS = [
  "list",
  "get",
  "remember",
  "presence",
  "enroll",
  "forget_template",
  "sensors",
] as const;

export function createPeopleTool(
  people: PeopleRegistry,
  presence: () => PresenceState,
  recognition?: Recognition,
): AnyAgentTool {
  return {
    name: "lumina_people",
    label: "Lumina People",
    description:
      "People Lumina knows. 'remember' records or updates someone by name (aliases, relationship, preferences, " +
      "communication style, language, knowledge level, routine, important dates, a note); 'get' and 'list' read; " +
      "'presence' says who is here and who is speaking. 'enroll' learns a person's face (modality 'face': one " +
      "face in front of the camera) or voice ('voice': two seconds of their speech), only if the owner granted that " +
      "consent; 'forget_template' deletes it; 'sensors' says whether the camera and microphone are on and who they " +
      "recognize. Roles, recognition consent and forgetting someone are the owner's decisions in the M3GAN tab.",
    parameters: Type.Object({
      action: Type.Union(PEOPLE_ACTIONS.map((a) => Type.Literal(a))),
      name: Type.Optional(Type.String({ maxLength: 80 })),
      aliases: Type.Optional(Type.Array(Type.String({ maxLength: 80 }), { maxItems: 8 })),
      relationship: Type.Optional(Type.String({ maxLength: 80 })),
      preferences: Type.Optional(
        Type.Record(Type.String({ maxLength: 60 }), Type.String({ maxLength: 200 })),
      ),
      communicationStyle: Type.Optional(Type.String({ maxLength: 200 })),
      language: Type.Optional(Type.String({ maxLength: 40 })),
      knowledgeLevel: Type.Optional(Type.String({ maxLength: 120 })),
      routine: Type.Optional(Type.Array(Type.String({ maxLength: 160 }), { maxItems: 12 })),
      importantDates: Type.Optional(
        Type.Array(
          Type.Object({
            label: Type.String({ maxLength: 80 }),
            date: Type.String({ maxLength: 40 }),
          }),
          { maxItems: 12 },
        ),
      ),
      note: Type.Optional(Type.String({ maxLength: 400 })),
      worldEntityId: Type.Optional(Type.String({ maxLength: 128 })),
      modality: Type.Optional(Type.Union(BIOMETRIC_MODALITIES.map((m) => Type.Literal(m)))),
    }),
    async execute(_id, rawParams) {
      const p = rawParams as {
        action: (typeof PEOPLE_ACTIONS)[number];
        modality?: BiometricModality;
      } & Partial<PersonInput>;
      const named = () => {
        const person = p.name ? people.find(p.name) : undefined;
        if (!person) {
          throw new ToolInputError(`No one called ${p.name ?? "(no name)"} is known.`);
        }
        return person;
      };
      switch (p.action) {
        case "list":
          return jsonResult({ ok: true, people: people.list() });
        case "presence":
          return jsonResult({ ok: true, presence: presence() });
        case "get": {
          const person = p.name ? people.find(p.name) : undefined;
          return person
            ? jsonResult({ ok: true, person })
            : jsonResult({ ok: false, error: `No one called ${p.name ?? "(no name)"} is known.` });
        }
        case "remember": {
          if (!p.name?.trim()) {
            throw new ToolInputError("name is required to remember someone");
          }
          const r = people.remember(p as PersonInput, { channel: "agent", actor: "agent" });
          return r.ok
            ? jsonResult({ ok: true, person: r.person })
            : jsonResult({ ok: false, error: r.reason });
        }
        case "enroll": {
          if (!recognition || !p.modality) {
            throw new ToolInputError(
              recognition ? "modality is face or voice" : "No recognizing sensors here.",
            );
          }
          const person = named();
          return jsonResult({
            person: person.name,
            ...(await recognition.enroll(person.id, p.modality)),
          });
        }
        case "forget_template": {
          if (!recognition) {
            throw new ToolInputError("No recognizing sensors here.");
          }
          const person = named();
          return jsonResult({
            ok: true,
            person: person.name,
            removed: recognition.forget(person.id, p.modality),
          });
        }
        case "sensors":
          return jsonResult({ ok: true, sensors: recognition?.status() ?? null });
        default:
          throw new ToolInputError(`action must be one of: ${PEOPLE_ACTIONS.join(", ")}`);
      }
    },
  };
}

const MIND_ACTIONS = ["record", "about", "knows", "affect"] as const;

export function createMindTool(mind: MindModel): AnyAgentTool {
  return {
    name: "lumina_mind",
    label: "Lumina Mind",
    description:
      "A cautious model of other people's minds. 'record' notes that someone knows, believes, does not know, " +
      "is looking for or wants something, with confidence and how it was learned (observed, told, inferred; " +
      "inferences stay low-confidence); 'about' and 'knows' read it back ('unknown' means nothing is modeled). " +
      "'affect' estimates how a message may feel: an estimate with its cues, never a fact. Ask rather than assume.",
    parameters: Type.Object({
      action: Type.Union(MIND_ACTIONS.map((a) => Type.Literal(a))),
      holderId: Type.Optional(Type.String({ maxLength: 128 })),
      stance: Type.Optional(Type.Union(MIND_STANCES.map((s) => Type.Literal(s)))),
      proposition: Type.Optional(Type.String({ maxLength: 300 })),
      confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      provenance: Type.Optional(
        Type.Union([Type.Literal("observed"), Type.Literal("told"), Type.Literal("inferred")]),
      ),
      text: Type.Optional(
        Type.String({ maxLength: 2000, description: "For affect: the message to read." }),
      ),
    }),
    async execute(_id, rawParams) {
      const p = rawParams as {
        action: (typeof MIND_ACTIONS)[number];
        holderId?: string;
        stance?: MindStance;
        proposition?: string;
        confidence?: number;
        provenance?: MindProvenance;
        text?: string;
      };
      switch (p.action) {
        case "record": {
          if (
            !p.holderId ||
            !p.stance ||
            !p.proposition ||
            p.confidence === undefined ||
            !p.provenance
          ) {
            throw new ToolInputError(
              "record needs holderId, stance, proposition, confidence and provenance",
            );
          }
          return jsonResult({
            ok: true,
            belief: mind.record({
              holderId: p.holderId,
              stance: p.stance,
              proposition: p.proposition,
              confidence: p.confidence,
              provenance: p.provenance,
            }),
          });
        }
        case "about":
          if (!p.holderId) {
            throw new ToolInputError("holderId is required");
          }
          return jsonResult({ ok: true, beliefs: mind.about(p.holderId) });
        case "knows":
          if (!p.holderId || !p.proposition) {
            throw new ToolInputError("holderId and proposition are required");
          }
          return jsonResult({ ok: true, ...mind.knows(p.holderId, p.proposition) });
        case "affect":
          if (!p.text) {
            throw new ToolInputError("text is required for affect");
          }
          return jsonResult({ ok: true, estimate: estimateAffect({ text: p.text }) });
        default:
          throw new ToolInputError(`action must be one of: ${MIND_ACTIONS.join(", ")}`);
      }
    },
  };
}
