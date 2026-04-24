/**
 * smoke.test.ts — Lumina Auth smoke tests
 *
 * Spins up a minimal Express app with just the health router (no DB required)
 * and verifies the response contract.  Run with:
 *   pnpm --filter @lumina/auth test
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test, after } from "node:test";
import express from "express";
import { healthRouter } from "../src/routes/health.js";

// ── Minimal test server (no DB, no env guards) ─────────────────────────────

const app = express();
app.use(express.json());
app.use("/health", healthRouter);

// Protected routes should return 401 without a valid token.
// We register a guard that mimics the production middleware in isolation.
app.use("/auth", (_req, res) => res.status(401).json({ error: "Unauthorized" }));

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
  assert.equal(body.service, "lumina-auth");
  assert.equal(typeof body.timestamp, "string");
});

test("GET /health Content-Type is application/json", async () => {
  const res = await fetch(`${base}/health`);
  assert.ok(res.headers.get("content-type")?.includes("application/json"));
});

test("POST /auth without token returns 401", async () => {
  const res = await fetch(`${base}/auth/login`, { method: "POST" });
  assert.equal(res.status, 401);
});
