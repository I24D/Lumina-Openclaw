export type LuminaCodeStatus = {
  ok: boolean;
  platform: string;
  vscode: {
    available: boolean;
    executablePath: string | null;
    displayName: string;
  };
  extension: {
    id: string;
    version: string;
    vsixAvailable: boolean;
    vsixPath: string | null;
  };
  workspace: {
    path: string;
    exists: boolean;
  };
  message?: string;
};

type LuminaCodeState = {
  luminaCodeStatusLoading: boolean;
  luminaCodeOpening: boolean;
  luminaCodeStatus: LuminaCodeStatus | null;
  luminaCodeError: string | null;
  luminaCodeMessage: string | null;
};

type LuminaCodeBridgeRequest = (
  method: string,
  path: string,
  body?: string,
) => Promise<{ status: number; body: unknown }>;

const STATUS_RETRY_COUNT = 25;
const OPEN_RETRY_COUNT = 45;
const STARTUP_RETRY_DELAY_MS = 1_000;

function uniqueValues(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function isLuminaDesktopShell(): boolean {
  return typeof window !== "undefined" && window.__LUMINA__?.shell === "tauri";
}

function resolveProxyBaseUrls(): string[] {
  const bridgeConfig = window.__LUMINA__?.config as { proxyUrl?: string } | undefined;
  const proxyUrl = bridgeConfig?.proxyUrl?.trim();
  return uniqueValues([
    proxyUrl ? proxyUrl.replace(/\/+$/, "") : "",
    "http://127.0.0.1:4321",
    "http://localhost:4321",
  ]);
}

function resolveDesktopBridgeRequest(): LuminaCodeBridgeRequest | null {
  const bridge = window.__LUMINA__?.luminaCodeRequest;
  return isLuminaDesktopShell() && typeof bridge === "function"
    ? bridge.bind(window.__LUMINA__)
    : null;
}

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return (await response.json()) as Record<string, unknown>;
  }
  const text = await response.text();
  return { ok: false, message: text || response.statusText };
}

function messageFromPayload(payload: Record<string, unknown>, fallback: string): string {
  const message = payload.message ?? payload.error;
  return typeof message === "string" && message.trim() ? message : fallback;
}

async function messageFromResponse(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await readJsonResponse(response.clone());
    return messageFromPayload(payload, fallback);
  } catch {
    return fallback;
  }
}

function isRetryableBridgeResponse(response: Response): boolean {
  return response.status === 502 || response.status === 503 || response.status === 504;
}

function describeFetchFailure(baseUrl: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const target = baseUrl || "bridge interno";
  if (/failed to fetch|networkerror|load failed|fetch/i.test(message)) {
    return `${target} no respondio a tiempo. Lumina va a reintentar automaticamente.`;
  }
  return `${target}: ${message}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function responseFromBridgeResult(result: { status: number; body: unknown }): Response {
  const status = Number.isFinite(result.status) ? Math.trunc(result.status) : 500;
  return new Response(JSON.stringify(result.body ?? {}), {
    status: Math.min(599, Math.max(200, status)),
    headers: { "Content-Type": "application/json" },
  });
}

function bodyAsString(init: RequestInit): string {
  return typeof init.body === "string" ? init.body : "";
}

async function fetchLuminaCodeEndpoint(
  path: string,
  init: RequestInit,
  retryCount = 0,
): Promise<{ response: Response; baseUrl: string }> {
  const bridgeRequest = resolveDesktopBridgeRequest();
  let lastErrors: string[] = [];

  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    const errors: string[] = [];
    if (bridgeRequest) {
      try {
        const result = await bridgeRequest(String(init.method ?? "GET"), path, bodyAsString(init));
        const response = responseFromBridgeResult(result);
        if (response.ok || !isRetryableBridgeResponse(response) || attempt >= retryCount) {
          return { response, baseUrl: "Lumina desktop bridge" };
        }
        errors.push(
          await messageFromResponse(
            response,
            "El puente interno de Lumina Code todavia no esta listo. Lumina va a reintentar automaticamente.",
          ),
        );
      } catch (err) {
        errors.push(describeFetchFailure("Lumina desktop bridge", err));
      }

      lastErrors = errors;
      if (attempt < retryCount) {
        await sleep(STARTUP_RETRY_DELAY_MS);
        continue;
      }
      break;
    }

    for (const baseUrl of resolveProxyBaseUrls()) {
      try {
        const response = await fetch(`${baseUrl}${path}`, {
          cache: "no-store",
          ...init,
        });
        if (response.ok || !isRetryableBridgeResponse(response) || attempt >= retryCount) {
          return { response, baseUrl };
        }
        errors.push(
          await messageFromResponse(
            response,
            `${baseUrl || "bridge interno"} todavia no esta listo. Lumina va a reintentar automaticamente.`,
          ),
        );
      } catch (err) {
        errors.push(describeFetchFailure(baseUrl, err));
      }
    }

    lastErrors = errors;
    if (attempt < retryCount) {
      await sleep(STARTUP_RETRY_DELAY_MS);
    }
  }

  throw new Error(`No pude conectar con Lumina Code. ${lastErrors.join(" ")}`);
}

export async function loadLuminaCodeStatus(state: LuminaCodeState): Promise<void> {
  if (state.luminaCodeStatusLoading) {
    return;
  }
  state.luminaCodeStatusLoading = true;
  state.luminaCodeError = null;
  try {
    const { response } = await fetchLuminaCodeEndpoint(
      "/__lumina/code/status",
      {
        method: "GET",
        headers: { Accept: "application/json" },
      },
      STATUS_RETRY_COUNT,
    );
    const payload = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(messageFromPayload(payload, "No se pudo leer el estado de Lumina Code."));
    }
    state.luminaCodeStatus = payload as unknown as LuminaCodeStatus;
  } catch (err) {
    state.luminaCodeError = err instanceof Error ? err.message : String(err);
  } finally {
    state.luminaCodeStatusLoading = false;
  }
}

export async function openLuminaCode(state: LuminaCodeState): Promise<void> {
  if (state.luminaCodeOpening) {
    return;
  }
  state.luminaCodeOpening = true;
  state.luminaCodeError = null;
  state.luminaCodeMessage = null;
  try {
    const { response } = await fetchLuminaCodeEndpoint(
      "/__lumina/code/open",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: "{}",
      },
      OPEN_RETRY_COUNT,
    );
    const payload = await readJsonResponse(response);
    if (!response.ok || payload.ok === false) {
      throw new Error(messageFromPayload(payload, "No se pudo abrir Lumina Code."));
    }
    state.luminaCodeStatus = payload.status as LuminaCodeStatus;
    state.luminaCodeMessage = messageFromPayload(
      payload,
      "VS Code se abrio con Lumina Code preparado.",
    );
  } catch (err) {
    state.luminaCodeError = err instanceof Error ? err.message : String(err);
  } finally {
    state.luminaCodeOpening = false;
  }
}
