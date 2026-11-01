import { describe, expect, it } from "vitest";
import { scorePronunciation } from "./pronunciation.js";

describe("pronunciation score", () => {
  it("passes what was heard as meant, ignoring case, accents and punctuation", () => {
    const result = scorePronunciation("I am thirty years old.", "i am thirty years old");
    expect(result).toMatchObject({ score: 1, right: true, unclear: [] });
  });

  it("names the word that came out as something else", () => {
    const result = scorePronunciation("I see three trees", "I see tree trees");
    expect(result.right).toBe(false);
    expect(result.unclear).toEqual([{ expected: "three", heard: "tree" }]);
    expect(result.score).toBe(0.75);
  });

  it("names a word that was not heard at all", () => {
    const result = scorePronunciation("the red car", "the car");
    expect(result.unclear).toEqual([{ expected: "red", heard: null }]);
    expect(result.right).toBe(false);
  });
});
