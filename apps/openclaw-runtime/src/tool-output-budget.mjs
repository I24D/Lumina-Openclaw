export const TOOL_RESULT_MODEL_CHAR_LIMIT = 5 * 1024;
export const TOOL_RESULT_STORAGE_CHAR_LIMIT = 20 * 1024;
export const TERMINAL_CAPTURE_CHAR_LIMIT = 20 * 1024;
export const AGENT_TOOL_ITERATION_LIMIT = 20;
export const AGENT_TOOL_ITERATION_LIMIT_MESSAGE = "l\u00edmite alcanzado, dime c\u00f3mo continuar";

function stringify(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function compactTextForBudget(text, { toolName, maxChars = TOOL_RESULT_MODEL_CHAR_LIMIT } = {}) {
  const source = String(text ?? "");
  const cap = Math.max(200, Number(maxChars) || TOOL_RESULT_MODEL_CHAR_LIMIT);
  if (source.length <= cap) return source;

  const noticeBudget = 220;
  const bodyBudget = Math.max(80, cap - noticeBudget);
  const headChars = Math.ceil(bodyBudget * 0.6);
  const tailChars = Math.max(40, bodyBudget - headChars);
  const omitted = Math.max(0, source.length - headChars - tailChars);
  const label = toolName ? ` for ${toolName}` : "";

  return [
    source.slice(0, headChars).trimEnd(),
    "",
    `[Lumina output guard${label}: compacted output for model; omitted ${omitted} chars from the middle.]`,
    "",
    source.slice(-tailChars).trimStart(),
  ].join("\n");
}

export function compactToolResultForModel(value, { toolName, maxChars = TOOL_RESULT_MODEL_CHAR_LIMIT } = {}) {
  const text = stringify(value);
  if (text.length <= maxChars) return value;
  return {
    ok: true,
    _compacted: true,
    tool: toolName,
    content: compactTextForBudget(text, { toolName, maxChars }),
  };
}

export function compactContextItemsForStorage(value, { toolName, maxChars = TOOL_RESULT_STORAGE_CHAR_LIMIT } = {}) {
  const text = stringify(value);
  if (text.length <= maxChars) return value;
  return {
    ok: true,
    _compacted: true,
    tool: toolName,
    content: compactTextForBudget(text, { toolName, maxChars }),
  };
}

export function appendCappedTerminalOutput(current, chunk, maxChars = TERMINAL_CAPTURE_CHAR_LIMIT) {
  const next = `${current ?? ""}${chunk ?? ""}`;
  if (next.length <= maxChars) return next;
  const omitted = next.length - maxChars;
  const notice = `[Lumina output guard: kept last ${maxChars} chars; omitted ${omitted} earlier chars]\n`;
  const keptBudget = Math.max(0, maxChars - notice.length);
  return notice + next.slice(-keptBudget);
}
