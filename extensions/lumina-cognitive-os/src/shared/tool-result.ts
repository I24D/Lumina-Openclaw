/**
 * tool-result.ts — Re-exports the agent tool helpers from the OpenClaw core
 * so every tool file in this extension imports from one short path instead
 * of the deep `../../../../src/agents/tools/common.js` relative one.
 */
export {
  jsonResult,
  ToolInputError,
  ToolAuthorizationError,
  textResult,
} from "../../../../src/agents/tools/common.js";
export type { AnyAgentTool } from "../../../../src/agents/tools/common.js";
// 2026.11.1 moved the result builders into their own module, and `common.ts`
// re-exports only two of the three. Upstream's own callers import this one
// straight from there, so this file follows them rather than widening the
// core's surface to suit the extension.
export { payloadTextResult } from "../../../../src/agents/tools/tool-results.js";
