import express    from "express";
import cors        from "cors";
import { authRouter }     from "./routes/auth.js";
import { healthRouter }   from "./routes/health.js";
import { settingsRouter } from "./routes/settings.js";

const REQUIRED_ENV = [
  "DATABASE_URL",
  "JWT_ACCESS_SECRET",
  "JWT_REFRESH_SECRET",
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[startup] Missing required env var: ${key}`);
    process.exit(1);
  }
}

const PORT = parseInt(process.env.PORT ?? "3200", 10);
const app  = express();

const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",").map((o) => o.trim()) ?? "*";

app.use(cors({
  origin: allowedOrigins,
  // No cookies used — auth is Bearer token only, so credentials header is not needed
  credentials: false,
}));

app.use(express.json({ limit: "1mb" }));

app.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

app.use("/health",   healthRouter);
app.use("/auth",     authRouter);
app.use("/settings", settingsRouter);

app.use((_req: express.Request, res: express.Response) => {
  res.status(404).json({ error: "Not found" });
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[server] Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`[lumina-auth] Listening on port ${PORT}`);
});
