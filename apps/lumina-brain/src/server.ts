/**
 * server.ts — Lumina Brain entry point
 *
 * Express application that exposes:
 *   GET  /health                                    — liveness probe (no auth)
 *   POST /api/openclaw/brain/turn                   — start a turn
 *   POST /api/openclaw/brain/turn/:id/tool-results  — submit tool results
 *
 * All brain routes are protected by Bearer token auth.
 */

import express from "express";
import { requireBearerAuth } from "./middleware/auth.js";
import { brainRouter }       from "./routes/brain.js";
import { healthRouter }      from "./routes/health.js";
import { getLLMClient }      from "./llm/client.js";

const PORT = parseInt(process.env.PORT ?? "3100", 10);
const app  = express();

// ── Global middleware ──────────────────────────────────────────────────────

app.use(express.json({ limit: "4mb" }));

// Request logger (minimal, production-friendly)
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ── Routes ─────────────────────────────────────────────────────────────────

// Health: unauthenticated — Render probes this
app.use("/health", healthRouter);

// Brain: authenticated
app.use("/api/openclaw/brain", requireBearerAuth, brainRouter);

// 404 fallback
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Global error handler
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[server] unhandled error:", err);
  res.status(500).json({
    type:    "error",
    message: "Internal server error",
    code:    "internal",
  });
});

// ── Startup ────────────────────────────────────────────────────────────────

async function main() {
  // Validate LLM config eagerly so misconfigured deploys fail fast
  try {
    getLLMClient();
  } catch (err) {
    console.error("[startup] LLM client init failed:", err);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`[lumina-brain] Listening on port ${PORT}`);
    console.log(`[lumina-brain] LLM: ${process.env.BRAIN_LLM_PROVIDER ?? "anthropic"} / ${process.env.BRAIN_LLM_MODEL ?? "claude-sonnet-4-6"}`);
    console.log(`[lumina-brain] Session TTL: ${process.env.SESSION_TTL_MS ?? "1800000"}ms`);
  });
}

main().catch((err) => {
  console.error("[startup] Fatal error:", err);
  process.exit(1);
});
