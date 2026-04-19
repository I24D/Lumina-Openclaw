/**
 * brain.ts — Core brain endpoints
 *
 * POST /api/openclaw/brain/turn
 *   Receives a full turn from the OpenClaw Runtime.
 *   Calls the LLM and returns either tool_calls or a response.
 *
 * POST /api/openclaw/brain/turn/:sessionId/tool-results
 *   Runtime executed the tool calls. Submit results here.
 *   Brain continues the conversation and returns the next step.
 *
 * Both endpoints are authenticated via requireBearerAuth middleware.
 * The authenticated user's LLM settings are resolved per-request.
 */

import { Router }                  from "express";
import { z }                       from "zod";
import type { Request, Response }  from "express";

import { createLLMClient, getDefaultLLMClient } from "../llm/client.js";
import { buildSystemPrompt }                    from "../prompts/system.js";
import { sessionStore, createSession }          from "../session/store.js";
import { getLLMSettingsForUser }                from "../services/userSettings.js";
import type { LLMMessage, LLMClient }           from "../llm/client.js";
import type { AuthenticatedRequest }            from "../middleware/auth.js";
import type {
  BrainTurnRequest,
  BrainTurnResponse,
  ToolResultSubmit,
  Message,
  ToolCall,
} from "@lumina/protocol";

export const brainRouter = Router();

// ── Validation schemas ─────────────────────────────────────────────────────

const ToolDefinitionSchema = z.object({
  name:        z.string(),
  description: z.string(),
  parameters:  z.object({
    type:       z.literal("object"),
    properties: z.record(z.unknown()),
    required:   z.array(z.string()).optional(),
  }),
});

const MessageSchema = z.object({
  role:         z.enum(["system", "user", "assistant", "tool"]),
  content:      z.string(),
  tool_call_id: z.string().optional(),
  name:         z.string().optional(),
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

const ToolResultSchema = z.object({
  tool_call_id: z.string(),
  tool_name:    z.string(),
  result:       z.unknown(),
  error:        z.string().optional(),
  duration_ms:  z.number().optional(),
});

const ToolResultSubmitSchema = z.object({
  session_id:   z.string(),
  tool_results: z.array(ToolResultSchema),
});

// ── Helpers ────────────────────────────────────────────────────────────────

function toChat(messages: Message[]): LLMMessage[] {
  return messages.map((m): LLMMessage => ({
    role:         m.role,
    content:      m.content,
    tool_call_id: m.tool_call_id,
    name:         m.name,
  }));
}

/** Resolves the correct LLM client for the authenticated user. */
async function resolveClient(req: Request): Promise<LLMClient> {
  const user = (req as AuthenticatedRequest).user;

  if (!user || user.auth_method === "api_key") {
    return getDefaultLLMClient();
  }

  const settings = await getLLMSettingsForUser(user.user_id);

  // User has their own key — create a dedicated client for this request
  if (settings.api_key !== process.env.BRAIN_LLM_API_KEY) {
    return createLLMClient({
      provider: settings.provider,
      apiKey:   settings.api_key,
      model:    settings.model,
      baseUrl:  settings.base_url,
    });
  }

  return getDefaultLLMClient();
}

async function callBrain(
  session_id:   string,
  systemPrompt: string,
  request:      BrainTurnRequest,
  llm:          LLMClient,
) {
  const session = sessionStore.get(session_id);
  const history = session ? toChat(session.messages) : toChat(request.history);

  const messages: LLMMessage[] = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user",   content: request.message },
  ];

  return llm.complete(messages, request.available_tools, {
    maxTokens:   4096,
    temperature: 0.7,
  });
}

// ── POST /api/openclaw/brain/turn ──────────────────────────────────────────

brainRouter.post("/turn", async (req: Request, res: Response) => {
  const parsed = BrainTurnRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    const response: BrainTurnResponse = {
      type:    "error",
      message: `Invalid request: ${parsed.error.errors.map((e) => e.message).join("; ")}`,
      code:    "invalid_request",
    };
    res.status(400).json(response);
    return;
  }

  const turnReq  = parsed.data as BrainTurnRequest;
  const { session_id } = turnReq;
  const user     = (req as AuthenticatedRequest).user;

  let session = sessionStore.get(session_id);
  if (!session) {
    session = createSession(session_id);
    session.messages  = [...turnReq.history];
    session.metadata  = { user_id: user?.user_id, email: user?.email };
  }

  const systemPrompt = buildSystemPrompt({
    host_state:      turnReq.host_state,
    available_tools: turnReq.available_tools,
  });

  let llm: LLMClient;
  try {
    llm = await resolveClient(req);
  } catch (err) {
    console.error(`[brain] LLM client resolution failed:`, err);
    const response: BrainTurnResponse = {
      type:    "error",
      message: "LLM configuration error",
      code:    "llm_error",
    };
    res.status(500).json(response);
    return;
  }

  let llmResponse;
  try {
    llmResponse = await callBrain(session_id, systemPrompt, turnReq, llm);
  } catch (err) {
    console.error(`[brain] LLM error for session ${session_id}:`, err);
    const response: BrainTurnResponse = {
      type:    "error",
      message: `LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
      code:    "llm_error",
    };
    res.status(502).json(response);
    return;
  }

  if (llmResponse.finish_reason === "tool_calls" && llmResponse.tool_calls) {
    const calls: ToolCall[] = llmResponse.tool_calls.map((tc) => ({
      id:        tc.id,
      tool_name: tc.name,
      arguments: tc.arguments,
    }));

    session.messages.push({ role: "user", content: turnReq.message });
    session.pending_tool_calls = calls;
    sessionStore.set(session);

    const response: BrainTurnResponse = { type: "tool_calls", calls, session_id };
    res.json(response);
    return;
  }

  const content = llmResponse.content ?? "";
  session.messages.push({ role: "user",      content: turnReq.message });
  session.messages.push({ role: "assistant", content });
  session.pending_tool_calls = [];
  sessionStore.set(session);

  const response: BrainTurnResponse = { type: "response", content, session_id };
  res.json(response);
});

// ── POST /api/openclaw/brain/turn/:sessionId/tool-results ──────────────────

brainRouter.post(
  "/turn/:sessionId/tool-results",
  async (req: Request, res: Response) => {
    const parsed = ToolResultSubmitSchema.safeParse(req.body);
    if (!parsed.success) {
      const response: BrainTurnResponse = {
        type:    "error",
        message: `Invalid tool results: ${parsed.error.errors.map((e) => e.message).join("; ")}`,
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

    const systemPrompt = buildSystemPrompt({ host_state: null, available_tools: [] });

    let llm: LLMClient;
    try {
      llm = await resolveClient(req);
    } catch (err) {
      console.error(`[brain] LLM client resolution failed:`, err);
      const response: BrainTurnResponse = { type: "error", message: "LLM configuration error", code: "llm_error" };
      res.status(500).json(response);
      return;
    }

    const messages: LLMMessage[] = [
      { role: "system", content: systemPrompt },
      ...toChat(session.messages),
    ];

    let llmResponse;
    try {
      llmResponse = await llm.complete(messages, [], { maxTokens: 4096 });
    } catch (err) {
      console.error(`[brain] LLM continuation error for session ${session_id}:`, err);
      const response: BrainTurnResponse = {
        type:    "error",
        message: `LLM continuation failed: ${err instanceof Error ? err.message : String(err)}`,
        code:    "llm_error",
      };
      res.status(502).json(response);
      return;
    }

    if (llmResponse.finish_reason === "tool_calls" && llmResponse.tool_calls) {
      const calls: ToolCall[] = llmResponse.tool_calls.map((tc) => ({
        id:        tc.id,
        tool_name: tc.name,
        arguments: tc.arguments,
      }));
      session.pending_tool_calls = calls;
      sessionStore.set(session);

      const response: BrainTurnResponse = { type: "tool_calls", calls, session_id };
      res.json(response);
      return;
    }

    const content = llmResponse.content ?? "";
    session.messages.push({ role: "assistant", content });
    sessionStore.set(session);

    const response: BrainTurnResponse = { type: "response", content, session_id };
    res.json(response);
  },
);
