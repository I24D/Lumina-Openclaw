/**
 * Stable leaf contract for cognitive events and attention.
 *
 * Producers outside cognition/ depend on this module instead of importing the
 * cognitive implementation layer.
 */
export type EventTrust = "trusted" | "untrusted";

export type CognitiveEvent = {
  readonly source: string;
  readonly kind: string;
  readonly atISO: string;
  readonly importance?: number;
  readonly urgency?: number;
  readonly payload?: unknown;
  readonly trust?: EventTrust;
};

export type SalienceWeights = {
  readonly importance: number;
  readonly urgency: number;
  readonly novelty: number;
};

export type AttentionVerdict = {
  readonly admitted: boolean;
  readonly salience: number;
  readonly importance: number;
  readonly urgency: number;
  readonly novelty: number;
  readonly reason: string;
};

export type AttentionOptions = {
  readonly threshold?: number;
  readonly weights?: Partial<SalienceWeights>;
  readonly noveltyWindowMs?: number;
};

export const UNTRUSTED_SOURCES: ReadonlySet<string> = new Set([
  "web",
  "email",
  "document",
  "notification",
  "image",
  "qr",
  "ocr",
  "whatsapp",
  "telegram",
  "sms",
]);

export function trustOf(event: Pick<CognitiveEvent, "source" | "trust">): EventTrust {
  return event.trust ?? (UNTRUSTED_SOURCES.has(event.source) ? "untrusted" : "trusted");
}
