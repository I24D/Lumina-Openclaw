/**
 * auth.ts — Dual authentication middleware
 *
 * Accepts two auth strategies:
 *   1. JWT (Bearer <access_token>) — issued by lumina-auth, identifies a real user
 *   2. API key (Bearer <BRAIN_API_KEY>) — server-to-server, used by OpenClaw Runtime
 *
 * JWT takes priority. API key is a fallback for the local runtime during development
 * until Phase 4 (Electron app) wires up JWT end-to-end.
 */

import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

const API_KEY          = process.env.BRAIN_API_KEY ?? "";
const JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "";

if (!API_KEY && !JWT_ACCESS_SECRET) {
  console.warn("[auth] WARNING: Neither BRAIN_API_KEY nor JWT_ACCESS_SECRET is set. All requests will be rejected.");
}

export interface UserContext {
  user_id: string;
  email:   string;
  auth_method: "jwt" | "api_key";
}

export interface AuthenticatedRequest extends Request {
  user: UserContext;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export function requireBearerAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const header = req.headers.authorization ?? "";
  const token  = header.startsWith("Bearer ") ? header.slice(7).trim() : "";

  if (!token) {
    res.status(401).json({ type: "error", message: "Missing authorization header", code: "unauthorized" });
    return;
  }

  // Strategy 1: try JWT verification
  if (JWT_ACCESS_SECRET) {
    try {
      const payload = jwt.verify(token, JWT_ACCESS_SECRET) as { sub: string; email: string };
      (req as AuthenticatedRequest).user = {
        user_id:     payload.sub,
        email:       payload.email,
        auth_method: "jwt",
      };
      next();
      return;
    } catch {
      // Not a valid JWT — fall through to API key check
    }
  }

  // Strategy 2: static API key (runtime fallback)
  if (API_KEY && safeEqual(token, API_KEY)) {
    (req as AuthenticatedRequest).user = {
      user_id:     "system",
      email:       "system@lumina.internal",
      auth_method: "api_key",
    };
    next();
    return;
  }

  res.status(401).json({ type: "error", message: "Unauthorized — invalid or missing token", code: "unauthorized" });
}
