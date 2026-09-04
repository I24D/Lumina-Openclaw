import { describe, expect, it } from "vitest";
import {
  isVoiceOwnedMessage,
  parseClaudeCodeRecord,
  parseCodexRecord,
  parseOpenClawTranscriptEvent,
  textFromContent,
} from "./parsers.js";

describe("read-aloud transcript parsers", () => {
  it("joins only text blocks of an assistant message", () => {
    expect(
      textFromContent([
        { type: "thinking", thinking: "private" },
        { type: "text", text: "Hola" },
        { type: "tool_use", name: "Bash" },
        { type: "text", text: " mundo" },
      ]),
    ).toBe("Hola mundo");
  });

  it("reads a Codex final answer and ignores its commentary", () => {
    const final = {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "Listo." }],
      },
    };
    const commentary = {
      ...final,
      payload: { ...final.payload, phase: "commentary" },
    };
    expect(parseCodexRecord(final)).toBe("Listo.");
    expect(parseCodexRecord(commentary)).toBe("");
  });

  it("reads a Claude Code end_turn answer and ignores tool turns", () => {
    const answer = {
      type: "assistant",
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Hecho." }],
      },
    };
    const toolTurn = {
      type: "assistant",
      message: {
        role: "assistant",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", name: "Read" }],
      },
    };
    expect(parseClaudeCodeRecord(answer)).toBe("Hecho.");
    expect(parseClaudeCodeRecord(toolTurn)).toBe("");
  });

  it("reads a completed OpenClaw chat answer", () => {
    expect(
      parseOpenClawTranscriptEvent(
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            api: "ollama",
            stopReason: "stop",
            content: [{ type: "text", text: "Respuesta del chat." }],
          },
        }),
      ),
    ).toBe("Respuesta del chat.");
  });

  it("never reads back what the realtime voice itself said", () => {
    // The "Lumina Start talk" session holds both the voice and the typed chat, so its
    // own answers land in the same transcript. Reading them would loop the voice.
    const spoken = {
      type: "message",
      id: "voice:050c6a54:12",
      message: {
        role: "assistant",
        api: "realtime",
        model: "realtime-voice",
        stopReason: "stop",
        provenance: { kind: "realtime_voice", sourceChannel: "talk" },
        content: [{ type: "text", text: "Lo que acabo de decir." }],
      },
    };
    expect(parseOpenClawTranscriptEvent(JSON.stringify(spoken))).toBe("");
    expect(isVoiceOwnedMessage(spoken.message)).toBe(true);
  });

  it("never reads back the agent consult the voice delegated", () => {
    // A voice turn that needs the agent runs a chat run keyed `talk-<callId>-<uuid>`,
    // and the relay speaks its answer. Reading it again would duplicate every reply.
    const delegated = {
      type: "message",
      message: {
        role: "assistant",
        api: "google-generative-ai",
        stopReason: "stop",
        idempotencyKey: "talk-fc_7462246158702151127-60214ba2-a77c-4fa1-abe2-c83e3c50f7ae",
        content: [{ type: "text", text: "Respuesta que la voz ya dijo." }],
      },
    };
    expect(parseOpenClawTranscriptEvent(JSON.stringify(delegated))).toBe("");
    expect(isVoiceOwnedMessage(delegated.message)).toBe(true);
  });

  it("reads what the user typed into the Start Talk session", () => {
    // Same session, but a real chat run: this is the case the user reported.
    const typed = {
      type: "message",
      message: {
        role: "assistant",
        api: "google-generative-ai",
        provider: "google",
        model: "gemini-3.6-flash",
        stopReason: "stop",
        __openclaw: { runId: "bd41c9c1-c901-42b7-90f7-82ecaf6a49fa" },
        content: [{ type: "text", text: "¡Hola Dal! ¿En qué te ayudo?" }],
      },
    };
    expect(parseOpenClawTranscriptEvent(JSON.stringify(typed))).toBe(
      "¡Hola Dal! ¿En qué te ayudo?",
    );
    expect(isVoiceOwnedMessage(typed.message)).toBe(false);
  });

  it("ignores unfinished turns and malformed records", () => {
    expect(
      parseOpenClawTranscriptEvent(
        JSON.stringify({
          type: "message",
          message: { role: "assistant", stopReason: "tool_use", content: [] },
        }),
      ),
    ).toBe("");
    expect(parseOpenClawTranscriptEvent("{not json")).toBe("");
    expect(parseClaudeCodeRecord(undefined)).toBe("");
    expect(parseCodexRecord("nope")).toBe("");
  });
});
