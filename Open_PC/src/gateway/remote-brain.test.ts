import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { onAgentEvent } from "../infra/agent-events.js";
import {
  buildRemoteBrainAssistantContent,
  type GatewayRemoteBrainLoopParams,
  runGatewayRemoteBrainLoop,
} from "./remote-brain.js";

const TEST_CFG = {} as OpenClawConfig;

function createLoopParams(
  overrides: Partial<GatewayRemoteBrainLoopParams> = {},
): GatewayRemoteBrainLoopParams {
  return {
    cfg: TEST_CFG,
    env: {
      ...process.env,
      OPENCLAW_REMOTE_BRAIN_ENABLED: "true",
      OPENCLAW_REMOTE_BRAIN_URL: "https://lumina.example.com/api/openclaw/brain/turn",
      OPENCLAW_REMOTE_BRAIN_MAX_TURNS: "4",
    },
    sessionKey: "agent:main:main",
    requestId: "req_1",
    messageChannel: "openclaw-chat",
    messageProvider: "openclaw-chat",
    senderIsOwner: true,
    messages: [{ role: "user", content: "Check the weather." }],
    ...overrides,
  };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runGatewayRemoteBrainLoop", () => {
  it("executes local runtime tools before requesting a final answer", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          reply: "",
          toolCalls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "weather_lookup",
                arguments: JSON.stringify({ city: "New York" }),
              },
            },
          ],
          finishReason: "tool_calls",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          reply: "It is 72F and sunny in New York.",
          toolCalls: [],
          finishReason: "stop",
        }),
      );

    const execute = vi.fn(async () => ({
      content: [{ type: "text", text: "72F and sunny" }],
      details: { city: "New York" },
    }));
    const toolEvents: Array<Record<string, unknown>> = [];
    const unsubscribe = onAgentEvent((event) => {
      if (event.runId === "req_1" && event.stream === "tool") {
        toolEvents.push(event.data);
      }
    });

    let result: Awaited<ReturnType<typeof runGatewayRemoteBrainLoop>> | undefined;
    try {
      result = await runGatewayRemoteBrainLoop(
        createLoopParams({
          deps: {
            fetchImpl,
            localTools: [
              {
                definition: {
                  name: "weather_lookup",
                  description: "Get weather for a city.",
                  parameters: {
                    type: "object",
                    properties: {
                      city: { type: "string" },
                    },
                    required: ["city"],
                  },
                },
                execute,
              },
            ],
            runtimeVersion: "2026.4.4",
          },
        }),
      );
    } finally {
      unsubscribe();
    }

    if (!result?.enabled || !result.ok) {
      throw new Error("expected successful remote brain result");
    }
    expect(result.reply).toContain("72F");
    expect(result.executedToolCalls).toBe(1);
    expect(execute).toHaveBeenCalledWith("call_1", { city: "New York" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(toolEvents).toMatchObject([
      { phase: "start", name: "weather_lookup", toolCallId: "call_1" },
      {
        phase: "result",
        name: "weather_lookup",
        toolCallId: "call_1",
        isError: false,
        result: { content: [{ type: "text", text: "Completed." }] },
      },
    ]);

    const secondBody = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body)) as {
      messages: Array<{ role: string; tool_call_id?: string; content: string }>;
    };
    expect(secondBody.messages.at(-1)).toMatchObject({
      role: "tool",
      tool_call_id: "call_1",
    });
    expect(secondBody.messages.at(-1)?.content ?? "").toContain("72F");
  });

  it("returns client tool calls to the caller without executing local tools", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        reply: "Need weather before answering.",
        toolCalls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "get_weather",
              arguments: JSON.stringify({ city: "Miami" }),
            },
          },
        ],
        finishReason: "tool_calls",
      }),
    );

    const result = await runGatewayRemoteBrainLoop(
      createLoopParams({
        clientTools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Client-hosted weather tool.",
              parameters: {
                type: "object",
                properties: {
                  city: { type: "string" },
                },
                required: ["city"],
              },
            },
          },
        ],
        deps: {
          fetchImpl,
          localTools: [],
          runtimeVersion: "2026.4.4",
        },
      }),
    );

    if (!result.enabled || !result.ok) {
      throw new Error("expected successful remote brain tool-call result");
    }
    expect(result.finishReason).toBe("tool_calls");
    expect(result.pendingToolCalls).toHaveLength(1);
    expect(result.executedToolCalls).toBe(0);
    expect(result.pendingToolCalls?.[0]?.function.name).toBe("get_weather");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("preserves Lumina speech text and multimodal artifacts", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        reply: "Ciudad futurista",
        speechText: "Listo, generé la imagen y la dejé visible en el chat.",
        attachments: [
          {
            type: "image",
            url: "https://example.com/city.png",
            caption: "Ciudad futurista",
            mimeType: "image/png",
          },
        ],
        traceId: "trace-image-1",
        toolCalls: [],
        finishReason: "stop",
      }),
    );

    const result = await runGatewayRemoteBrainLoop(
      createLoopParams({
        deps: { fetchImpl, localTools: [] },
      }),
    );

    if (!result.enabled || !result.ok) {
      throw new Error("expected successful multimodal result");
    }
    expect(result.speechText).toMatch(/imagen/i);
    expect(result.attachments).toHaveLength(1);
    expect(result.traceId).toBe("trace-image-1");
    expect(buildRemoteBrainAssistantContent(result.reply, result.attachments)).toEqual([
      { type: "text", text: "Ciudad futurista" },
      {
        type: "image",
        url: "https://example.com/city.png",
        openUrl: "https://example.com/city.png",
        alt: "Ciudad futurista",
        mimeType: "image/png",
      },
    ]);
  });
});
