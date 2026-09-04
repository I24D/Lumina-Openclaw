// Tails the transcripts of Claude Code, Codex and the OpenClaw chat.
//
// This replaces the old hook-based relay (a Claude Code `Stop` hook and a Codex
// `notify` entry that both shelled out to a Python script). Hooks broke silently the
// moment their script moved; tailing the transcripts the tools already write cannot.
//
// Nothing is persisted: on start every source is baselined at its current end, so a
// gateway restart never replays yesterday's answers.
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  parseClaudeCodeRecord,
  parseCodexRecord,
  parseOpenClawTranscriptEvent,
  shouldReadTranscriptSession,
} from "./parsers.js";
import { normalizeReadAloudText, type ReadAloudEmit, type ReadAloudSource } from "./types.js";

const log = createSubsystemLogger("lumina/read-aloud");

const MAX_TRACKED_FILES = 120;
const RECENT_FILE_MS = 7 * 24 * 60 * 60_000;
const DISCOVERY_INTERVAL_MS = 10_000;
const MAX_DB_ROWS_PER_POLL = 500;

type TranscriptFile = { path: string; size: number; mtimeMs: number };

/** Polls every configured transcript source once per call. */
export type TranscriptWatcher = {
  poll(): void;
};

function safeReadDirectory(directory: string) {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    // Missing or unreadable directories simply contribute no transcripts.
    return [];
  }
}

function walkFiles(directory: string, matches: (path: string) => boolean): string[] {
  const found: string[] = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      continue;
    }
    for (const entry of safeReadDirectory(current)) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile() && matches(path)) {
        found.push(path);
      }
    }
  }
  return found;
}

function recentJsonlFiles(directory: string, nowMs: number): TranscriptFile[] {
  const cutoff = nowMs - RECENT_FILE_MS;
  return walkFiles(directory, (path) => path.toLowerCase().endsWith(".jsonl"))
    .map((path) => {
      try {
        const stat = statSync(path);
        return { path, size: stat.size, mtimeMs: stat.mtimeMs };
      } catch {
        return undefined;
      }
    })
    .filter((file): file is TranscriptFile => file !== undefined && file.mtimeMs >= cutoff)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, MAX_TRACKED_FILES);
}

function readAppendedLines(path: string, offset: number): { lines: string[]; offset: number } {
  const size = statSync(path).size;
  // A shrunken file was rotated or rewritten; restart from its new end rather than
  // replaying it, so a rotation never floods the voice with old answers.
  const start = size < offset ? size : offset;
  if (size === start) {
    return { lines: [], offset: start };
  }
  const buffer = Buffer.alloc(size - start);
  const descriptor = openSync(path, "r");
  try {
    readSync(descriptor, buffer, 0, buffer.length, start);
  } finally {
    closeSync(descriptor);
  }
  const lastNewline = buffer.lastIndexOf(10);
  if (lastNewline < 0) {
    // Only a partial line is available; wait for the writer to finish it.
    return { lines: [], offset: start };
  }
  return {
    lines: buffer
      .subarray(0, lastNewline + 1)
      .toString("utf8")
      .split(/\r?\n/u),
    offset: start + lastNewline + 1,
  };
}

/**
 * Which OpenClaw agents count as "the chat".
 *
 * Only the agent that owns the main chat is read aloud. The WhatsApp and Telegram
 * agents keep their own transcripts in the same folder, and narrating every reply
 * the bot sends to a contact is not what the user asked for.
 */
export function resolveOpenClawAgentIds(raw: string | undefined): string[] {
  const configured = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return configured.length > 0 ? configured : ["main"];
}

function openClawDatabases(home: string, agentIds: readonly string[]): string[] {
  return agentIds
    .map((agentId) => join(home, ".openclaw", "agents", agentId, "agent", "openclaw-agent.sqlite"))
    .filter((path) => existsSync(path));
}

type TranscriptRow = {
  rowid: number;
  sessionId: string;
  seq: number;
  eventJson: string;
  sessionKey?: string | null;
  channel?: string | null;
};

/**
 * Reads new transcript rows along with the routing facts that decide whether the
 * session is a chat the user is looking at.
 *
 * Older stores predate `session_windows`; when the enriched query cannot run, the
 * plain one still returns the rows and the session filter simply has less to go on.
 */
function readTranscriptRows(database: DatabaseSync, afterRowId: number): TranscriptRow[] {
  const enriched =
    "SELECT t.rowid AS rowid, t.session_id AS sessionId, t.seq AS seq, t.event_json AS eventJson," +
    " (SELECT w.session_key FROM session_windows w WHERE w.session_id = t.session_id LIMIT 1) AS sessionKey," +
    " (SELECT c.channel FROM session_conversations sc JOIN conversations c" +
    "    ON c.conversation_id = sc.conversation_id WHERE sc.session_id = t.session_id LIMIT 1) AS channel" +
    " FROM transcript_events t WHERE t.rowid > ? ORDER BY t.rowid LIMIT ?";
  const plain =
    "SELECT rowid AS rowid, session_id AS sessionId, seq AS seq, event_json AS eventJson" +
    " FROM transcript_events WHERE rowid > ? ORDER BY rowid LIMIT ?";
  for (const sql of [enriched, plain]) {
    try {
      return database
        .prepare(sql)
        .all(afterRowId, MAX_DB_ROWS_PER_POLL) as unknown as TranscriptRow[];
    } catch (err: unknown) {
      if (sql === plain) {
        throw err;
      }
    }
  }
  return [];
}

function maxTranscriptRowId(path: string): number {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const row = database
      .prepare("SELECT COALESCE(MAX(rowid), 0) AS value FROM transcript_events")
      .get();
    return Number((row as { value?: unknown } | undefined)?.value ?? 0);
  } finally {
    database.close();
  }
}

/** Creates a watcher over the three chat transcripts Start Talk should read. */
export function createTranscriptWatcher(params: {
  emit: ReadAloudEmit;
  home?: string;
  now?: () => number;
  openClawAgentIds?: readonly string[];
}): TranscriptWatcher {
  const home = params.home ?? homedir();
  const now = params.now ?? (() => Date.now());
  const openClawAgentIds =
    params.openClawAgentIds ??
    resolveOpenClawAgentIds(process.env.LUMINA_READ_ALOUD_OPENCLAW_AGENTS);
  const fileOffsets = new Map<string, number>();
  const databaseRowIds = new Map<string, number>();
  let files: { source: ReadAloudSource; file: TranscriptFile }[] = [];
  let databases: string[] = [];
  let lastDiscoveryAtMs = 0;

  const discover = (nowMs: number): void => {
    files = [
      ...recentJsonlFiles(join(home, ".claude", "projects"), nowMs).map((file) => ({
        source: "claude-code" as const,
        file,
      })),
      ...recentJsonlFiles(join(home, ".codex", "sessions"), nowMs).map((file) => ({
        source: "codex" as const,
        file,
      })),
    ];
    databases = openClawDatabases(home, openClawAgentIds);
    lastDiscoveryAtMs = nowMs;
  };

  const parseFor = (source: ReadAloudSource): ((record: unknown) => string) =>
    source === "codex" ? parseCodexRecord : parseClaudeCodeRecord;

  const pollFile = (source: ReadAloudSource, file: TranscriptFile): void => {
    const known = fileOffsets.get(file.path);
    if (known === undefined) {
      // First sight of a transcript is a baseline, never a replay.
      fileOffsets.set(file.path, file.size);
      return;
    }
    const result = readAppendedLines(file.path, known);
    fileOffsets.set(file.path, result.offset);
    const parse = parseFor(source);
    for (const [index, line] of result.lines.entries()) {
      if (!line.trim()) {
        continue;
      }
      let text = "";
      try {
        text = parse(JSON.parse(line));
      } catch {
        // Partially written or migrated records are skipped, not fatal.
        continue;
      }
      const speakable = normalizeReadAloudText(text);
      if (speakable) {
        params.emit({
          source,
          id: `${source}:${basename(file.path)}:${result.offset}:${index}`,
          text: speakable,
        });
      }
    }
  };

  const pollDatabase = (path: string): void => {
    const known = databaseRowIds.get(path);
    if (known === undefined) {
      databaseRowIds.set(path, maxTranscriptRowId(path));
      return;
    }
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      for (const row of readTranscriptRows(database, known)) {
        databaseRowIds.set(path, Math.max(databaseRowIds.get(path) ?? 0, Number(row.rowid)));
        if (!shouldReadTranscriptSession({ sessionKey: row.sessionKey, channel: row.channel })) {
          continue;
        }
        const speakable = normalizeReadAloudText(parseOpenClawTranscriptEvent(row.eventJson));
        if (speakable) {
          params.emit({
            source: "openclaw",
            id: `openclaw:${row.sessionId}:${row.seq}`,
            text: speakable,
          });
        }
      }
    } finally {
      database.close();
    }
  };

  return {
    poll(): void {
      const nowMs = now();
      if (nowMs - lastDiscoveryAtMs > DISCOVERY_INTERVAL_MS) {
        discover(nowMs);
      }
      for (const { source, file } of files) {
        try {
          pollFile(source, file);
        } catch (err: unknown) {
          log.debug(`read-aloud file poll failed path=${file.path}: ${formatErrorMessage(err)}`);
        }
      }
      for (const path of databases) {
        try {
          pollDatabase(path);
        } catch (err: unknown) {
          log.debug(`read-aloud database poll failed path=${path}: ${formatErrorMessage(err)}`);
        }
      }
    },
  };
}
