import { pool } from "./index.js";

const schema = `
  CREATE EXTENSION IF NOT EXISTS "pgcrypto";

  CREATE TABLE IF NOT EXISTS users (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    email        TEXT        UNIQUE NOT NULL,
    password_hash TEXT       NOT NULL,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at   TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS refresh_tokens (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT        UNIQUE NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
  CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token_hash ON refresh_tokens(token_hash);

  CREATE TABLE IF NOT EXISTS user_settings (
    user_id      UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    llm_provider TEXT,
    llm_api_key  TEXT,
    llm_model    TEXT,
    llm_base_url TEXT,
    updated_at   TIMESTAMPTZ DEFAULT NOW()
  );
`;

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(schema);
    console.log("[migrate] Schema applied successfully");
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error("[migrate] Failed:", err);
  process.exit(1);
});
