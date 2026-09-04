import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createTranscriptWatcher, resolveOpenClawAgentIds } from "./transcript-watcher.js";
import type { ReadAloudItem } from "./types.js";

function claudeAnswer(text: string): string {
  return `${JSON.stringify({
    type: "assistant",
    message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] },
  })}\n`;
}

function codexAnswer(text: string): string {
  return `${JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text }],
    },
  })}\n`;
}

function openClawAnswer(text: string, realtimeVoice = false): string {
  return JSON.stringify({
    type: "message",
    message: {
      role: "assistant",
      api: realtimeVoice ? "realtime" : "ollama",
      stopReason: "stop",
      ...(realtimeVoice ? { provenance: { kind: "realtime_voice", sourceChannel: "talk" } } : {}),
      content: [{ type: "text", text }],
    },
  });
}

let home = "";
let databasePath = "";
let claudePath = "";
let codexPath = "";
let seq = 0;

function setupHome(): void {
  home = mkdtempSync(join(tmpdir(), "read-aloud-"));
  const claudeDir = join(home, ".claude", "projects", "demo");
  const codexDir = join(home, ".codex", "sessions", "2026", "08");
  const agentDir = join(home, ".openclaw", "agents", "main", "agent");
  for (const dir of [claudeDir, codexDir, agentDir]) {
    mkdirSync(dir, { recursive: true });
  }
  claudePath = join(claudeDir, "session.jsonl");
  codexPath = join(codexDir, "rollout.jsonl");
  databasePath = join(agentDir, "openclaw-agent.sqlite");
  writeFileSync(claudePath, claudeAnswer("respuesta vieja de Claude"), "utf8");
  writeFileSync(codexPath, codexAnswer("respuesta vieja de Codex"), "utf8");
  const database = new DatabaseSync(databasePath);
  database.exec(
    "CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT, created_at INTEGER)",
  );
  database.close();
  appendOpenClawEvent(openClawAnswer("respuesta vieja de OpenClaw"));
}

function appendOpenClawEvent(eventJson: string, sessionId = "session-1"): void {
  const database = new DatabaseSync(databasePath);
  try {
    seq += 1;
    database
      .prepare(
        "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(sessionId, seq, eventJson, Date.now());
  } finally {
    database.close();
  }
}

afterEach(() => {
  seq = 0;
});

describe("read-aloud transcript watcher", () => {
  it("baselines existing transcripts and then reads only new answers", () => {
    setupHome();
    const spoken: ReadAloudItem[] = [];
    const watcher = createTranscriptWatcher({ home, emit: (item) => spoken.push(item) });

    watcher.poll();
    // Nothing is replayed on startup: yesterday's answers stay unspoken.
    expect(spoken).toEqual([]);

    appendFileSync(claudePath, claudeAnswer("Claude terminó la tarea"), "utf8");
    appendFileSync(codexPath, codexAnswer("Codex terminó la tarea"), "utf8");
    appendOpenClawEvent(openClawAnswer("El chat de OpenClaw respondió"));
    watcher.poll();

    expect(spoken.map((item) => [item.source, item.text])).toEqual([
      ["claude-code", "Claude terminó la tarea"],
      ["codex", "Codex terminó la tarea"],
      ["openclaw", "El chat de OpenClaw respondió"],
    ]);
  });

  it("skips what the realtime voice itself said in the shared chat session", () => {
    setupHome();
    const spoken: ReadAloudItem[] = [];
    const watcher = createTranscriptWatcher({ home, emit: (item) => spoken.push(item) });
    watcher.poll();

    appendOpenClawEvent(openClawAnswer("esto lo dijo la voz", true));
    appendOpenClawEvent(openClawAnswer("esto lo escribió el chat"));
    watcher.poll();

    expect(spoken.map((item) => item.text)).toEqual(["esto lo escribió el chat"]);
  });

  it("reads only the main chat agent, not the WhatsApp or Telegram bots", () => {
    setupHome();
    // The messaging agents keep transcripts in the same folder; narrating every
    // reply the bot sends to a contact is not what read-aloud is for.
    const whatsappDir = join(home, ".openclaw", "agents", "whatsapp", "agent");
    mkdirSync(whatsappDir, { recursive: true });
    const whatsappDatabase = new DatabaseSync(join(whatsappDir, "openclaw-agent.sqlite"));
    whatsappDatabase.exec(
      "CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT, created_at INTEGER)",
    );
    whatsappDatabase
      .prepare(
        "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)",
      )
      .run("wa", 1, openClawAnswer("respuesta a un contacto de WhatsApp"), Date.now());
    whatsappDatabase.close();

    const spoken: ReadAloudItem[] = [];
    const watcher = createTranscriptWatcher({ home, emit: (item) => spoken.push(item) });
    watcher.poll();
    appendOpenClawEvent(openClawAnswer("respuesta del chat principal"));
    watcher.poll();

    expect(spoken.map((item) => item.text)).toEqual(["respuesta del chat principal"]);
    expect(resolveOpenClawAgentIds(undefined)).toEqual(["main"]);
    expect(resolveOpenClawAgentIds("main, design")).toEqual(["main", "design"]);
  });

  it("reads the chat and the Start Talk session but not Telegram or cron runs", () => {
    setupHome();
    const database = new DatabaseSync(databasePath);
    database.exec(
      "CREATE TABLE session_windows (session_id TEXT, session_key TEXT);" +
        "CREATE TABLE session_conversations (session_id TEXT, conversation_id TEXT);" +
        "CREATE TABLE conversations (conversation_id TEXT, channel TEXT)",
    );
    const sessions: [string, string][] = [
      ["chat", "agent:main:main"],
      ["talk", "agent:main:talk:telegram:direct:7054043436"],
      ["telegram", "agent:main:telegram:direct:7054043436"],
      ["cron", "agent:main:cron:be03db89-9786-4ebe-bee6-3a0a86b34853"],
    ];
    for (const [sessionId, sessionKey] of sessions) {
      database.prepare("INSERT INTO session_windows VALUES (?, ?)").run(sessionId, sessionKey);
    }
    // Only the Telegram session is bound to an external conversation.
    database.prepare("INSERT INTO session_conversations VALUES (?, ?)").run("telegram", "conv_1");
    database.prepare("INSERT INTO conversations VALUES (?, ?)").run("conv_1", "telegram");
    database.close();

    const spoken: ReadAloudItem[] = [];
    const watcher = createTranscriptWatcher({ home, emit: (item) => spoken.push(item) });
    watcher.poll();

    for (const [sessionId] of sessions) {
      appendOpenClawEvent(openClawAnswer(`respuesta de ${sessionId}`), sessionId);
    }
    watcher.poll();

    expect(spoken.map((item) => item.text)).toEqual(["respuesta de chat", "respuesta de talk"]);
  });

  it("ignores a half-written line until its newline arrives", () => {
    setupHome();
    const spoken: ReadAloudItem[] = [];
    const watcher = createTranscriptWatcher({ home, emit: (item) => spoken.push(item) });
    watcher.poll();

    const complete = claudeAnswer("mensaje completo");
    appendFileSync(claudePath, complete.slice(0, 40), "utf8");
    watcher.poll();
    expect(spoken).toEqual([]);

    appendFileSync(claudePath, complete.slice(40), "utf8");
    watcher.poll();
    expect(spoken.map((item) => item.text)).toEqual(["mensaje completo"]);
  });
});
