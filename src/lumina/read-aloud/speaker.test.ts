import { afterEach, describe, expect, it } from "vitest";
import { relaySessions, type RelaySession } from "../../gateway/talk-realtime-relay-state.js";
import { hasLiveTalkSession, speakToLiveTalkSessions } from "./speaker.js";

function registerSession(params: {
  id: string;
  connected: boolean;
  spoken?: string[];
  bridgeThrows?: boolean;
  speaking?: boolean;
}): void {
  const session = {
    id: params.id,
    harness: { isOutputPlaybackWindowActive: () => params.speaking === true },
    bridge: {
      get bridge() {
        if (params.bridgeThrows) {
          throw new Error("Realtime voice bridge is not ready");
        }
        return { isConnected: () => params.connected };
      },
      sendUserMessage: (text: string) => params.spoken?.push(text),
    },
  } as unknown as RelaySession;
  relaySessions.set(params.id, session);
}

afterEach(() => {
  relaySessions.clear();
});

describe("read-aloud speaker", () => {
  it("sends the exact-speech protocol message to a live session", () => {
    const spoken: string[] = [];
    registerSession({ id: "live", connected: true, spoken });

    expect(hasLiveTalkSession()).toBe(true);
    expect(speakToLiveTalkSessions("Claude Code: tarea terminada.")).toBe(1);
    expect(spoken).toHaveLength(1);
    // The exact-speech contract is what keeps the voice from summarizing the answer.
    expect(spoken[0]).toContain("Speak this exact OpenClaw answer");
    expect(spoken[0]).toContain(JSON.stringify("Claude Code: tarea terminada."));
  });

  it("reports no live session when the voice is off", () => {
    const spoken: string[] = [];
    registerSession({ id: "closed", connected: false, spoken });

    expect(hasLiveTalkSession()).toBe(false);
    expect(speakToLiveTalkSessions("nadie escucha")).toBe(0);
    expect(spoken).toEqual([]);
  });

  it("waits instead of cutting the voice off mid-answer", () => {
    const spoken: string[] = [];
    registerSession({ id: "busy", connected: true, spoken, speaking: true });

    // Still "live", but nothing is delivered: the caller keeps the item queued.
    expect(hasLiveTalkSession()).toBe(true);
    expect(speakToLiveTalkSessions("una notificación")).toBe(0);
    expect(spoken).toEqual([]);
  });

  it("skips a session whose provider bridge is not adopted yet", () => {
    const spoken: string[] = [];
    registerSession({ id: "starting", connected: true, bridgeThrows: true });
    registerSession({ id: "live", connected: true, spoken });

    expect(speakToLiveTalkSessions("hola")).toBe(1);
    expect(spoken).toHaveLength(1);
  });
});
