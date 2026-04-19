import pg from "pg";

const { Pool } = pg;

let _pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!_pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is required for user settings");

    _pool = new Pool({
      connectionString: url,
      ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
      max:                     5,
      idleTimeoutMillis:       30_000,
      connectionTimeoutMillis: 5_000,
    });

    _pool.on("error", (err: Error) => {
      console.error("[brain/db] Pool error:", err);
    });
  }

  return _pool;
}
