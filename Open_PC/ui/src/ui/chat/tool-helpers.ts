/**
 * Helper functions for tool card rendering.
 */

import { PREVIEW_MAX_CHARS, PREVIEW_MAX_LINES } from "./constants.ts";

export const TOOL_OUTPUT_RENDER_MAX_CHARS = 20 * 1024;

export function boundToolOutputForRender(
  text: string,
  maxChars = TOOL_OUTPUT_RENDER_MAX_CHARS,
): string {
  const cap = Math.max(512, Math.trunc(maxChars));
  if (text.length <= cap) {
    return text;
  }
  const noticeBudget = 180;
  const bodyBudget = Math.max(128, cap - noticeBudget);
  const headChars = Math.ceil(bodyBudget * 0.6);
  const tailChars = Math.floor(bodyBudget * 0.4);
  const omittedChars = Math.max(1, text.length - headChars - tailChars);
  const notice =
    `\n\n[UI output guard: ${omittedChars} characters omitted to keep Lumina responsive. ` +
    `Refine or paginate the tool request.]\n\n`;
  return `${text.slice(0, headChars)}${notice}${text.slice(-tailChars)}`.slice(0, cap);
}

/**
 * Format tool output content for display in the sidebar.
 * Detects JSON and wraps it in a code block with formatting.
 */
export function formatToolOutputForSidebar(text: string): string {
  const bounded = boundToolOutputForRender(text);
  const trimmed = bounded.trim();
  // Try to detect and format JSON
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      return "```json\n" + JSON.stringify(parsed, null, 2) + "\n```";
    } catch {
      // Not valid JSON, return as-is
    }
  }
  return bounded;
}

/**
 * Get a truncated preview of tool output text.
 * Truncates to first N lines or first N characters, whichever is shorter.
 */
export function getTruncatedPreview(text: string): string {
  const allLines = text.split("\n");
  const lines = allLines.slice(0, PREVIEW_MAX_LINES);
  const preview = lines.join("\n");
  if (preview.length > PREVIEW_MAX_CHARS) {
    return preview.slice(0, PREVIEW_MAX_CHARS) + "…";
  }
  return lines.length < allLines.length ? preview + "…" : preview;
}
