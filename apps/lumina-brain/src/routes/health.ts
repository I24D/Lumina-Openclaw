/**
 * health.ts — Health check endpoint
 *
 * GET /health
 * Returns brain status, uptime, active sessions, and LLM config.
 * This endpoint does NOT require authentication so Render can probe it.
 */

import { Router } from "express";
import { sessionStore } from "../session/store.js";

const START_TIME = Date.now();

export const healthRouter = Router();

healthRouter.get("/", (_req, res) => {
  res.json({
    status: "ok",
    version: process.env.npm_package_version ?? "1.0.0",
    uptime_seconds: Math.floor((Date.now() - START_TIME) / 1000),
    active_sessions: sessionStore.count(),
    llm_provider: process.env.BRAIN_LLM_PROVIDER ?? "anthropic",
    llm_model:    process.env.BRAIN_LLM_MODEL    ?? "claude-sonnet-4-6",
    timestamp: new Date().toISOString(),
  });
});
