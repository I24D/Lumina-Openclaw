import { Router }                        from "express";
import { z }                             from "zod";
import type { Request, Response }        from "express";
import { authenticate }                  from "../middleware/authenticate.js";
import type { AuthenticatedRequest }     from "../middleware/authenticate.js";
import { pool }                          from "../db/index.js";

export const settingsRouter = Router();

settingsRouter.use(authenticate);

const LLMSettingsSchema = z.object({
  provider:  z.enum(["anthropic", "openai", "openai-compat"]),
  api_key:   z.string().min(1),
  model:     z.string().min(1),
  base_url:  z.string().url().optional().nullable(),
});

// GET /settings/llm — get current LLM settings
settingsRouter.get("/llm", async (req: Request, res: Response): Promise<void> => {
  const { sub } = (req as AuthenticatedRequest).user;

  try {
    const result = await pool.query(
      `SELECT llm_provider, llm_model, llm_base_url,
              -- never return the raw key, just whether it's set
              (llm_api_key IS NOT NULL AND llm_api_key <> '') AS has_custom_key
       FROM user_settings
       WHERE user_id = $1`,
      [sub],
    );

    if (result.rows.length === 0) {
      res.json({ has_custom_key: false, provider: null, model: null, base_url: null });
      return;
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("[settings/llm GET]", err);
    res.status(500).json({ error: "Failed to fetch settings" });
  }
});

// PUT /settings/llm — save or update LLM settings
settingsRouter.put("/llm", async (req: Request, res: Response): Promise<void> => {
  const { sub } = (req as AuthenticatedRequest).user;

  const parsed = LLMSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const { provider, api_key, model, base_url } = parsed.data;

  try {
    await pool.query(
      `INSERT INTO user_settings (user_id, llm_provider, llm_api_key, llm_model, llm_base_url)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) DO UPDATE
         SET llm_provider = EXCLUDED.llm_provider,
             llm_api_key  = EXCLUDED.llm_api_key,
             llm_model    = EXCLUDED.llm_model,
             llm_base_url = EXCLUDED.llm_base_url,
             updated_at   = NOW()`,
      [sub, provider, api_key, model, base_url ?? null],
    );

    res.json({ success: true });
  } catch (err) {
    console.error("[settings/llm PUT]", err);
    res.status(500).json({ error: "Failed to save settings" });
  }
});

// DELETE /settings/llm — remove custom key, revert to Lumina default
settingsRouter.delete("/llm", async (req: Request, res: Response): Promise<void> => {
  const { sub } = (req as AuthenticatedRequest).user;

  try {
    await pool.query(`DELETE FROM user_settings WHERE user_id = $1`, [sub]);
    res.status(204).send();
  } catch (err) {
    console.error("[settings/llm DELETE]", err);
    res.status(500).json({ error: "Failed to delete settings" });
  }
});
