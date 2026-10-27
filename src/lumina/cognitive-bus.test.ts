/** Tests the Lumina emitter that publishes gateway lifecycle events to the Cognitive Bus. */
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRuntimeServiceBuildId } from "../version.js";
import {
  publishLuminaAutomationEvent,
  publishLuminaGatewayStarted,
  publishLuminaMessageSent,
  resetLuminaCognitiveBusForTests,
} from "./cognitive-bus.js";

const ENV = {
  SUPABASE_URL: "https://bus.example.supabase.co/",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

const fetchMock = vi.fn<typeof fetch>();

function publishedRows(): unknown[] {
  return fetchMock.mock.calls.map(([, init]) =>
    typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
  );
}

function startGateway(): void {
  publishLuminaGatewayStarted(ENV);
  fetchMock.mockClear();
}

beforeEach(() => {
  fetchMock.mockResolvedValue(new Response(null, { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  resetLuminaCognitiveBusForTests();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("publishLuminaGatewayStarted", () => {
  it("inserts gateway.started with the build id through PostgREST", () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    publishLuminaGatewayStarted(ENV);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://bus.example.supabase.co/rest/v1/lumina_events");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      apikey: "service-role-key",
      authorization: "Bearer service-role-key",
      prefer: "return=minimal",
    });
    expect(timeout).toHaveBeenCalledExactlyOnceWith(3_000);
    expect(publishedRows()).toEqual([
      {
        origin: "openclaw-gateway",
        event_type: "gateway.started",
        priority: 3,
        evidence: { buildId: resolveRuntimeServiceBuildId() },
      },
    ]);
  });

  it("publishes nothing without credentials", () => {
    publishLuminaGatewayStarted({});
    publishLuminaMessageSent("whatsapp", { success: true }, { SUPABASE_URL: ENV.SUPABASE_URL });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws when Supabase is unreachable", async () => {
    fetchMock.mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));
    expect(() => publishLuminaGatewayStarted(ENV)).not.toThrow();

    fetchMock.mockImplementation(() => {
      throw new Error("fetch exploded");
    });
    expect(() => publishLuminaMessageSent("telegram", { success: true }, ENV)).not.toThrow();
    // The rejected insert settles inside the emitter instead of surfacing as unhandled.
    await nextTurn();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("publishLuminaAutomationEvent", () => {
  it("stays off the bus until this process starts a gateway", () => {
    publishLuminaAutomationEvent({ action: "finished", jobId: "job-1", status: "ok" }, ENV);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("publishes a completed run at priority 2", () => {
    startGateway();
    publishLuminaAutomationEvent(
      { action: "finished", jobId: "job-1", status: "ok", completionStatus: "succeeded" },
      ENV,
    );

    expect(publishedRows()).toEqual([
      {
        origin: "openclaw-gateway",
        event_type: "automation.completed",
        priority: 2,
        evidence: { jobId: "job-1", status: "ok" },
      },
    ]);
  });

  it("publishes errors, skips and undelivered results as failed at priority 4", () => {
    startGateway();
    publishLuminaAutomationEvent(
      { action: "finished", jobId: "job-1", status: "error", error: "model\n  timed out" },
      ENV,
    );
    publishLuminaAutomationEvent(
      { action: "finished", jobId: "job-2", status: "skipped", error: "agent selection required" },
      ENV,
    );
    publishLuminaAutomationEvent(
      {
        action: "finished",
        jobId: "job-3",
        status: "ok",
        completionStatus: "failed",
        deliveryError: "channel offline",
      },
      ENV,
    );

    expect(publishedRows()).toEqual([
      {
        origin: "openclaw-gateway",
        event_type: "automation.failed",
        priority: 4,
        evidence: { jobId: "job-1", status: "error", error: "model timed out" },
      },
      {
        origin: "openclaw-gateway",
        event_type: "automation.failed",
        priority: 4,
        evidence: { jobId: "job-2", status: "skipped", error: "agent selection required" },
      },
      {
        origin: "openclaw-gateway",
        event_type: "automation.failed",
        priority: 4,
        evidence: { jobId: "job-3", status: "ok", error: "channel offline" },
      },
    ]);
  });

  it("keeps the error summary short and free of credentials", () => {
    startGateway();
    const token = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";
    publishLuminaAutomationEvent(
      {
        action: "finished",
        jobId: "job-1",
        status: "error",
        error: `GitHub rejected ${token}. ${"detail ".repeat(80)}`,
      },
      ENV,
    );

    const [row] = publishedRows() as Array<{ evidence: { error: string } }>;
    expect(row?.evidence.error.length).toBeLessThanOrEqual(200);
    expect(row?.evidence.error).toMatch(/^GitHub rejected /u);
    expect(row?.evidence.error).not.toContain(token);
  });

  it("ignores cron events other than finished runs", () => {
    startGateway();
    publishLuminaAutomationEvent({ action: "started", jobId: "job-1" }, ENV);
    publishLuminaAutomationEvent({ action: "updated", jobId: "job-1" }, ENV);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("publishLuminaMessageSent", () => {
  it("publishes delivered messages with their channel at priority 1", () => {
    startGateway();
    publishLuminaMessageSent("whatsapp", { success: true }, ENV);
    publishLuminaMessageSent("telegram", { success: false }, ENV);

    expect(publishedRows()).toEqual([
      {
        origin: "openclaw-gateway",
        event_type: "message.delivered",
        priority: 1,
        evidence: { channel: "whatsapp" },
      },
    ]);
  });
});
