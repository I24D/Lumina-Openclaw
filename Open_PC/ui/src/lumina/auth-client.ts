const AUTH_URL_KEY = "__LUMINA_AUTH_URL__";
const ACCESS_TOKEN_KEY = "lumina.auth.access_token";
const REFRESH_TOKEN_KEY = "lumina.auth.refresh_token";
const USER_KEY = "lumina.auth.user";

function getAuthBaseUrl(): string {
  if (typeof window !== "undefined" && (window as Record<string, unknown>)[AUTH_URL_KEY]) {
    return String((window as Record<string, unknown>)[AUTH_URL_KEY]).replace(/\/$/, "");
  }
  return "http://localhost:3200";
}

export interface LuminaUser {
  id: string;
  email: string;
  created_at: string;
}

export interface LuminaAuthResult {
  user: LuminaUser;
  access_token: string;
  refresh_token: string;
}

export class LuminaAuthError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

async function authFetch(path: string, body: Record<string, string>): Promise<LuminaAuthResult> {
  const res = await fetch(`${getAuthBaseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  if (!res.ok) {
    throw new LuminaAuthError(
      typeof data["error"] === "string" ? data["error"] : "Authentication failed",
      res.status,
    );
  }

  return data as LuminaAuthResult;
}

export async function luminaLogin(email: string, password: string): Promise<LuminaAuthResult> {
  const result = await authFetch("/auth/login", { email, password });
  persistAuth(result);
  return result;
}

export async function luminaRegister(email: string, password: string): Promise<LuminaAuthResult> {
  const result = await authFetch("/auth/register", { email, password });
  persistAuth(result);
  return result;
}

export function luminaLogout(): void {
  const token = getRefreshToken();
  if (token) {
    fetch(`${getAuthBaseUrl()}/auth/logout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: token }),
    }).catch(() => {});
  }
  clearAuth();
}

function persistAuth(result: LuminaAuthResult): void {
  try {
    localStorage.setItem(ACCESS_TOKEN_KEY, result.access_token);
    localStorage.setItem(REFRESH_TOKEN_KEY, result.refresh_token);
    localStorage.setItem(USER_KEY, JSON.stringify(result.user));
  } catch {
    // best-effort
  }
}

function clearAuth(): void {
  try {
    localStorage.removeItem(ACCESS_TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {
    // best-effort
  }
}

export function getAccessToken(): string | null {
  try {
    return localStorage.getItem(ACCESS_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getRefreshToken(): string | null {
  try {
    return localStorage.getItem(REFRESH_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getStoredUser(): LuminaUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as LuminaUser) : null;
  } catch {
    return null;
  }
}

export function isLuminaAuthenticated(): boolean {
  const token = getAccessToken();
  if (!token) return false;

  try {
    // Decode the JWT payload (no signature check — the server verifies it)
    const [, payload] = token.split(".");
    if (!payload) return false;
    const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as {
      exp?: number;
    };
    if (typeof decoded.exp !== "number") return true;
    return Date.now() < decoded.exp * 1000;
  } catch {
    return false;
  }
}

export async function refreshLuminaToken(): Promise<boolean> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;

  try {
    const res = await fetch(`${getAuthBaseUrl()}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (!res.ok) {
      clearAuth();
      return false;
    }

    const data = (await res.json()) as { access_token: string; refresh_token: string };
    localStorage.setItem(ACCESS_TOKEN_KEY, data.access_token);
    localStorage.setItem(REFRESH_TOKEN_KEY, data.refresh_token);
    return true;
  } catch {
    return false;
  }
}
