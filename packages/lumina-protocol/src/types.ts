/**
 * @lumina/protocol — Shared contract types
 *
 * Defines the full communication protocol between:
 *   - OpenClaw Runtime (local Windows PC)  — sends BrainTurnRequest
 *   - Lumina Brain      (Render)            — processes and returns BrainTurnResponse
 *
 * Both sides import from this package to stay in sync.
 * Never add runtime logic here — types only.
 */

// ── Tool schema (OpenAI-compatible JSON Schema) ────────────────────────────

export interface ToolParameter {
  type: string;
  description?: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  items?: ToolParameter;
  properties?: Record<string, ToolParameter>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, ToolParameter>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

// ── Host state snapshot (collected by lumina-pc) ───────────────────────────

export interface HostState {
  platform: "win32" | "darwin" | "linux";
  hostname: string;
  cpu_usage_pct: number;
  memory_free_mb: number;
  memory_total_mb: number;
  memory_used_pct: number;
  uptime_seconds: number;
  node_version: string;
  timestamp: string;
}

// ── Conversation messages ──────────────────────────────────────────────────

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: MessageRole;
  content: string;
  /** Present when role === "tool" — matches the id of the ToolCall that was executed */
  tool_call_id?: string;
  /** Present when role === "tool" — name of the tool that was executed */
  name?: string;
}

// ── Tool calls (requested by the brain, executed by the runtime) ───────────

export interface ToolCall {
  /** Unique ID for this specific invocation */
  id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
}

// ── Brain turn request ─────────────────────────────────────────────────────

export interface BrainTurnRequest {
  /**
   * Stable identifier for this conversation.
   * Derived from the hash of the first user message in the runtime.
   * The brain uses this to load/persist session state.
   */
  session_id: string;

  /** Latest user message (not included in history) */
  message: string;

  /**
   * Prior conversation messages in chronological order.
   * Does NOT include the current message — that is in `message`.
   */
  history: Message[];

  /**
   * Tool schemas available for the brain to call.
   * Sent by the runtime from its static tool-schemas registry.
   */
  available_tools: ToolDefinition[];

  /**
   * Current host snapshot collected by the runtime before the turn.
   * May be null if the metrics collection failed.
   */
  host_state: HostState | null;

  metadata?: {
    channel?: string;
    user_id?: string;
    timestamp?: string;
    [key: string]: unknown;
  };
}

// ── Brain turn response ────────────────────────────────────────────────────

/** Brain produced a text response — the turn is complete. */
export interface BrainResponseTurn {
  type: "response";
  content: string;
  session_id: string;
}

/** Brain wants the runtime to execute these tools. */
export interface BrainToolCallsTurn {
  type: "tool_calls";
  calls: ToolCall[];
  session_id: string;
}

/** Unrecoverable error during brain processing. */
export interface BrainErrorTurn {
  type: "error";
  message: string;
  code?: "llm_error" | "session_not_found" | "invalid_request" | "timeout";
}

export type BrainTurnResponse =
  | BrainResponseTurn
  | BrainToolCallsTurn
  | BrainErrorTurn;

// ── Tool result submission ─────────────────────────────────────────────────

export interface ToolResult {
  tool_call_id: string;
  tool_name: string;
  /** Serializable result from the tool execution */
  result: unknown;
  /** Present only if execution failed */
  error?: string;
  /** Wall-clock duration in milliseconds */
  duration_ms?: number;
}

export interface ToolResultSubmit {
  session_id: string;
  tool_results: ToolResult[];
}

// ── Auth types (shared between auth service and clients) ──────────────────

export interface LuminaUser {
  id:         string;
  email:      string;
  created_at: string;
}

export interface LuminaTokenPair {
  access_token:  string;
  refresh_token: string;
}

export interface LuminaAuthResponse extends LuminaTokenPair {
  user: LuminaUser;
}

// ── Health check response ──────────────────────────────────────────────────

export interface BrainHealth {
  status: "ok" | "degraded";
  version: string;
  uptime_seconds: number;
  active_sessions: number;
  llm_provider: string;
  llm_model: string;
  timestamp: string;
}
