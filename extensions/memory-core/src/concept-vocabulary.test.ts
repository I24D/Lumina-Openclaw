// Memory Core tests cover concept vocabulary plugin behavior.
import { describe, expect, it } from "vitest";
import { deriveConceptTags, summarizeConceptTagScriptCoverage } from "./concept-vocabulary.js";

describe("concept vocabulary", () => {
  it("respects astral letter boundaries around short glossary terms", () => {
    const tags = deriveConceptTags({
      path: "memory/2026-04-04.md",
      snippet: "kv𐐀 𐐀kv s3𐐀 𐐀s3",
    });
    expect(tags).toEqual(expect.arrayContaining(["kv𐐨", "𐐨kv", "s3𐐨", "𐐨s3"]));
    expect(tags).not.toContain("kv");
    expect(tags).not.toContain("s3");
  });

  it("extracts protected and segmented CJK concept tags", () => {
    const tags = deriveConceptTags({
      path: "memory/2026-04-04.md",
      snippet:
        "障害対応ルーター設定とバックアップ確認。路由器备份与网关同步。라우터 백업 페일오버 점검.",
    });

    expect(tags).toStrictEqual([
      "バックアップ",
      "ルーター",
      "障害対応",
      "路由器",
      "备份",
      "网关",
      "라우터",
      "백업",
    ]);
    expect(tags).not.toContain("ルー");
    expect(tags).not.toContain("ター");
  });

  it("drops chat scaffolding stop words from derived concept tags", () => {
    const tags = deriveConceptTags({
      path: "memory/.dreams/session-corpus/2026-04-16.txt",
      snippet:
        "Assistant: the system should remind you about the Ollama provider setup in your workspace.",
    });

    expect(tags).toContain("ollama");
    expect(tags).toContain("provider");
    expect(tags).not.toContain("assistant");
    expect(tags).not.toContain("system");
    expect(tags).not.toContain("the");
    expect(tags).not.toContain("you");
    expect(tags).not.toContain("your");
  });

  it("drops Spanish assistant filler from derived concept tags", () => {
    const tags = deriveConceptTags({
      path: "memory/.dreams/session-corpus/2026-09-16.txt",
      snippet: "Assistant: Voy a revisar. Déjame ver ahora la configuración del gateway.",
    });

    expect(tags).toContain("configuración");
    expect(tags).toContain("gateway");
    expect(tags).not.toContain("voy");
    expect(tags).not.toContain("déjame");
    expect(tags).not.toContain("ahora");
  });

  it("ignores project and recall annotations when deriving concept tags", () => {
    const tags = deriveConceptTags({
      path: "memory/2026-07-28.md",
      snippet:
        "Alpha ingest workflow. <!-- project: github.com/acme/alpha --> <!-- trigger: kraken deploy ritual --> <!-- importance: 8 -->",
    });

    expect(tags).toContain("alpha");
    expect(tags).toContain("ingest");
    expect(tags).not.toContain("github.com/acme/alpha");
    expect(tags).not.toContain("acme");
    expect(tags).not.toContain("kraken");
    expect(tags).not.toContain("importance");
  });

  it("summarizes entry coverage across latin, cjk, and mixed tags", () => {
    expect(
      summarizeConceptTagScriptCoverage([
        ["routeur", "sauvegarde"],
        ["路由器", "备份"],
        ["vectors", "路由器"],
        ["сервер"],
      ]),
    ).toEqual({
      latinEntryCount: 1,
      cjkEntryCount: 1,
      mixedEntryCount: 1,
      otherEntryCount: 1,
    });
  });
});
