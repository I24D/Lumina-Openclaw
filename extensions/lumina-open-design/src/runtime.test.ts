import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { LuminaOpenDesignSettings } from "./config.js";
import { LuminaOpenDesignRuntime } from "./runtime.js";

const settings: LuminaOpenDesignSettings = {
  daemonUrl: "http://127.0.0.1:7456",
  executablePath: "C:\\Open Design\\Open Design.exe",
  cliPath: "C:\\Open Design\\daemon-cli.mjs",
  resourceRoot: "C:\\Open Design\\resources",
  dataDir: "C:\\Open Design\\data",
  desktopNamespace: "release-stable-win",
  autoStart: true,
  sessionKey: "agent:main:main",
  startupTimeoutMs: 45_000,
};

describe("LuminaOpenDesignRuntime gateway integration", () => {
  it("configures Studio to use OpenClaw as its model endpoint", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lumina-open-design-"));
    const runtime = new LuminaOpenDesignRuntime(
      { ...settings, dataDir },
      { info: vi.fn(), warn: vi.fn() },
      {
        apiBaseUrl: "http://127.0.0.1:18789/v1",
        openAiProxyBaseUrl: "http://127.0.0.1:18789/plugins/lumina-open-design/openai/v1",
        bearerToken: "gateway-test-token",
        nodeBinPath: "C:\\tools\\node.exe",
        opencodeBinPath: "C:\\tools\\opencode.exe",
      },
    );
    const request = vi
      .spyOn(runtime, "request")
      .mockResolvedValueOnce(
        Response.json({
          config: {
            agentId: "amr",
            agentModels: { amr: { model: "glm-5.2" } },
            customInstructions: "Keep the existing design rules.",
          },
        }),
      )
      .mockResolvedValueOnce(Response.json({ config: {} }))
      .mockResolvedValueOnce(Response.json({ ok: true, detail: "connected" }));

    try {
      await expect(runtime.syncGatewayAgent()).resolves.toMatchObject({
        configured: true,
        connected: true,
        agentId: "opencode",
        model: "lumina/openclaw/design",
      });

      const update = request.mock.calls[1];
      expect(update?.[0]).toBe("/api/app-config");
      const body = JSON.parse(String(update?.[1]?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        agentId: "opencode",
        agentModels: {
          amr: { model: "glm-5.2" },
          opencode: { model: "lumina/openclaw/design" },
        },
        agentCliEnv: {
          opencode: {
            OPENCODE_BIN: expect.stringMatching(/lumina-opencode\.cmd$/u),
          },
        },
      });
      expect(String(body.customInstructions)).toContain("[Lumina OpenClaw design bridge]");

      const provider = JSON.parse(
        await readFile(path.join(dataDir, "lumina-openclaw", "opencode-provider.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(provider).toMatchObject({
        provider: {
          lumina: {
            options: {
              baseURL: "http://127.0.0.1:18789/plugins/lumina-open-design/openai/v1",
              apiKey: "gateway-test-token",
            },
          },
        },
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
