// Scores Lumina's live memory recall against questions with known answers:
// direct facts, superseded facts that must lose to the current value, and
// questions the memory must NOT answer. Talks to the running gateway through
// `memory.search`, so it measures whatever provider owns the memory slot.
//
// The cases hold Dal's private facts, so they live outside the repo and outside
// the indexed workspace (an indexed eval file would answer its own questions).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MemorySearchResponse } from "../src/gateway/server-methods/memory-search.js";

type EvalCase = {
  id: string;
  category: string;
  query: string;
  /** Any of these in a top-K snippet counts as recalled. */
  expect?: string[];
  /** Superseded values: the first expected hit must rank above the first snippet holding only these. */
  outrank?: string[];
  /** The memory holds no answer: pass when nothing scores at or above `abstainBelow`. */
  abstain?: boolean;
};

type EvalFile = {
  agentId?: string;
  topK?: number;
  abstainBelow?: number;
  cases: EvalCase[];
};

type CaseResult = {
  id: string;
  category: string;
  pass: boolean;
  rank?: number;
  topScore?: number;
  detail: string;
};

const OPENCLAW_HOME = path.join(os.homedir(), ".openclaw");
const DEFAULT_CASES_PATH = path.join(OPENCLAW_HOME, "lumina-memory-eval.json");
const RUNS_PATH = path.join(OPENCLAW_HOME, "lumina-memory-eval-runs.jsonl");
const DEFAULT_TOP_K = 5;
const DEFAULT_ABSTAIN_BELOW = 0.5;

function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
}

function firstRank(
  snippets: string[],
  terms: string[],
  excluding: string[] = [],
): number | undefined {
  const index = snippets.findIndex(
    (snippet) =>
      terms.some((term) => snippet.includes(fold(term))) &&
      !excluding.some((term) => snippet.includes(fold(term))),
  );
  return index === -1 ? undefined : index + 1;
}

function scoreCase(
  testCase: EvalCase,
  response: MemorySearchResponse,
  topK: number,
  abstainBelow: number,
): CaseResult {
  const top = response.results.slice(0, topK);
  const topScore = top[0]?.score;
  const base = { id: testCase.id, category: testCase.category, topScore };
  // A stale index answers with nothing; that is an index problem, not a recall miss.
  if (response.stale && top.length === 0) {
    return {
      ...base,
      pass: false,
      detail: `index stale: ${response.warning ?? "rebuild pending"}`,
    };
  }
  if (testCase.abstain) {
    const confident = top.filter((result) => result.score >= abstainBelow);
    return {
      ...base,
      pass: confident.length === 0,
      detail:
        confident.length === 0
          ? "nothing confident enough to answer from"
          : `would answer from ${confident[0]?.path}:${confident[0]?.startLine}`,
    };
  }
  const snippets = top.map((result) => fold(`${result.path}\n${result.snippet}`));
  const expect = testCase.expect ?? [];
  const rank = firstRank(snippets, expect);
  if (rank === undefined) {
    return { ...base, pass: false, detail: `not in top ${topK}` };
  }
  const staleRank = testCase.outrank ? firstRank(snippets, testCase.outrank, expect) : undefined;
  if (staleRank !== undefined && staleRank < rank) {
    return {
      ...base,
      pass: false,
      rank,
      detail: `stale value ranks ${staleRank}, current ${rank}`,
    };
  }
  const hit = top[rank - 1];
  return { ...base, pass: true, rank, detail: `${hit?.path}:${hit?.startLine}` };
}

function readCases(filePath: string): EvalFile {
  if (!fs.existsSync(filePath)) {
    throw new Error(`cases file missing: ${filePath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as EvalFile;
  if (!Array.isArray(parsed.cases) || parsed.cases.length === 0) {
    throw new Error(`no cases in ${filePath}`);
  }
  return parsed;
}

function parseArgs(argv: string[]): {
  casesPath: string;
  json: boolean;
  only?: string;
  agentId?: string;
} {
  let casesPath = DEFAULT_CASES_PATH;
  let json = false;
  let only: string | undefined;
  let agentId: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--cases") {
      casesPath = argv[++index] ?? casesPath;
    } else if (arg === "--only") {
      only = argv[++index];
    } else if (arg === "--agent") {
      agentId = argv[++index];
    }
  }
  return { casesPath, json, ...(only ? { only } : {}), ...(agentId ? { agentId } : {}) };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const file = readCases(args.casesPath);
  const topK = file.topK ?? DEFAULT_TOP_K;
  const abstainBelow = file.abstainBelow ?? DEFAULT_ABSTAIN_BELOW;
  const agentId = args.agentId ?? file.agentId;
  const cases = args.only ? file.cases.filter((c) => c.id === args.only) : file.cases;
  const { callGateway } = await import("../src/gateway/call.js");

  const results: CaseResult[] = [];
  let provider = "unknown";
  let searchMode = "unknown";
  for (const testCase of cases) {
    try {
      const response = await callGateway<MemorySearchResponse>({
        method: "memory.search",
        params: {
          query: testCase.query,
          maxResults: topK,
          ...(agentId ? { agentId } : {}),
        },
        scopes: ["operator.read"],
        timeoutMs: 60_000,
      });
      provider = response.provider;
      searchMode = response.searchMode;
      results.push(scoreCase(testCase, response, topK, abstainBelow));
    } catch (err) {
      const detail = err instanceof Error ? err.message.split("\n")[0] : String(err);
      results.push({ id: testCase.id, category: testCase.category, pass: false, detail });
    }
  }

  const passed = results.filter((result) => result.pass).length;
  const ranked = results.filter((result) => result.rank !== undefined);
  // Mean reciprocal rank over the answerable cases only.
  const answerable = cases.filter((c) => !c.abstain).length;
  const mrr =
    answerable === 0
      ? 0
      : ranked.reduce((sum, result) => sum + 1 / (result.rank ?? Infinity), 0) / answerable;
  const byCategory = new Map<string, { pass: number; total: number }>();
  for (const result of results) {
    const entry = byCategory.get(result.category) ?? { pass: 0, total: 0 };
    entry.total += 1;
    entry.pass += result.pass ? 1 : 0;
    byCategory.set(result.category, entry);
  }
  const run = {
    at: new Date().toISOString(),
    agentId: agentId ?? "default",
    provider,
    searchMode,
    topK,
    abstainBelow,
    passed,
    total: results.length,
    mrr: Number(mrr.toFixed(3)),
    categories: Object.fromEntries(byCategory),
    results,
  };
  if (!args.only) {
    fs.appendFileSync(RUNS_PATH, `${JSON.stringify(run)}\n`);
  }

  if (args.json) {
    console.log(JSON.stringify(run, null, 2));
  } else {
    for (const result of results) {
      const score = result.topScore === undefined ? "" : ` top=${result.topScore.toFixed(2)}`;
      const rank = result.rank === undefined ? "" : ` rank=${result.rank}`;
      console.log(
        `${result.pass ? "OK " : "BAD"} [${result.category}] ${result.id}${rank}${score} - ${result.detail}`,
      );
    }
    console.log("");
    for (const [category, entry] of byCategory) {
      console.log(`${category}: ${entry.pass}/${entry.total}`);
    }
    console.log(
      `\nLumina memory: ${passed}/${results.length} passed, MRR ${run.mrr} (${provider}, ${searchMode}, top ${topK})`,
    );
  }
  if (passed < results.length) {
    process.exitCode = 1;
  }
}

await main();
