import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "../api.js";
import type { LuminaOpenDesignRuntime } from "./runtime.js";
import { LUMINA_OPEN_DESIGN_BASE_PATH, renderLuminaOpenDesignUi } from "./ui.js";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_OPENAI_BODY_BYTES = 20 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const OPENCLAW_DESIGN_MODEL = "openclaw/design";

// Mirrors the trusted plugin runtime's own options so the scope union stays
// identical; a local `string[]` would not satisfy `OperatorScope[]`.
export type GatewayRequestOptions = Parameters<
  OpenClawPluginApi["runtime"]["gateway"]["request"]
>[2];

export type GatewayRequest = <T = unknown>(
  method: string,
  params?: Record<string, unknown>,
  options?: GatewayRequestOptions,
) => Promise<T>;

export type LuminaOpenDesignDeps = {
  runtime: LuminaOpenDesignRuntime;
  gatewayRequest: GatewayRequest;
  sessionKey: string;
};

export type LuminaOpenDesignSubmission = {
  ok: true;
  projectId: string;
  runId?: string;
  status: string;
  modelPolicy: "openclaw-current-model";
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
    "content-type": "application/json; charset=utf-8",
  });
  res.end(payload);
}

function sendHtml(res: ServerResponse, body: string): void {
  res.writeHead(200, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-security-policy":
      "default-src 'self'; img-src 'self' data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-src 'self'; connect-src 'self'",
    "content-type": "text/html; charset=utf-8",
  });
  res.end(body);
}

async function readJsonBody(
  req: IncomingMessage,
  maxBytes = MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      throw new Error("request body is too large");
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  const parsed = raw ? (JSON.parse(raw) as unknown) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

type ToolNameBridge = {
  toClient: Map<string, string>;
  toUpstream: Map<string, string>;
};

function toolFunction(entry: unknown): Record<string, unknown> | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  const fn = (entry as Record<string, unknown>).function;
  return fn && typeof fn === "object" && !Array.isArray(fn)
    ? (fn as Record<string, unknown>)
    : null;
}

function bridgeToolNames(payload: Record<string, unknown>): ToolNameBridge {
  const bridge: ToolNameBridge = { toClient: new Map(), toUpstream: new Map() };
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  tools.forEach((tool, index) => {
    const fn = toolFunction(tool);
    const clientName = typeof fn?.name === "string" ? fn.name.trim() : "";
    if (!fn || !clientName) {
      return;
    }
    const safeName = clientName.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 48) || "tool";
    const upstreamName = `odc_${index}_${safeName}`;
    bridge.toClient.set(upstreamName, clientName);
    bridge.toUpstream.set(clientName, upstreamName);
    fn.name = upstreamName;
  });

  const rewriteFunctionName = (entry: unknown) => {
    const fn = toolFunction(entry);
    if (fn && typeof fn.name === "string") {
      fn.name = bridge.toUpstream.get(fn.name) ?? fn.name;
    }
  };
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  for (const message of messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      continue;
    }
    const record = message as Record<string, unknown>;
    if (Array.isArray(record.tool_calls)) {
      record.tool_calls.forEach(rewriteFunctionName);
    }
    if (typeof record.name === "string") {
      record.name = bridge.toUpstream.get(record.name) ?? record.name;
    }
  }
  rewriteFunctionName(payload.tool_choice);
  payload.model = OPENCLAW_DESIGN_MODEL;
  return bridge;
}

function restoreToolNames(payload: unknown, bridge: ToolNameBridge): void {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return;
  }
  const choices = Array.isArray((payload as Record<string, unknown>).choices)
    ? ((payload as Record<string, unknown>).choices as unknown[])
    : [];
  for (const choice of choices) {
    if (!choice || typeof choice !== "object" || Array.isArray(choice)) {
      continue;
    }
    const choiceRecord = choice as Record<string, unknown>;
    for (const container of [choiceRecord.message, choiceRecord.delta]) {
      if (!container || typeof container !== "object" || Array.isArray(container)) {
        continue;
      }
      const toolCalls = (container as Record<string, unknown>).tool_calls;
      if (!Array.isArray(toolCalls)) {
        continue;
      }
      for (const call of toolCalls) {
        const fn = toolFunction(call);
        if (fn && typeof fn.name === "string") {
          fn.name = bridge.toClient.get(fn.name) ?? fn.name;
        }
      }
    }
  }
}

function rewriteSseLine(line: string, bridge: ToolNameBridge): string {
  if (!line.startsWith("data:")) {
    return line;
  }
  const data = line.slice(5).trimStart();
  if (!data || data === "[DONE]") {
    return line;
  }
  try {
    const payload = JSON.parse(data) as unknown;
    restoreToolNames(payload, bridge);
    return `data: ${JSON.stringify(payload)}`;
  } catch {
    return line;
  }
}

async function proxyOpenAiChat(
  runtime: LuminaOpenDesignRuntime,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const payload = await readJsonBody(req, MAX_OPENAI_BODY_BYTES);
  const bridge = bridgeToolNames(payload);
  const upstream = await runtime.gatewayChatCompletions(payload);
  const contentType = upstream.headers.get("content-type") ?? "application/json; charset=utf-8";
  if (!contentType.includes("text/event-stream") || !upstream.body) {
    const raw = await upstream.text();
    let body = raw;
    try {
      const parsed = raw ? (JSON.parse(raw) as unknown) : {};
      restoreToolNames(parsed, bridge);
      body = JSON.stringify(parsed);
    } catch {
      // Preserve non-JSON upstream diagnostics.
    }
    res.writeHead(upstream.status, {
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(body),
      "content-type": contentType,
    });
    res.end(body);
    return;
  }

  res.writeHead(upstream.status, {
    "cache-control": "no-store",
    connection: "keep-alive",
    "content-type": contentType,
  });
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (true) {
    const chunk = await reader.read();
    pending += decoder.decode(chunk.value, { stream: !chunk.done });
    const lines = pending.split("\n");
    pending = chunk.done ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      res.write(`${rewriteSseLine(line.replace(/\r$/u, ""), bridge)}\n`);
    }
    if (chunk.done) {
      if (pending) {
        res.write(rewriteSseLine(pending, bridge));
      }
      break;
    }
  }
  res.end();
}

async function daemonJson(runtime: LuminaOpenDesignRuntime, pathname: string, init?: RequestInit) {
  const response = await runtime.request(pathname, init);
  const payloadText = await response.text();
  let body: unknown;
  try {
    body = payloadText ? JSON.parse(payloadText) : {};
  } catch {
    body = { message: payloadText };
  }
  if (!response.ok) {
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    throw new Error(
      String(record.message ?? record.error ?? `OpenDesign returned ${response.status}`),
    );
  }
  return body as Record<string, unknown>;
}

function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 96);
  return slug || `lumina-design-${Date.now()}`;
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function promptForDesign(input: {
  projectId: string;
  name: string;
  brief: string;
  kind: string;
  designSystem?: string;
  skill?: string;
}): string {
  return [
    "Trabaja como Lumina en una tarea de diseño usando el servidor MCP open-design.",
    "Conserva el modelo actual de OpenClaw. No cambies de modelo, no delegues agentes y no uses start_run.",
    `Proyecto OpenDesign existente: ${input.projectId} (${input.name}).`,
    `Formato solicitado: ${input.kind}.`,
    input.designSystem
      ? `Sistema de diseño seleccionado: ${input.designSystem}.`
      : "Selecciona una dirección visual apropiada.",
    input.skill ? `Skill seleccionada: ${input.skill}.` : "Usa las skills de diseño pertinentes.",
    "Usa get_project/list_files antes de editar. Crea el artefacto con create_artifact o actualízalo con write_file.",
    "Entrega una pieza terminada, responsive y accesible, con contenido realista, estados e interacciones completas. Evita placeholders y texto lorem ipsum.",
    "Solicitud del usuario:",
    input.brief,
  ].join("\n");
}

export async function submitLuminaOpenDesign(
  deps: LuminaOpenDesignDeps,
  body: Record<string, unknown>,
): Promise<LuminaOpenDesignSubmission> {
  const name = text(body.name, 90);
  const brief = text(body.brief, 8_000);
  const kind = text(body.kind, 40) || "web";
  const designSystem = text(body.designSystem, 160) || undefined;
  const skill = text(body.skill, 160) || undefined;
  if (!name || !brief) {
    throw new Error("name and brief are required");
  }
  let projectId = text(body.projectId, 128);
  if (projectId && !SAFE_ID.test(projectId)) {
    throw new Error("invalid project id");
  }
  if (!projectId) {
    projectId = slugify(name);
    const projectBody: Record<string, unknown> = {
      id: projectId,
      name,
      skipDiscoveryBrief: true,
    };
    if (designSystem) {
      projectBody.designSystemId = designSystem;
    }
    if (skill) {
      projectBody.skillId = skill;
    }
    await daemonJson(deps.runtime, "/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(projectBody),
    });
  }
  const result = await deps.gatewayRequest<{ runId?: unknown; status?: unknown }>(
    "chat.send",
    {
      sessionKey: deps.sessionKey,
      message: promptForDesign({ projectId, name, brief, kind, designSystem, skill }),
      deliver: false,
      idempotencyKey: randomUUID(),
    },
    { scopes: ["operator.write"], timeoutMs: 20_000 },
  );
  return {
    ok: true,
    projectId,
    runId: typeof result.runId === "string" ? result.runId : undefined,
    status: typeof result.status === "string" ? result.status : "started",
    modelPolicy: "openclaw-current-model",
  };
}

function catalogItems(payload: Record<string, unknown>, key: string, limit: number) {
  const items = Array.isArray(payload[key]) ? payload[key] : [];
  return items.slice(0, limit).flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const entry = item as Record<string, unknown>;
    const id = text(entry.id, 160);
    if (!id) {
      return [];
    }
    return [{ id, name: text(entry.name ?? entry.title, 180) || id }];
  });
}

function safePreviewPath(raw: string): { projectId: string; filePath: string } | null {
  const parts = raw
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));
  const projectId = parts.shift() ?? "";
  if (
    !SAFE_ID.test(projectId) ||
    parts.length === 0 ||
    parts.some((part) => part === "." || part === ".." || part.includes("\\"))
  ) {
    return null;
  }
  return { projectId, filePath: parts.join("/") };
}

async function proxyPreview(
  runtime: LuminaOpenDesignRuntime,
  res: ServerResponse,
  projectId: string,
  filePath: string,
): Promise<void> {
  const upstream = await runtime.request(
    `/api/projects/${encodeURIComponent(projectId)}/raw/${filePath.split("/").map(encodeURIComponent).join("/")}`,
  );
  if (!upstream.ok) {
    sendJson(res, upstream.status, { error: `preview unavailable (${upstream.status})` });
    return;
  }
  let body = Buffer.from(await upstream.arrayBuffer());
  const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
  if (contentType.includes("text/html")) {
    const base = `${LUMINA_OPEN_DESIGN_BASE_PATH}/preview/${encodeURIComponent(projectId)}/`;
    const html = body.toString("utf8");
    const tag = `<base href="${base}">`;
    body = Buffer.from(
      /<head(?:\s[^>]*)?>/iu.test(html)
        ? html.replace(/<head(?:\s[^>]*)?>/iu, (match) => `${match}${tag}`)
        : `${tag}${html}`,
    );
  }
  res.writeHead(200, {
    "cache-control": "no-store",
    "content-length": body.length,
    "content-type": contentType,
  });
  res.end(body);
}

export function createLuminaOpenDesignHttpHandler(deps: LuminaOpenDesignDeps) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith(LUMINA_OPEN_DESIGN_BASE_PATH)) {
      return false;
    }
    const route = url.pathname.slice(LUMINA_OPEN_DESIGN_BASE_PATH.length) || "/";
    try {
      if (req.method === "GET" && route === "/") {
        sendHtml(res, renderLuminaOpenDesignUi());
        return true;
      }
      if (req.method === "GET" && route === "/api/status") {
        sendJson(res, 200, {
          ...(await deps.runtime.ensureReady()),
          integration: deps.runtime.integrationStatus(),
        });
        return true;
      }
      if (req.method === "POST" && route === "/api/integration/sync") {
        sendJson(res, 200, await deps.runtime.syncGatewayAgent());
        return true;
      }
      if (req.method === "GET" && route === "/openai/v1/models") {
        sendJson(res, 200, {
          object: "list",
          data: [
            {
              id: OPENCLAW_DESIGN_MODEL,
              object: "model",
              owned_by: "lumina-openclaw",
            },
          ],
        });
        return true;
      }
      if (req.method === "POST" && route === "/openai/v1/chat/completions") {
        await proxyOpenAiChat(deps.runtime, req, res);
        return true;
      }
      if (req.method === "GET" && route === "/api/projects") {
        sendJson(res, 200, await daemonJson(deps.runtime, "/api/projects"));
        return true;
      }
      if (req.method === "GET" && route === "/api/catalog") {
        const [skills, systems, plugins] = await Promise.all([
          daemonJson(deps.runtime, "/api/skills"),
          daemonJson(deps.runtime, "/api/design-systems"),
          daemonJson(deps.runtime, "/api/plugins"),
        ]);
        const skillItems = catalogItems(skills, "skills", 240);
        const systemItems = catalogItems(systems, "designSystems", 240);
        const pluginItems = catalogItems(plugins, "plugins", 400);
        sendJson(res, 200, {
          skills: skillItems,
          designSystems: systemItems,
          counts: {
            skills: Array.isArray(skills.skills) ? skills.skills.length : skillItems.length,
            designSystems: Array.isArray(systems.designSystems)
              ? systems.designSystems.length
              : systemItems.length,
            plugins: Array.isArray(plugins.plugins) ? plugins.plugins.length : pluginItems.length,
          },
        });
        return true;
      }
      const projectFiles = route.match(/^\/api\/projects\/([^/]+)\/files$/u);
      if (req.method === "GET" && projectFiles) {
        const projectId = decodeURIComponent(projectFiles[1] ?? "");
        if (!SAFE_ID.test(projectId)) {
          sendJson(res, 400, { error: "invalid project id" });
          return true;
        }
        sendJson(
          res,
          200,
          await daemonJson(deps.runtime, `/api/projects/${encodeURIComponent(projectId)}/files`),
        );
        return true;
      }
      const projectConversations = route.match(/^\/api\/projects\/([^/]+)\/conversations$/u);
      if (req.method === "GET" && projectConversations) {
        const projectId = decodeURIComponent(projectConversations[1] ?? "");
        if (!SAFE_ID.test(projectId)) {
          sendJson(res, 400, { error: "invalid project id" });
          return true;
        }
        sendJson(
          res,
          200,
          await daemonJson(
            deps.runtime,
            `/api/projects/${encodeURIComponent(projectId)}/conversations`,
          ),
        );
        return true;
      }
      if (req.method === "POST" && route === "/api/design") {
        sendJson(res, 202, await submitLuminaOpenDesign(deps, await readJsonBody(req)));
        return true;
      }
      if (req.method === "POST" && route === "/api/studio") {
        const body = await readJsonBody(req);
        const projectId = text(body.projectId, 128) || undefined;
        if (projectId && !SAFE_ID.test(projectId)) {
          sendJson(res, 400, { error: "invalid project id" });
          return true;
        }
        const status = await deps.runtime.launchDesktop(projectId);
        sendJson(res, 202, { ok: true, projectId, source: status.source });
        return true;
      }
      if (req.method === "GET" && route.startsWith("/preview/")) {
        const preview = safePreviewPath(route.slice("/preview/".length));
        if (!preview) {
          sendJson(res, 400, { error: "invalid preview path" });
          return true;
        }
        await proxyPreview(deps.runtime, res, preview.projectId, preview.filePath);
        return true;
      }
      sendJson(res, 404, { error: "not found" });
      return true;
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      return true;
    }
  };
}
