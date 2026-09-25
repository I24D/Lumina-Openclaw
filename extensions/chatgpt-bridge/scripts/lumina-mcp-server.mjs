#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT_CANDIDATES = [
  path.resolve(SCRIPT_DIR, "../../.."),
  path.resolve(SCRIPT_DIR, "../../../.."),
];
const REPO_ROOT =
  REPO_ROOT_CANDIDATES.find((candidate) => existsSync(path.join(candidate, "dist", "index.js"))) ??
  REPO_ROOT_CANDIDATES[0];
const OPENCLAW_ENTRY = path.join(REPO_ROOT, "dist", "index.js");
const AGENT_ID = process.env.OPENCLAW_CHATGPT_AGENT_ID?.trim() || "main";
const SESSION_KEY =
  process.env.OPENCLAW_CHATGPT_SESSION_KEY?.trim() || `agent:${AGENT_ID}:chatgpt-voice`;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_POLL_MS = 20_000;
const MAX_POLL_MS = 25_000;

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function errorMessage(value) {
  if (value instanceof Error) {
    return value.message;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

function appendLimited(current, chunk, streamName) {
  const next = current + chunk;
  if (Buffer.byteLength(next, "utf8") > MAX_OUTPUT_BYTES) {
    throw new Error(`OpenClaw ${streamName} exceeded ${MAX_OUTPUT_BYTES} bytes`);
  }
  return next;
}

export function runOpenClawJson(args, options = {}) {
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? 30_000);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [OPENCLAW_ENTRY, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, NO_COLOR: "1" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const terminate = () => {
      if (!child.killed) {
        child.kill();
      }
    };
    const onAbort = () => {
      terminate();
      finish(() => reject(new Error("La llamada a Lumina fue cancelada.")));
    };
    const timer = setTimeout(() => {
      terminate();
      finish(() => reject(new Error(`OpenClaw no respondio dentro de ${timeoutMs} ms.`)));
    }, timeoutMs);
    timer.unref?.();

    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      try {
        stdout = appendLimited(stdout, chunk, "stdout");
      } catch (error) {
        terminate();
        finish(() => reject(error));
      }
    });
    child.stderr.on("data", (chunk) => {
      try {
        stderr = appendLimited(stderr, chunk, "stderr");
      } catch (error) {
        terminate();
        finish(() => reject(error));
      }
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code, signal) => {
      finish(() => {
        const output = stdout.trim();
        let parsed;
        try {
          parsed = JSON.parse(output);
        } catch {
          const detail = stderr.trim() || output || `exit ${code ?? signal ?? "unknown"}`;
          reject(new Error(`OpenClaw devolvio una respuesta no valida: ${detail}`));
          return;
        }
        if (code !== 0 || record(parsed).ok === false) {
          const parsedError = record(record(parsed).error);
          const detail =
            readString(parsedError.message) ||
            stderr.trim() ||
            `OpenClaw termino con codigo ${code}`;
          reject(new Error(detail));
          return;
        }
        resolve(parsed);
      });
    });
  });
}

export async function gatewayCall(method, params = {}, options = {}) {
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? 30_000);
  return await runOpenClawJson(
    [
      "gateway",
      "call",
      method,
      "--json",
      "--timeout",
      String(timeoutMs),
      "--params",
      JSON.stringify(params),
    ],
    { signal: options.signal, timeoutMs: timeoutMs + 5_000 },
  );
}

function toolError(error) {
  const message = errorMessage(error);
  return {
    content: [{ type: "text", text: `Lumina no pudo completar la solicitud: ${message}` }],
    structuredContent: { ok: false, error: message },
    isError: true,
  };
}

function conciseJson(value) {
  return JSON.stringify(value, null, 2);
}

function terminalReply(result) {
  const reply = record(record(result).terminalReply);
  return readString(reply.text);
}

function runStatus(result) {
  return readString(record(result).status) ?? "pending";
}

function presentRun(runId, result) {
  const status = runStatus(result);
  const reply = terminalReply(result);
  if (status === "pending" || status === "timeout" || status === "running") {
    return {
      content: [
        {
          type: "text",
          text:
            `Lumina sigue trabajando. La respuesta no se perdio y quedo guardada con runId ${runId}. ` +
            `Vuelve a llamar lumina_wait con este mismo runId. No canceles ni inicies una tarea duplicada.`,
        },
      ],
      structuredContent: {
        ok: true,
        complete: false,
        status: "pending",
        runId,
        retryAfterMs: record(result).retryAfterMs ?? 3_000,
        durable: true,
        result,
      },
    };
  }
  if (status === "error") {
    const error = readString(record(result).error) ?? "La tarea de Lumina termino con error.";
    return {
      content: [{ type: "text", text: reply ?? error }],
      structuredContent: {
        ok: false,
        complete: true,
        status: "error",
        runId,
        error,
        durable: true,
        result,
      },
    };
  }
  return {
    content: [
      {
        type: "text",
        text: reply ?? `Lumina termino con este resultado:\n${conciseJson(result)}`,
      },
    ],
    structuredContent: {
      ok: true,
      complete: true,
      status: "ok",
      runId,
      durable: true,
      result,
    },
  };
}

async function startLuminaRun(instruction, signal) {
  const result = await gatewayCall(
    "chatgpt.mcp.send",
    {
      instruction,
      timeoutMs: 0,
      idempotencyKey: `chatgpt-mcp:${randomUUID()}`,
    },
    { signal, timeoutMs: 20_000 },
  );
  const runId = readString(record(result).runId);
  if (!runId) {
    throw new Error("El Gateway acepto la orden pero no devolvio runId.");
  }
  return { runId, status: readString(record(result).status) ?? "started" };
}

async function waitForLuminaRun(runId, timeoutMs, signal) {
  const boundedTimeoutMs = Math.max(0, Math.min(timeoutMs, MAX_POLL_MS));
  return await gatewayCall(
    "chatgpt.mcp.wait",
    { runId, timeoutMs: boundedTimeoutMs },
    { signal, timeoutMs: boundedTimeoutMs + 10_000 },
  );
}

function registerTools(server) {
  server.registerTool(
    "lumina_status",
    {
      title: "Estado de Lumina",
      description:
        "Comprueba si el Gateway local de Lumina esta disponible. Usa esta herramienta antes de delegar si la conexion es incierta.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (_args, extra) => {
      try {
        const health = record(
          await gatewayCall("health", {}, { signal: extra.signal, timeoutMs: 90_000 }),
        );
        const channels = record(health.channels);
        const channelSummary = Object.fromEntries(
          Object.entries(channels).map(([name, raw]) => {
            const state = record(raw);
            return [
              name,
              {
                configured: state.configured === true,
                connected: state.connected === true || state.lifecycle === "ready",
                lifecycle:
                  readString(state.lifecycle) ?? readString(state.healthState) ?? "unknown",
              },
            ];
          }),
        );
        const summary = {
          ok: health.ok === true,
          agentId: AGENT_ID,
          sessionKey: SESSION_KEY,
          eventLoopDegraded: record(health.eventLoop).degraded === true,
          pluginErrors: Array.isArray(record(health.plugins).errors)
            ? record(health.plugins).errors.length
            : 0,
          channels: channelSummary,
        };
        return {
          content: [
            {
              type: "text",
              text: summary.ok
                ? `Lumina esta conectada en ${SESSION_KEY}.`
                : "El Gateway de Lumina respondio, pero reporto estado no saludable.",
            },
          ],
          structuredContent: summary,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "lumina_ask",
    {
      title: "Pedir a Lumina con recuperacion duradera",
      description:
        "Entrega una orden a Lumina y espera como maximo 25 segundos. Si sigue pendiente, conserva el runId y DEBES llamar lumina_wait repetidamente; un timeout del cliente nunca cancela la tarea.",
      inputSchema: {
        instruction: z.string().trim().min(1).max(8_000),
        timeout_seconds: z.number().int().min(0).max(25).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ instruction, timeout_seconds }, extra) => {
      let runId;
      try {
        const started = await startLuminaRun(instruction, extra.signal);
        runId = started.runId;
        const waited = await waitForLuminaRun(
          runId,
          (timeout_seconds ?? DEFAULT_POLL_MS / 1_000) * 1_000,
          extra.signal,
        );
        return presentRun(runId, waited);
      } catch (error) {
        // Losing the ChatGPT/Desktop Commander request must never cancel the
        // already accepted Lumina run. The durable inbox keeps its result.
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "lumina_delegate",
    {
      title: "Delegar trabajo a Lumina",
      description:
        "Inicia una tarea duradera y devuelve inmediatamente un runId. La tarea sigue aunque ChatGPT se desconecte. DEBES consultar lumina_wait hasta complete=true; no vuelvas a delegar la misma orden.",
      inputSchema: { instruction: z.string().trim().min(1).max(8_000) },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ instruction }, extra) => {
      try {
        const started = await startLuminaRun(instruction, extra.signal);
        return {
          content: [
            {
              type: "text",
              text:
                `Lumina acepto la tarea duradera. runId: ${started.runId}. ` +
                `Usa lumina_wait con este mismo runId hasta recibir complete=true.`,
            },
          ],
          structuredContent: {
            ok: true,
            complete: false,
            durable: true,
            ...started,
            sessionKey: SESSION_KEY,
            nextAction: "lumina_wait",
          },
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "lumina_wait",
    {
      title: "Esperar a Lumina",
      description:
        "Consulta una tarea duradera por runId. Cada llamada dura maximo 25 segundos para evitar el limite de ChatGPT. Si devuelve complete=false, DEBES repetir esta herramienta con el mismo runId; nunca trates pending como fallo.",
      inputSchema: {
        run_id: z.string().trim().min(1).max(200),
        timeout_seconds: z.number().int().min(0).max(25).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ run_id, timeout_seconds }, extra) => {
      try {
        const waited = await waitForLuminaRun(
          run_id,
          (timeout_seconds ?? DEFAULT_POLL_MS / 1_000) * 1_000,
          extra.signal,
        );
        return presentRun(run_id, waited);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "lumina_tasks",
    {
      title: "Buzon duradero de Lumina",
      description:
        "Lista tareas recientes y recupera runId perdidos despues de un timeout, desconexion o reinicio de ChatGPT. Revisa este buzon antes de volver a enviar una orden que podria estar ejecutandose.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional(),
        status: z.enum(["running", "completed", "failed", "cancelled"]).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ limit, status }, extra) => {
      try {
        const result = await gatewayCall(
          "chatgpt.mcp.list",
          { limit: limit ?? 20, ...(status ? { status } : {}) },
          { signal: extra.signal, timeoutMs: 20_000 },
        );
        const jobs = Array.isArray(record(result).jobs) ? record(result).jobs : [];
        return {
          content: [
            {
              type: "text",
              text:
                jobs.length > 0
                  ? `Buzon duradero de Lumina:\n${conciseJson(jobs)}`
                  : "El buzon duradero de Lumina no contiene tareas con ese filtro.",
            },
          ],
          structuredContent: { ok: true, durable: true, count: jobs.length, jobs },
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "lumina_cancel",
    {
      title: "Cancelar trabajo de Lumina",
      description:
        "Cancela explicitamente una tarea de Lumina. No uses esta herramienta por timeout, pending o desconexion; esos estados no cancelan la tarea.",
      inputSchema: { run_id: z.string().trim().min(1).max(200).optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ run_id }, extra) => {
      try {
        const result = await gatewayCall(
          "chatgpt.mcp.abort",
          { ...(run_id ? { runId: run_id } : {}) },
          { signal: extra.signal, timeoutMs: 20_000 },
        );
        return {
          content: [{ type: "text", text: "La solicitud de cancelacion fue enviada a Lumina." }],
          structuredContent: { ok: true, result },
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "lumina_capabilities",
    {
      title: "Capacidades de Lumina",
      description:
        "Describe las clases de trabajo que ChatGPT puede delegar a Lumina y las restricciones de seguridad aplicadas.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () => {
      const capabilities = [
        "memoria y recuperacion de contexto",
        "investigacion y navegador dedicado",
        "archivos, documentos y codigo",
        "mensajeria y canales conectados",
        "automatizaciones y tareas programadas",
        "agentes especializados y diseno",
        "diagnostico y mantenimiento de OpenClaw",
      ];
      return {
        content: [
          {
            type: "text",
            text:
              "ChatGPT puede delegar a Lumina: " +
              capabilities.join(", ") +
              ". Las acciones sensibles conservan las aprobaciones y politicas de OpenClaw.",
          },
        ],
        structuredContent: {
          agentId: AGENT_ID,
          sessionKey: SESSION_KEY,
          capabilities,
          security:
            "Las ordenes entran como external_user; OpenClaw conserva sus politicas y aprobaciones.",
        },
      };
    },
  );
}

export function createLuminaMcpServer() {
  const server = new McpServer(
    { name: "lumina-openclaw", version: "1.1.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Para trabajo potencialmente largo usa lumina_delegate una sola vez y luego lumina_wait con el mismo runId en consultas de 20 segundos. Si complete=false o status=pending, vuelve a llamar lumina_wait; no canceles ni dupliques la orden. Si una conversacion anterior termino por timeout, usa lumina_tasks para recuperar el runId y despues lumina_wait. No afirmes que termino hasta complete=true. Lumina conserva sus aprobaciones.",
    },
  );
  registerTools(server);
  return server;
}

export async function main() {
  const server = createLuminaMcpServer();
  const transport = new StdioServerTransport();
  const shutdown = () => {
    void server.close().finally(() => {
      process.exitCode = 0;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await server.connect(transport);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(`[lumina-mcp] ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
