/**
 * affect.ts — Estimates of how someone might feel, never statements of fact.
 *
 * M3GAN spec §10: a separate module reads voice, face, posture, words, history
 * and situation and produces estimates ({ possible_state, confidence, signals
 * }), never absolute claims; an estimated emotion is never objective truth.
 *
 * Today only words are read (Spanish and English cues, punctuation, shouting
 * in capitals). Voice and face features are accepted as precomputed numbers so
 * a future model can plug in (INTERFACE ONLY: no such model is connected).
 * Confidence never exceeds AFFECT_CEILING, and the result says it is an
 * estimate, so nothing downstream can mistake it for a diagnosis.
 */

export const AFFECT_STATES = [
  "neutral",
  "frustrated",
  "sad",
  "anxious",
  "happy",
  "tired",
  "angry",
] as const;
export type AffectState = (typeof AFFECT_STATES)[number];

export type AffectSignals = {
  readonly text?: string;
  /** Precomputed by a voice model, each in [0,1]: loudness, pitch variance, speech rate. */
  readonly voice?: {
    readonly energy?: number;
    readonly pitchVariance?: number;
    readonly rate?: number;
  };
  /** Precomputed by a face model. */
  readonly face?: { readonly expression?: AffectState; readonly confidence?: number };
};

export type AffectEstimate = {
  readonly possibleState: AffectState;
  readonly confidence: number;
  /** The cues the estimate rests on, so a person can judge it. */
  readonly signals: ReadonlyArray<string>;
  readonly note: string;
};

/** Words alone are weak evidence of a feeling; an estimate never claims more. */
export const AFFECT_CEILING = 0.75;

const CUES: ReadonlyArray<{ readonly state: AffectState; readonly pattern: RegExp }> = [
  {
    state: "frustrated",
    pattern:
      /\b(no funciona|otra vez|harto|harta|ya no s[eé]|frustra\w*|ugh|again|doesn'?t work|fed up)\b/iu,
  },
  {
    state: "sad",
    pattern:
      /\b(triste|me siento mal|llor\w*|sol[oa]\b|extra[ñn]o|sad|lonely|miss (him|her|you))\b/iu,
  },
  {
    state: "anxious",
    pattern:
      /\b(nervios\w*|preocupad\w*|ansie\w*|miedo|me da miedo|worried|anxious|scared|afraid)\b/iu,
  },
  {
    state: "happy",
    pattern:
      /\b(feliz|genial|excelente|qu[eé] bien|me encanta|gracias|happy|great|awesome|love it)\b/iu,
  },
  { state: "tired", pattern: /\b(cansad\w*|agotad\w*|sue[ñn]o|exhausted|tired|sleepy)\b/iu },
  { state: "angry", pattern: /\b(enojad\w*|furios\w*|molest\w*|rabia|angry|furious|pissed)\b/iu },
];

export function estimateAffect(signals: AffectSignals): AffectEstimate {
  const scores = new Map<AffectState, number>();
  const used: string[] = [];
  const add = (state: AffectState, weight: number, cue: string) => {
    scores.set(state, (scores.get(state) ?? 0) + weight);
    used.push(cue);
  };

  const text = signals.text?.trim() ?? "";
  if (text) {
    for (const { state, pattern } of CUES) {
      const match = pattern.exec(text);
      if (match) {
        add(state, 0.35, `words: "${match[0]}"`);
      }
    }
    const letters = text.replace(/[^\p{L}]/gu, "");
    const upper = letters.replace(/[^\p{Lu}]/gu, "").length;
    if (letters.length >= 8 && upper / letters.length > 0.6) {
      add("angry", 0.15, "mostly capital letters");
    }
    if (/[!?]{3,}/u.test(text)) {
      add("frustrated", 0.1, "repeated ! or ?");
    }
  }
  if (signals.voice?.energy !== undefined && signals.voice.energy > 0.8) {
    add("angry", 0.15, "loud voice");
  }
  if (signals.voice?.rate !== undefined && signals.voice.rate > 0.8) {
    add("anxious", 0.1, "fast speech");
  }
  if (signals.face?.expression && signals.face.expression !== "neutral") {
    add(
      signals.face.expression,
      0.3 * (signals.face.confidence ?? 0.5),
      `face: ${signals.face.expression}`,
    );
  }

  const ranked = [...scores.entries()].toSorted((a, b) => b[1] - a[1]);
  const top = ranked[0];
  if (!top) {
    return {
      possibleState: "neutral",
      confidence: 0.2,
      signals: [],
      note: "No cue found: this does not mean the person feels nothing.",
    };
  }
  // Competing cues lower confidence: mixed signals mean less certainty.
  const runnerUp = ranked[1]?.[1] ?? 0;
  const confidence = Math.min(AFFECT_CEILING, Math.max(0.2, top[1] + 0.2 - runnerUp / 2));
  return {
    possibleState: top[0],
    confidence: Number(confidence.toFixed(2)),
    signals: used,
    note: "An estimate from limited cues, not a fact about how the person feels. Ask rather than assume.",
  };
}
