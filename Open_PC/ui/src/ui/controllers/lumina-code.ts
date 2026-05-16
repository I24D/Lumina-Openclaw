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

function uniqueValues(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
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

function describeFetchFailure(baseUrl: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/failed to fetch|networkerror|load failed|fetch/i.test(message)) {
    return `${baseUrl} no responde o el WebView bloqueo CORS. Reinicia Lumina OpenClaw para cargar el proxy local actualizado.`;
  }
  return `${baseUrl}: ${message}`;
}

async function fetchLuminaCodeEndpoint(
  path: string,
  init: RequestInit,
): Promise<{ response: Response; baseUrl: string }> {
  const errors: string[] = [];
  for (const baseUrl of resolveProxyBaseUrls()) {
    try {
      return {
        response: await fetch(`${baseUrl}${path}`, init),
        baseUrl,
      };
    } catch (err) {
      errors.push(describeFetchFailure(baseUrl, err));
    }
  }

  throw new Error(
    `No pude conectar con el proxy local de Lumina Code. ${errors.join(" ")}`,
  );
}

export async function loadLuminaCodeStatus(state: LuminaCodeState): Promise<void> {
  if (state.luminaCodeStatusLoading) {
    return;
  }
  state.luminaCodeStatusLoading = true;
  state.luminaCodeError = null;
  try {
    const { response } = await fetchLuminaCodeEndpoint("/__lumina/code/status", {
      method: "GET",
      headers: { Accept: "application/json" },
    });
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
    const { response } = await fetchLuminaCodeEndpoint("/__lumina/code/open", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
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
