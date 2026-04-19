/**
 * brain.ts — Core brain endpoints
 *
 * POST /api/openclaw/brain/turn
 *   Receives a full turn from the OpenClaw Runtime.
 *   Forwards the message to the LUMINA AI core and returns the response.
 *
 * POST /api/openclaw/brain/turn/:sessionId/tool-results
 *   Tool results from the runtime. LUMINA handles all tools internally,
 *   so this endpoint is accepted but tool execution is a no-op here.
 *
 * Both endpoints are authenticated via requireBearerAuth middleware.
 */

import { Router }                 from "express";
import { z }                      from "zod";
import type { Request, Response } from "express";

import { callLuminaCore, LuminaCoreError } from "../llm/luminaCore.js";
import { sessionStore, createSession }     from "../session/store.js";
import type { AuthenticatedRequest }       from "../middleware/auth.js";
import type {
  BrainTurnRequest,
  BrainTurnResponse,
  ToolResultSubmit,
} from "@lumina/protocol";

export const brainRouter = Router();

// ── Validation schemas ─────────────────────────────────────────────────────

const MessageSchema = z.object({
  role:         z.enum(["system", "user", "assistant", "tool"]),
  content:      z.string(),
  tool_call_id: z.string().optional(),
  name:         z.string().optional(),
});

const ToolDefinitionSchema = z.object({
  name:        z.string(),
  description: z.string(),
  parameters:  z.object({
    type:       z.literal("object"),
    properties: z.record(z.unknown()),
    required:   z.array(z.string()).optional(),
  }),
});

const HostStateSchema = z.object({
  platform:        z.enum(["win32", "darwin", "linux"]),
  hostname:        z.string(),
  cpu_usage_pct:   z.number(),
  memory_free_mb:  z.number(),
  memory_total_mb: z.number(),
  memory_used_pct: z.number(),
  uptime_seconds:  z.number(),
  node_version:    z.string(),
  timestamp:       z.string(),
}).nullable();

const BrainTurnRequestSchema = z.object({
  session_id:      z.string().min(1),
  message:         z.string().min(1),
  history:         z.array(MessageSchema),
  available_tools: z.array(ToolDefinitionSchema),
  host_state:      HostStateSchema,
  metadata:        z.record(z.unknown()).optional(),
});

const ToolResultSubmitSchema = z.object({
  session_id:   z.string(),
  tool_results: z.array(z.object({
    tool_call_id: z.string(),
    tool_name:    z.string(),
    result:       z.unknown(),
    error:        z.string().optional(),
    duration_ms:  z.number().optional(),
  })),
});

// ── POST /api/openclaw/brain/turn ──────────────────────────────────────────

brainRouter.post("/turn", async (req: Request, res: Response) => {
  const parsed = BrainTurnRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    const response: BrainTurnResponse = {
      type:    "error",
      message: `Invalid request: ${parsed.error.errors.map((e: { message: string }) => e.message).join("; ")}`,
      code:    "invalid_request",
    };
    res.status(400).json(response);
    return;
  }

  const turnReq = parsed.data as BrainTurnRequest;
  const { session_id } = turnReq;
  const user = (req as AuthenticatedRequest).user;

  // Persist session so tool-results endpoint can find it
  let session = sessionStore.get(session_id);
  if (!session) {
    session = createSession(session_id);
    session.messages = [...turnReq.history];
    session.metadata = { user_id: user?.user_id, email: user?.email };
  }

  // Use Lumina user_id for memory isolation; fall back to session_id
  const luminaUserId = user?.user_id ?? session_id;

  let content: string;
  try {
    content = await callLuminaCore(turnReq.message, luminaUserId);
  } catch (err) {
    console.error(`[brain] LUMINA core error for session ${session_id}:`, err);
    const status = err instanceof LuminaCoreError ? err.status : 502;
    const response: BrainTurnResponse = {
      type:    "error",
      message: err instanceof Error ? err.message : "LUMINA core unavailable",
      code:    "llm_error",
    };
    res.status(status >= 500 ? 502 : status).json(response);
    return;
  }

  session.messages.push({ role: "user",      content: turnReq.message });
  session.messages.push({ role: "assistant", content });
  session.pending_tool_calls = [];
  sessionStore.set(session);

  const response: BrainTurnResponse = { type: "response", content, session_id };
  res.json(response);
});

// ── POST /api/openclaw/brain/turn/:sessionId/tool-results ──────────────────
// LUMINA handles all tool execution internally. This endpoint is accepted
// for protocol compatibility but simply returns a no-op response.

brainRouter.post(
  "/turn/:sessionId/tool-results",
  async (req: Request, res: Response) => {
    const parsed = ToolResultSubmitSchema.safeParse(req.body);
    if (!parsed.success) {
      const response: BrainTurnResponse = {
        type:    "error",
        message: `Invalid tool results: ${parsed.error.errors.map((e: { message: string }) => e.message).join("; ")}`,
        code:    "invalid_request",
      };
      res.status(400).json(response);
      return;
    }

    const submit     = parsed.data as ToolResultSubmit;
    const session_id = req.params.sessionId ?? submit.session_id;

    const session = sessionStore.get(session_id);
    if (!session) {
      const response: BrainTurnResponse = {
        type:    "error",
        message: `Session not found: ${session_id}`,
        code:    "session_not_found",
      };
      res.status(404).json(response);
      return;
    }

    // Tool results are noted in session history for context continuity
    for (const r of submit.tool_results) {
      const resultText = r.error
        ? `Error: ${r.error}`
        : typeof r.result === "string"
          ? r.result
          : JSON.stringify(r.result, null, 2);

      session.messages.push({
        role:         "tool",
        content:      resultText,
        tool_call_id: r.tool_call_id,
        name:         r.tool_name,
      });
    }
    session.pending_tool_calls = [];
    sessionStore.set(session);

    // LUMINA already processed the action internally — acknowledge completion
    const response: BrainTurnResponse = {
      type:    "response",
      content: "",
      session_id,
    };
    res.json(response);
  },
);
