import { Router }          from "express";
import type { Request, Response } from "express";

export const healthRouter = Router();

healthRouter.get("/", (_req: Request, res: Response): void => {
  res.json({ status: "ok", service: "lumina-auth", timestamp: new Date().toISOString() });
});
