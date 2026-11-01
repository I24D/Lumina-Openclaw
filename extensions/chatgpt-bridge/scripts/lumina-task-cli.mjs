#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { gatewayCall } from "./lumina-mcp-server.mjs";

const MAX_POLL_MS = 25_000;

function readFlag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredFlag(name) {
  const value = readFlag(name)?.trim();
  if (!value) {
    throw new Error(`Falta ${name}.`);
  }
  return value;
}

function integerFlag(name, fallback, minimum, maximum) {
  const raw = readFlag(name);
  if (raw === undefined) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} debe estar entre ${minimum} y ${maximum}.`);
  }
  return value;
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function statusOf(value) {
  const status = object(value).status;
  return typeof status === "string" ? status : "pending";
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function decodeInstruction() {
  const encoded = readFlag("--instruction-base64");
  if (encoded?.trim()) {
    const decoded = Buffer.from(encoded.trim(), "base64url").toString("utf8").trim();
    if (!decoded) {
      throw new Error("--instruction-base64 esta vacio o no es valido.");
    }
    return decoded;
  }
  return requiredFlag("--instruction");
}

async function delegate(instruction) {
  return await gatewayCall(
    "chatgpt.mcp.send",
    {
      instruction,
      timeoutMs: 0,
      idempotencyKey: `desktop-commander:${randomUUID()}`,
    },
    { timeoutMs: 20_000 },
  );
}

async function waitOnce(runId, timeoutSeconds) {
  const timeoutMs = Math.min(timeoutSeconds * 1_000, MAX_POLL_MS);
  return await gatewayCall(
    "chatgpt.mcp.wait",
    { runId, timeoutMs },
    { timeoutMs: timeoutMs + 10_000 },
  );
}

async function watch(runId) {
  print({ ok: true, status: "watching", runId, durable: true });
  while (true) {
    const result = await waitOnce(runId, 25);
    if (statusOf(result) !== "pending") {
      print(result);
      return;
    }
  }
}

function usage() {
  return {
    ok: true,
    usage: [
      "lumina-task-cli.mjs delegate --instruction <texto>",
      "lumina-task-cli.mjs delegate --instruction-base64 <base64url>",
      "lumina-task-cli.mjs delegate-watch --instruction <texto>",
      "lumina-task-cli.mjs wait --run-id <id> [--timeout-seconds 20]",
      "lumina-task-cli.mjs watch --run-id <id>",
      "lumina-task-cli.mjs list [--status running|completed|failed|cancelled] [--limit 20]",
    ],
  };
}

async function main() {
  const command = process.argv[2]?.trim().toLowerCase();
  if (!command || command === "help" || command === "--help") {
    print(usage());
    return;
  }
  if (command === "delegate" || command === "delegate-watch") {
    const started = await delegate(decodeInstruction());
    print(started);
    if (command === "delegate-watch") {
      const runId = object(started).runId;
      if (typeof runId !== "string" || !runId.trim()) {
        throw new Error("Lumina acepto la orden sin devolver runId.");
      }
      await watch(runId.trim());
    }
    return;
  }
  if (command === "wait") {
    const result = await waitOnce(
      requiredFlag("--run-id"),
      integerFlag("--timeout-seconds", 20, 0, 25),
    );
    print(result);
    return;
  }
  if (command === "watch") {
    await watch(requiredFlag("--run-id"));
    return;
  }
  if (command === "list") {
    const status = readFlag("--status")?.trim();
    const result = await gatewayCall(
      "chatgpt.mcp.list",
      {
        limit: integerFlag("--limit", 20, 1, 100),
        ...(status ? { status } : {}),
      },
      { timeoutMs: 20_000 },
    );
    print(result);
    return;
  }
  throw new Error(`Comando desconocido: ${command}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  print({ ok: false, error: message });
  process.exitCode = 1;
});
