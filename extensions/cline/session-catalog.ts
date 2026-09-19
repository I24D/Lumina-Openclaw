import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  SessionCatalogSession,
  SessionCatalogTranscriptItem,
  SessionsCatalogReadResult,
} from "openclaw/plugin-sdk/session-catalog";
import { sessionCatalogPaging } from "openclaw/plugin-sdk/session-catalog";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export const CLINE_LOCAL_HOST_ID = "gateway:local";
export const CLINE_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/u;
const MAX_SESSIONS = 10_000;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_MESSAGES_BYTES = 32 * 1024 * 1024;

type ClineMetadata = {
  sessionId: string;
  name?: string;
  cwd?: string;
  provider?: string;
  model?: string;
  status: string;
  createdAt?: number;
  updatedAt: number;
  source?: string;
};

function boundedString(value: unknown, max = 500): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clineDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.CLINE_DATA_DIR?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  const config = env.CLINE_DIR?.trim();
  return path.join(config ? path.resolve(config) : path.join(os.homedir(), ".cline"), "data");
}

export function clineUsesProcessHomeFallback(env: NodeJS.ProcessEnv = process.env): boolean {
  return !env.CLINE_DATA_DIR?.trim() && !env.CLINE_DIR?.trim();
}

function sessionsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(clineDataDir(env), "sessions");
}

function sessionDir(root: string, threadId: string): string {
  if (!CLINE_SESSION_ID_PATTERN.test(threadId)) {
    throw new Error("Cline threadId is invalid");
  }
  return path.join(root, threadId);
}

async function readJsonFile(filePath: string, maxBytes: number): Promise<unknown> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size > maxBytes) {
    throw new Error("Cline session file is invalid");
  }
  return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
}

async function readMetadata(root: string, threadId: string): Promise<ClineMetadata> {
  const directory = sessionDir(root, threadId);
  const directoryStat = await fs.lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("Cline session is unavailable");
  }
  const filePath = path.join(directory, `${threadId}.json`);
  const [raw, stat] = await Promise.all([
    readJsonFile(filePath, MAX_METADATA_BYTES),
    fs.stat(filePath),
  ]);
  if (!isRecord(raw) || raw.session_id !== threadId) {
    throw new Error("Cline session metadata is invalid");
  }
  const metadata = isRecord(raw.metadata) ? raw.metadata : undefined;
  const createdAt = timestampMs(raw.started_at);
  const updatedAt = timestampMs(raw.ended_at) ?? stat.mtimeMs;
  return {
    sessionId: threadId,
    name: boundedString(metadata?.title) ?? boundedString(raw.prompt),
    cwd: boundedString(raw.workspace_root, 4096) ?? boundedString(raw.cwd, 4096),
    provider: boundedString(raw.provider, 200),
    model: boundedString(raw.model, 300) ?? boundedString(metadata?.modelId, 300),
    status: boundedString(raw.status, 100) ?? "stored",
    ...(createdAt !== undefined ? { createdAt } : {}),
    updatedAt,
    source: boundedString(raw.source, 100),
  };
}

function cursorOffset(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  return sessionCatalogPaging.decodeCursor(value);
}

export async function listLocalClineSessionPage(params: {
  searchTerm?: string;
  limit?: number;
  cursor?: string;
}): Promise<{ sessions: SessionCatalogSession[]; nextCursor?: string }> {
  const root = sessionsRoot();
  let entries: Awaited<ReturnType<typeof fs.readdir>>;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return { sessions: [] };
  }
  const records = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && CLINE_SESSION_ID_PATTERN.test(entry.name))
      .slice(0, MAX_SESSIONS)
      .map((entry) => readMetadata(root, entry.name).catch(() => undefined)),
  );
  const search = params.searchTerm?.trim().toLowerCase();
  const sessions = records
    .filter((record): record is ClineMetadata => Boolean(record))
    .filter(
      (record) =>
        !search ||
        `${record.name ?? ""}\n${record.cwd ?? ""}\n${record.provider ?? ""}\n${record.model ?? ""}`
          .toLowerCase()
          .includes(search),
    )
    .toSorted(
      (left, right) =>
        right.updatedAt - left.updatedAt || left.sessionId.localeCompare(right.sessionId),
    );
  const offset = cursorOffset(params.cursor);
  const limit = sessionCatalogPaging.boundedLimit(params.limit);
  const page = sessions.slice(offset, offset + limit);
  return {
    sessions: page.map((record) => ({
      threadId: record.sessionId,
      ...(record.name ? { name: record.name } : {}),
      ...(record.cwd ? { cwd: record.cwd } : {}),
      status: record.status,
      ...(record.createdAt !== undefined ? { createdAt: record.createdAt } : {}),
      updatedAt: record.updatedAt,
      recencyAt: record.updatedAt,
      source: record.source === "vscode" ? "cline-vscode" : "cline-cli",
      ...(record.provider ? { modelProvider: record.provider } : {}),
      ...(record.model ? { cliVersion: record.model } : {}),
      archived: false,
      canContinue: true,
      canArchive: false,
      canOpenTerminal: true,
    })),
    ...(offset + page.length < sessions.length
      ? { nextCursor: sessionCatalogPaging.encodeCursor(offset + page.length) }
      : {}),
  };
}

export async function requireLocalClineSession(threadId: string): Promise<SessionCatalogSession> {
  const record = await readMetadata(sessionsRoot(), threadId).catch(() => undefined);
  if (!record) {
    throw new Error("Cline session is unavailable");
  }
  return {
    threadId: record.sessionId,
    ...(record.name ? { name: record.name } : {}),
    ...(record.cwd ? { cwd: record.cwd } : {}),
    status: record.status,
    ...(record.createdAt !== undefined ? { createdAt: record.createdAt } : {}),
    updatedAt: record.updatedAt,
    recencyAt: record.updatedAt,
    source: record.source === "vscode" ? "cline-vscode" : "cline-cli",
    archived: false,
    canContinue: true,
    canArchive: false,
    canOpenTerminal: true,
  };
}

function blockText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const parts = value.map(blockText).filter((part): part is string => Boolean(part));
    return parts.length ? parts.join("\n") : undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  return boundedString(value.text, 200_000) ?? boundedString(value.content, 200_000);
}

export async function readLocalClineTranscriptPage(params: {
  threadId: string;
  limit?: number;
  cursor?: string;
}): Promise<SessionsCatalogReadResult> {
  await requireLocalClineSession(params.threadId);
  const root = sessionsRoot();
  const raw = await readJsonFile(
    path.join(sessionDir(root, params.threadId), `${params.threadId}.messages.json`),
    MAX_MESSAGES_BYTES,
  );
  const messages = isRecord(raw) && Array.isArray(raw.messages) ? raw.messages : [];
  const items: SessionCatalogTranscriptItem[] = [];
  for (const [messageIndex, message] of messages.entries()) {
    if (!isRecord(message) || !Array.isArray(message.content)) {
      continue;
    }
    const role = message.role === "user" ? "user" : "assistant";
    const timestamp = timestampMs(message.ts);
    for (const [blockIndex, block] of message.content.entries()) {
      if (!isRecord(block) || typeof block.type !== "string") {
        continue;
      }
      let type: SessionCatalogTranscriptItem["type"] = "other";
      let text: string | undefined;
      if (block.type === "text") {
        type = role === "user" ? "userMessage" : "agentMessage";
        text = blockText(block.text);
      } else if (block.type === "thinking") {
        type = "reasoning";
        text = blockText(block.thinking);
      } else if (block.type === "tool_use") {
        type = "toolCall";
        const input = block.input === undefined ? "" : `\n${JSON.stringify(block.input)}`;
        text = `${boundedString(block.name, 300) ?? "tool"}${input}`;
      } else if (block.type === "tool_result") {
        type = "toolResult";
        text = blockText(block.content) ?? blockText(block.output);
      }
      if (!text) {
        continue;
      }
      items.push({
        id: `${boundedString(message.id, 300) ?? messageIndex}:${blockIndex}`,
        type,
        text,
        ...(timestamp !== undefined ? { timestamp: new Date(timestamp).toISOString() } : {}),
      });
    }
  }
  const offset = cursorOffset(params.cursor);
  const { items: page, nextCursor } = sessionCatalogPaging.boundTranscriptPage(
    items,
    sessionCatalogPaging.boundedLimit(params.limit),
    offset,
  );
  return {
    hostId: CLINE_LOCAL_HOST_ID,
    label: "Local Cline",
    threadId: params.threadId,
    items: page,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}
