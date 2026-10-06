/**
 * pronunciation.ts — How close what was heard is to what was meant to be said.
 *
 * Lumina spec §95 (pronunciation feedback). The microphone sidecar transcribes
 * the learner's next utterance (Whisper tiny, on this machine); this compares
 * it with the expected text word by word. A word the recognizer heard as
 * something else is a word that was not clear, which is the useful feedback:
 * "you said 'tree', I heard 'three'". It measures intelligibility to a
 * recognizer, not accent, and says so.
 */

export type PronunciationScore = {
  readonly expected: string;
  readonly heard: string;
  /** 0 to 1: how much of the expected text was heard as meant. */
  readonly score: number;
  readonly right: boolean;
  /** Expected words that came out as something else, or not at all. */
  readonly unclear: ReadonlyArray<{ readonly expected: string; readonly heard: string | null }>;
  readonly note: string;
};

/** The score at which an attempt counts as right for spaced review. */
export const PRONUNCIATION_PASS = 0.85;

const words = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/gu, " ")
    .split(/\s+/u)
    .filter(Boolean);

/** Similarity of two words from their edit distance, 0 to 1. */
function wordSimilarity(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j] ?? 0;
      row[j] = Math.min(
        (row[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      previous = current;
    }
  }
  return 1 - (row[b.length] ?? 0) / Math.max(1, a.length, b.length);
}

export function scorePronunciation(expected: string, heard: string): PronunciationScore {
  const want = words(expected);
  const got = words(heard);
  // Align by dynamic programming: substitutions cost by how different the words are.
  const width = got.length + 1;
  const cost = new Float64Array((want.length + 1) * width);
  const at = (i: number, j: number) => cost[i * width + j] ?? 0;
  const sub = (i: number, j: number) => 1 - wordSimilarity(want[i - 1] ?? "", got[j - 1] ?? "");
  for (let i = 0; i <= want.length; i++) {
    for (let j = 0; j <= got.length; j++) {
      cost[i * width + j] =
        i === 0
          ? j
          : j === 0
            ? i
            : Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + sub(i, j));
    }
  }
  // Walk back to name the words that did not come through.
  const unclear: Array<{ expected: string; heard: string | null }> = [];
  let i = want.length;
  let j = got.length;
  let exact = 0;
  while (i > 0) {
    if (j > 0 && Math.abs(at(i, j) - (at(i - 1, j - 1) + sub(i, j))) < 1e-9) {
      if (sub(i, j) === 0) {
        exact += 1;
      } else {
        unclear.unshift({ expected: want[i - 1] ?? "", heard: got[j - 1] ?? "" });
      }
      i--;
      j--;
    } else if (j > 0 && Math.abs(at(i, j) - (at(i, j - 1) + 1)) < 1e-9) {
      j--;
    } else {
      unclear.unshift({ expected: want[i - 1] ?? "", heard: null });
      i--;
    }
  }
  // Only words heard exactly as meant count: a near miss is what the learner needs to hear about.
  const score = want.length === 0 ? 0 : exact / Math.max(want.length, got.length);
  const rounded = Math.round(score * 100) / 100;
  return {
    expected,
    heard,
    score: rounded,
    right: rounded >= PRONUNCIATION_PASS,
    unclear,
    note: "How clearly a speech recognizer understood it, not a judgment of accent.",
  };
}
