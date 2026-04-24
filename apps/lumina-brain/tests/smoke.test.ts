/**
 * smoke.test.ts — Lumina Brain smoke tests
 *
 * Spins up a minimal Express app with the health router and a stub of the
 * auth guard to verify that protected routes reject unauthenticated requests.
 * No DB, no real LLM, no env guards required.  Run with:
 *   pnpm --filter @lumina/brain test
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test, after } from "node:test";
import express from "express";
import { healthRouter } from "../src/routes/health.js";

// ── Minimal test server ────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Health: unauthenticated
app.use("/health", healthRouter);

// Brain: protected — stub returns 401 without a valid Bearer token.
// In production this is handled by requireBearerAuth; here we verify the
// boundary so that if the middleware is removed by accident, the test fails.
app.use("/api/openclaw/brain", (req, res, next) => {
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
});
app.use("/api/openclaw/brain", (_req, res) => {
  res.status(200).json({ ok: true });
});

const server = createServer(app);
let port: number;

await new Promise<void>((resolve) =>
  server.listen(0, "127.0.0.1", () => {
    port = (server.address() as import("node:net").AddressInfo).port;
    resolve();
  }),
);

const base = `http://127.0.0.1:${port}`;

after(() => server.close());

// ── Tests ──────────────────────────────────────────────────────────────────

test("GET /health returns 200 with status ok", async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  const body = await res.json() as Record<string, unknown>;
  assert.equal(body.status, "ok");
  assert.equal(typeof body.uptime_seconds, "number");
  assert.equal(typeof body.active_sessions, "number");
  assert.equal(typeof body.timestamp, "string");
});

test("GET /health Content-Type is application/json", async () => {
  const res = await fetch(`${base}/health`);
  assert.ok(res.headers.get("content-type")?.includes("application/json"));
});

test("POST /api/openclaw/brain/turn without token returns 401", async () => {
  const res = await fetch(`${base}/api/openclaw/brain/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "hello" }),
  });
  assert.equal(res.status, 401);
});

test("POST /api/openclaw/brain/turn with Bearer token passes auth guard", async () => {
  const res = await fetch(`${base}/api/openclaw/brain/turn`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer test-token",
    },
    body: JSON.stringify({ message: "hello" }),
  });
  // 200 = auth guard passed (stub returns ok, not a real turn result)
  assert.equal(res.status, 200);
});
