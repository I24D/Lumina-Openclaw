import type { Request, Response, NextFunction } from "express";
import { verifyAccessToken } from "../services/auth.js";
import type { JwtPayload }   from "../types.js";

export interface AuthenticatedRequest extends Request {
  user: JwtPayload;
}

export function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid authorization header" });
    return;
  }

  const token = header.slice(7);

  try {
    const payload = verifyAccessToken(token);
    (req as AuthenticatedRequest).user = payload;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired access token" });
  }
}
