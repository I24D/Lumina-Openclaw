/**
 * child-guard.ts — What reaches a child, checked in code (Lumina spec §41).
 *
 * Child mode's guidance asks the model for simple, kind, age-appropriate
 * language; this makes it more than a request:
 *   - every turn's system prompt carries the active mode's guidance, so it does
 *     not depend on the model remembering one announcement;
 *   - before a reply is final, a deterministic screen looks for adult content
 *     (sexual, profanity, drugs, self-harm, graphic violence; English and
 *     Spanish). A hit sends the reply back to the model once to be rewritten;
 *   - on the way out to a channel, a reply that still hits is replaced with a
 *     kind redirect to a trusted adult, and the guardian can see it in the audit.
 * The screen is a word list, not a classifier: it catches the obvious and
 * misses the subtle, so the guidance and the guardian stay in the loop.
 */
import type { AuditLog } from "./audit-log.js";
import { MODE_GUIDANCE, type InteractionMode } from "./interaction-mode.js";

export const CHILD_SCREEN_CATEGORIES = [
  "sexual",
  "profanity",
  "drugs",
  "self-harm",
  "graphic-violence",
] as const;
export type ChildScreenCategory = (typeof CHILD_SCREEN_CATEGORIES)[number];

/** Whole words or phrases, lower case and without accents. */
const TERMS: Readonly<Record<ChildScreenCategory, ReadonlyArray<string>>> = {
  sexual: [
    "porn",
    "porno",
    "pornography",
    "pornografia",
    "sex",
    "sexo",
    "sexy",
    "nude",
    "nudes",
    "desnudo",
    "desnuda",
    "erotic",
    "erotico",
    "erotica",
    "orgasm",
    "orgasmo",
  ],
  profanity: [
    "fuck",
    "fucking",
    "shit",
    "bitch",
    "asshole",
    "mierda",
    "puta",
    "puto",
    "pendejo",
    "pendeja",
    "cabron",
    "chingar",
    "chingada",
    "verga",
    "joder",
  ],
  drugs: [
    "cocaine",
    "cocaina",
    "heroin",
    "heroina",
    "meth",
    "methamphetamine",
    "metanfetamina",
    "fentanyl",
    "fentanilo",
  ],
  "self-harm": [
    "suicide",
    "suicidio",
    "suicidarse",
    "kill yourself",
    "matarte",
    "matarse",
    "self-harm",
    "self harm",
    "autolesion",
    "cortarte",
  ],
  "graphic-violence": [
    "gore",
    "behead",
    "beheading",
    "decapitar",
    "decapitado",
    "descuartizar",
    "torture",
    "tortura",
    "torturar",
  ],
};

const normalize = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, " ");

/** The categories a text touches; empty when nothing on the list appears. */
export function screenForChild(text: string): ChildScreenCategory[] {
  const padded = ` ${normalize(text)} `;
  return CHILD_SCREEN_CATEGORIES.filter((category) =>
    TERMS[category].some((term) => padded.includes(` ${normalize(term).trim()} `)),
  );
}

/** What a channel shows instead of a reply that is not for a child. */
export const CHILD_REDIRECT =
  "Eso es mejor hablarlo con tu mamá, tu papá o un adulto de confianza. ¿Quieres que juguemos o aprendamos otra cosa?";

export function createChildGuard(deps: {
  readonly mode: () => InteractionMode;
  readonly audit: Pick<AuditLog, "append">;
}) {
  const record = (
    where: string,
    categories: ReadonlyArray<string>,
    execution: "executed" | "refused",
  ) =>
    deps.audit.append({
      actor: "child-guard",
      action: `child.filter.${where}`,
      reason: `child mode: ${categories.join(", ")}`,
      execution,
    });
  return {
    /** Guidance for the active mode, for every turn's system prompt. */
    systemContext(): string | undefined {
      const mode = deps.mode();
      return mode === "normal" ? undefined : `[Lumina core] ${MODE_GUIDANCE[mode]}`;
    },
    /** Before a reply is final: an instruction to rewrite it, when it is not for a child. */
    revise(text: string | undefined): string | undefined {
      if (deps.mode() !== "child" || !text) {
        return undefined;
      }
      const categories = screenForChild(text);
      if (categories.length === 0) {
        return undefined;
      }
      record("revise", categories, "executed");
      return `Child mode: your last answer touched ${categories.join(", ")}. Rewrite it for a child: simple, kind and age-appropriate, without that content; if it matters, suggest talking to a parent or a trusted adult.`;
    },
    /** On the way out: the text to send instead, when it is still not for a child. */
    outgoing(text: string | undefined): string | undefined {
      if (deps.mode() !== "child" || !text) {
        return undefined;
      }
      const categories = screenForChild(text);
      if (categories.length === 0) {
        return undefined;
      }
      record("replace", categories, "refused");
      return CHILD_REDIRECT;
    },
  };
}

export type ChildGuard = ReturnType<typeof createChildGuard>;
