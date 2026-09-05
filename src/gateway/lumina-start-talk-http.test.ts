// The microphone falls back to the browser Talk window on anything but a 200,
// so this route's status codes are the contract the composer reads.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayAuthResult } from "./auth.js";

const TEST_GATEWAY_TOKEN = "test-gateway-token-1234567890";

const authMock = vi.fn(async (): Promise<GatewayAuthResult> => ({ ok: true }));
const launchMock = vi.fn();
const availabilityMock = vi.fn();

vi.mock("../config/config.js", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("../config/io.js", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("./auth.js", () => ({ authorizeHttpGatewayConnect: authMock }));
vi.mock("../lumina/start-talk/launch.js", () => ({
  launchLuminaStartTalk: launchMock,
  luminaStartTalkAvailability: availabilityMock,
}));

const { handleLuminaStartTalkHttpRequest } = await import("./lumina-start-talk-http.js");

let port = 0;
let server: ReturnType<typeof createServer> | undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    void handleLuminaStartTalkHttpRequest(req, res, {
      auth: { mode: "token", token: TEST_GATEWAY_TOKEN, allowTailscale: false },
    }).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end("not found");
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server?.once("error", reject);
    server?.listen(0, "127.0.0.1", () => {
      const address = server?.address() as AddressInfo | null;
      if (!address) {
        reject(new Error("server missing address"));
        return;
      }
      port = address.port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server?.close((err) => (err ? reject(err) : resolve()));
  });
});

beforeEach(() => {
  authMock.mockReset();
  authMock.mockResolvedValue({ ok: true, method: "token" });
  launchMock.mockReset();
  availabilityMock.mockReset();
});

function request(method: "GET" | "POST", token: string | null = TEST_GATEWAY_TOKEN) {
  return fetch(`http://127.0.0.1:${port}/lumina/start-talk`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

describe("lumina start talk http route", () => {
  it("reports availability without launching anything", async () => {
    availabilityMock.mockReturnValue({ available: true });
    const response = await request("GET");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, available: true });
    expect(launchMock).not.toHaveBeenCalled();
  });

  it("launches on POST", async () => {
    launchMock.mockReturnValue({ status: "launched" });
    const response = await request("POST");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, launched: true });
  });

  it("answers 503 with the reason when the host has no Start Talk", async () => {
    launchMock.mockReturnValue({ status: "unavailable", reason: "not installed at C:\\nope" });
    const response = await request("POST");
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error?: { message?: string } };
    expect(body.error?.message).toContain("not installed");
  });

  it("never launches for an unauthorized caller", async () => {
    authMock.mockResolvedValue({ ok: false, error: "unauthorized" } as GatewayAuthResult);
    const response = await request("POST", null);
    expect(response.status).toBe(401);
    expect(launchMock).not.toHaveBeenCalled();
  });

  it("rejects other methods", async () => {
    const response = await request("DELETE" as "GET");
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, POST");
    expect(launchMock).not.toHaveBeenCalled();
  });
});
