import { Router }                          from "express";
import { z }                               from "zod";
import * as authService                    from "../services/auth.js";
import { authenticate }                    from "../middleware/authenticate.js";
import type { AuthenticatedRequest }       from "../middleware/authenticate.js";
import type { Request, Response }          from "express";

export const authRouter = Router();

const RegisterSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

const LoginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(1),
});

const RefreshSchema = z.object({
  refresh_token: z.string().min(1),
});

const LogoutSchema = z.object({
  refresh_token: z.string().min(1),
});

// POST /auth/register
authRouter.post("/register", async (req: Request, res: Response): Promise<void> => {
  const parsed = RegisterSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const { email, password } = parsed.data;

  try {
    const { user, tokens } = await authService.register(email, password);
    res.status(201).json({ user, ...tokens });
  } catch (err: unknown) {
    const isDuplicate =
      err instanceof Error &&
      err.message.includes("duplicate key");

    if (isDuplicate) {
      res.status(409).json({ error: "Email already registered" });
      return;
    }

    console.error("[auth/register]", err);
    res.status(500).json({ error: "Registration failed" });
  }
});

// POST /auth/login
authRouter.post("/login", async (req: Request, res: Response): Promise<void> => {
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const { email, password } = parsed.data;

  try {
    const result = await authService.login(email, password);
    if (!result) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    const { user, tokens } = result;
    res.json({ user, ...tokens });
  } catch (err) {
    console.error("[auth/login]", err);
    res.status(500).json({ error: "Login failed" });
  }
});

// POST /auth/refresh
authRouter.post("/refresh", async (req: Request, res: Response): Promise<void> => {
  const parsed = RefreshSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "refresh_token is required" });
    return;
  }

  try {
    const tokens = await authService.refresh(parsed.data.refresh_token);
    if (!tokens) {
      res.status(401).json({ error: "Invalid or expired refresh token" });
      return;
    }

    res.json(tokens);
  } catch (err) {
    console.error("[auth/refresh]", err);
    res.status(500).json({ error: "Token refresh failed" });
  }
});

// POST /auth/logout
authRouter.post("/logout", async (req: Request, res: Response): Promise<void> => {
  const parsed = LogoutSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "refresh_token is required" });
    return;
  }

  try {
    await authService.logout(parsed.data.refresh_token);
    res.status(204).send();
  } catch (err) {
    console.error("[auth/logout]", err);
    res.status(500).json({ error: "Logout failed" });
  }
});

// GET /auth/me  (protected)
authRouter.get("/me", authenticate, async (req: Request, res: Response): Promise<void> => {
  const { sub } = (req as AuthenticatedRequest).user;

  try {
    const user = await authService.getUserById(sub);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.json({ user });
  } catch (err) {
    console.error("[auth/me]", err);
    res.status(500).json({ error: "Failed to fetch user" });
  }
});
