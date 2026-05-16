import { getPool } from "../db/index.js";

export interface UserLLMSettings {
  provider:  string;
  api_key:   string;
  model:     string;
  base_url?: string;
}

const SERVER_DEFAULTS: UserLLMSettings = {
  provider: process.env.BRAIN_LLM_PROVIDER ?? "anthropic",
  api_key:  process.env.BRAIN_LLM_API_KEY  ?? "",
  model:    process.env.BRAIN_LLM_MODEL    ?? "claude-opus-4-7",
  base_url: process.env.BRAIN_LLM_BASE_URL,
};

interface UserSettingsRow {
  llm_provider: string | null;
  llm_api_key:  string | null;
  llm_model:    string | null;
  llm_base_url: string | null;
}

/**
 * Returns LLM settings for a user.
 * If the user has configured their own key, use it.
 * Otherwise fall back to the server's default key.
 */
export async function getLLMSettingsForUser(user_id: string): Promise<UserLLMSettings> {
  if (user_id === "system" || !process.env.DATABASE_URL) {
    return SERVER_DEFAULTS;
  }

  try {
    const pool   = getPool();
    const result = await pool.query<UserSettingsRow>(
      `SELECT llm_provider, llm_api_key, llm_model, llm_base_url
       FROM user_settings
       WHERE user_id = $1`,
      [user_id],
    );

    const row = result.rows[0];
    if (!row || !row.llm_api_key) return SERVER_DEFAULTS;

    return {
      provider: row.llm_provider ?? SERVER_DEFAULTS.provider,
      api_key:  row.llm_api_key,
      model:    row.llm_model    ?? SERVER_DEFAULTS.model,
      base_url: row.llm_base_url ?? SERVER_DEFAULTS.base_url,
    };
  } catch (err) {
    console.error(`[userSettings] Failed to fetch settings for user ${user_id}:`, err);
    return SERVER_DEFAULTS;
  }
}
