import assert from "node:assert/strict";
import test from "node:test";
import {
  appendCappedTerminalOutput,
  compactToolResultForModel,
  TERMINAL_CAPTURE_CHAR_LIMIT,
  TOOL_RESULT_MODEL_CHAR_LIMIT,
} from "./tool-output-budget.mjs";

test("compactToolResultForModel leaves small output unchanged", () => {
  const value = { ok: true, content: "small output" };
  assert.deepEqual(compactToolResultForModel(value, { toolName: "unit" }), value);
});

test("compactToolResultForModel compacts large output with head, tail and notice", () => {
  const text = `${"a".repeat(TOOL_RESULT_MODEL_CHAR_LIMIT)}MIDDLE${"z".repeat(TOOL_RESULT_MODEL_CHAR_LIMIT)}`;
  const compacted = compactToolResultForModel(text, { toolName: "unit" });
  assert.equal(compacted.ok, true);
  assert.equal(compacted._compacted, true);
  assert.match(compacted.content, /Lumina output guard for unit/);
  assert.match(compacted.content, /^a+/);
  assert.match(compacted.content, /z+$/);
  assert.ok(compacted.content.length <= TOOL_RESULT_MODEL_CHAR_LIMIT);
});

test("appendCappedTerminalOutput keeps the last terminal window", () => {
  const first = "x".repeat(TERMINAL_CAPTURE_CHAR_LIMIT);
  const second = "tail";
  const output = appendCappedTerminalOutput(first, second);
  assert.ok(output.length <= TERMINAL_CAPTURE_CHAR_LIMIT);
  assert.match(output, /Lumina output guard: kept last 20480 chars/);
  assert.ok(output.endsWith(second));
});
