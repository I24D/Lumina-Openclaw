// The composer reads availability synchronously, so what this module does with
// a pending, failed, or negative answer decides whether the microphone ever
// reaches Start Talk.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Client = typeof import("./lumina-start-talk.ts");

let client: Client;

beforeEach(async () => {
  // The module caches availability in module scope; each case needs its own.
  vi.resetModules();
  client = await import("./lumina-start-talk.ts");
});

function gateway(request: ReturnType<typeof vi.fn>) {
  return { request } as unknown as Parameters<Client["primeLuminaStartTalk"]>[0];
}

describe("lumina start talk client", () => {
  it("reports the host's answer and asks only once per connection", async () => {
    const request = vi.fn().mockResolvedValue({ available: true });
    const socket = gateway(request);
    client.primeLuminaStartTalk(socket);
    await vi.waitFor(() => expect(client.isLuminaStartTalkAvailable()).toBe(true));
    client.primeLuminaStartTalk(socket);
    client.primeLuminaStartTalk(socket);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("lumina.startTalk.status");
  });

  it("stays unknown when the gateway cannot answer, so the next render retries", async () => {
    const request = vi.fn().mockRejectedValue(new Error("socket closed"));
    const socket = gateway(request);
    client.primeLuminaStartTalk(socket);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    // Unknown, not false: a dropped socket is not evidence about the host.
    expect(client.isLuminaStartTalkAvailable()).toBeNull();
    // Renders keep priming; the retry lands once the failed request settles.
    await vi.waitFor(() => {
      client.primeLuminaStartTalk(socket);
      expect(request).toHaveBeenCalledTimes(2);
    });
  });

  it("asks again when a new connection replaces the old one", async () => {
    const first = vi.fn().mockResolvedValue({ available: true });
    client.primeLuminaStartTalk(gateway(first));
    await vi.waitFor(() => expect(client.isLuminaStartTalkAvailable()).toBe(true));
    const second = vi.fn().mockResolvedValue({ available: false });
    client.primeLuminaStartTalk(gateway(second));
    await vi.waitFor(() => expect(client.isLuminaStartTalkAvailable()).toBe(false));
  });

  it("does nothing without a connection", () => {
    client.primeLuminaStartTalk(null);
    expect(client.isLuminaStartTalkAvailable()).toBeNull();
  });

  it("stops claiming the host has Start Talk once a launch comes back refused", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ available: true })
      .mockResolvedValueOnce({ opened: false, reason: "not installed" });
    const socket = gateway(request);
    client.primeLuminaStartTalk(socket);
    await vi.waitFor(() => expect(client.isLuminaStartTalkAvailable()).toBe(true));
    await expect(client.launchLuminaStartTalk(socket)).resolves.toBe(false);
    expect(client.isLuminaStartTalkAvailable()).toBe(false);
  });

  it("opens Start Talk when the gateway launched it", async () => {
    const request = vi.fn().mockResolvedValue({ opened: true });
    await expect(client.launchLuminaStartTalk(gateway(request))).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith("lumina.startTalk.open");
  });
});
