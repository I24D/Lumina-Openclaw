import bcrypt      from "bcryptjs";
import jwt          from "jsonwebtoken";
import crypto       from "node:crypto";
import { pool }     from "../db/index.js";
import type { User, TokenPair, JwtPayload } from "../types.js";

const ACCESS_SECRET  = process.env.JWT_ACCESS_SECRET!;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET!;
const ACCESS_TTL     = "15m";
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function issueAccessToken(user: User): string {
  return jwt.sign(
    { sub: user.id, email: user.email } satisfies JwtPayload,
    ACCESS_SECRET,
    { expiresIn: ACCESS_TTL }
  );
}

async function issueRefreshToken(userId: string): Promise<string> {
  const raw  = crypto.randomBytes(64).toString("hex");
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);

  await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [userId, hash, expiresAt]
  );

  return raw;
}

export async function register(email: string, password: string): Promise<{ user: User; tokens: TokenPair }> {
  const normalizedEmail = email.toLowerCase().trim();
  const passwordHash    = await bcrypt.hash(password, 12);

  const result = await pool.query<User>(
    `INSERT INTO users (email, password_hash)
     VALUES ($1, $2)
     RETURNING id, email, created_at::text`,
    [normalizedEmail, passwordHash]
  );

  const user          = result.rows[0];
  const access_token  = issueAccessToken(user);
  const refresh_token = await issueRefreshToken(user.id);

  return { user, tokens: { access_token, refresh_token } };
}

export async function login(email: string, password: string): Promise<{ user: User; tokens: TokenPair } | null> {
  const normalizedEmail = email.toLowerCase().trim();

  const result = await pool.query<User & { password_hash: string }>(
    `SELECT id, email, password_hash, created_at::text FROM users WHERE email = $1`,
    [normalizedEmail]
  );

  if (result.rows.length === 0) return null;

  const row   = result.rows[0];
  const valid = await bcrypt.compare(password, row.password_hash);
  if (!valid) return null;

  const user: User = { id: row.id, email: row.email, created_at: row.created_at };

  const access_token  = issueAccessToken(user);
  const refresh_token = await issueRefreshToken(user.id);

  return { user, tokens: { access_token, refresh_token } };
}

export async function refresh(rawToken: string): Promise<TokenPair | null> {
  const hash = crypto.createHash("sha256").update(rawToken).digest("hex");

  const result = await pool.query<{ user_id: string; expires_at: Date }>(
    `SELECT user_id, expires_at FROM refresh_tokens WHERE token_hash = $1`,
    [hash]
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  if (new Date() > row.expires_at) {
    await pool.query(`DELETE FROM refresh_tokens WHERE token_hash = $1`, [hash]);
    return null;
  }

  // Rotate refresh token
  await pool.query(`DELETE FROM refresh_tokens WHERE token_hash = $1`, [hash]);

  const userResult = await pool.query<User>(
    `SELECT id, email, created_at::text FROM users WHERE id = $1`,
    [row.user_id]
  );

  if (userResult.rows.length === 0) return null;

  const user          = userResult.rows[0];
  const access_token  = issueAccessToken(user);
  const refresh_token = await issueRefreshToken(user.id);

  return { access_token, refresh_token };
}

export async function logout(rawToken: string): Promise<void> {
  const hash = crypto.createHash("sha256").update(rawToken).digest("hex");
  await pool.query(`DELETE FROM refresh_tokens WHERE token_hash = $1`, [hash]);
}

export function verifyAccessToken(token: string): JwtPayload {
  return jwt.verify(token, ACCESS_SECRET) as JwtPayload;
}

export async function getUserById(id: string): Promise<User | null> {
  const result = await pool.query<User>(
    `SELECT id, email, created_at::text FROM users WHERE id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}
