import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { truncateUtf16Safe } from "../utils.js";

export const MAX_DELIVERED_TOOL_RESULT_TEXT_CHARS = 20 * 1024;

type TextEdge = {
  sourceChars: number;
  text: string;
};

function takeUtf16SafeTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  let start = Math.max(0, text.length - maxChars);
  const first = text.charCodeAt(start);
  const previous = start > 0 ? text.charCodeAt(start - 1) : 0;
  if (first >= 0xdc00 && first <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) {
    start += 1;
  }
  return text.slice(start);
}

function collectHeadText(content: AgentToolResult<unknown>["content"], maxChars: number): TextEdge {
  let remaining = maxChars;
  let sourceChars = 0;
  let text = "";
  for (const block of content) {
    if (block.type !== "text" || remaining <= 0) {
      continue;
    }
    if (text.length > 0) {
      text += "\n";
      remaining -= 1;
      if (remaining <= 0) {
        break;
      }
    }
    const piece = truncateUtf16Safe(block.text, remaining);
    text += piece;
    sourceChars += piece.length;
    remaining -= piece.length;
  }
  return { sourceChars, text };
}

function collectTailText(content: AgentToolResult<unknown>["content"], maxChars: number): TextEdge {
  let remaining = maxChars;
  let sourceChars = 0;
  const parts: string[] = [];
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const block = content[index];
    if (block?.type !== "text" || remaining <= 0) {
      continue;
    }
    if (parts.length > 0) {
      parts.unshift("\n");
      remaining -= 1;
      if (remaining <= 0) {
        break;
      }
    }
    const piece = takeUtf16SafeTail(block.text, remaining);
    parts.unshift(piece);
    sourceChars += piece.length;
    remaining -= piece.length;
  }
  return { sourceChars, text: parts.join("") };
}

export function boundAgentToolResultText<T>(
  result: AgentToolResult<T>,
  options: { maxChars?: number; toolName?: string } = {},
): AgentToolResult<T> {
  const maxChars = Math.max(
    512,
    Math.trunc(options.maxChars ?? MAX_DELIVERED_TOOL_RESULT_TEXT_CHARS),
  );
  const totalTextChars = result.content.reduce(
    (sum, block) => sum + (block.type === "text" ? block.text.length : 0),
    0,
  );
  if (totalTextChars <= maxChars) {
    return result;
  }

  const noticeBudget = 240;
  const bodyBudget = Math.max(128, maxChars - noticeBudget);
  const head = collectHeadText(result.content, Math.ceil(bodyBudget * 0.6));
  const tail = collectTailText(result.content, Math.floor(bodyBudget * 0.4));
  const omittedChars = Math.max(1, totalTextChars - head.sourceChars - tail.sourceChars);
  const toolLabel = options.toolName ? ` from ${options.toolName}` : "";
  const notice =
    `\n\n[OpenClaw output guard: compacted oversized tool output${toolLabel}; ` +
    `omitted ${omittedChars} characters. Refine the request or paginate to continue.]\n\n`;
  const compactedText = `${head.text}${notice}${tail.text}`.slice(0, maxChars);
  const nonTextContent = result.content.filter((block) => block.type !== "text");

  return {
    ...result,
    content: [{ type: "text", text: compactedText }, ...nonTextContent],
  };
}
