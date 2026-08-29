import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLuminaOpenDesignHttpHandler } from "./http.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function serve(handler: ReturnType<typeof createLuminaOpenDesignHttpHandler>) {
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function runtimeMock() {
  return {
    ensureReady: vi.fn(async () => ({
      ready: true,
      installed: true,
      daemonUrl: "http://127.0.0.1:7456",
      managed: false,
      version: "0.21.0",
    })),
    request: vi.fn(async (pathname: string, init?: RequestInit) => {
      if (pathname === "/api/projects" && init?.method === "POST") {
        return Response.json({ project: { id: "launch-board", name: "Launch board" } });
      }
      if (pathname === "/api/projects") {
        return Response.json({ projects: [] });
      }
      if (pathname === "/api/skills") {
        return Response.json({ skills: [{ id: "ui-skills", name: "UI Skills" }] });
      }
      if (pathname === "/api/design-systems") {
        return Response.json({ designSystems: [{ id: "linear-app", name: "Linear" }] });
      }
      if (pathname === "/api/plugins") {
        return Response.json({ plugins: [{ id: "prototype", title: "Prototype" }] });
      }
      return Response.json({ files: [] });
    }),
    launchDesktop: vi.fn(),
  };
}

describe("lumina-open-design HTTP surface", () => {
  it("serves the authenticated design workspace and bounded catalog", async () => {
    const runtime = runtimeMock();
    const base = await serve(
      createLuminaOpenDesignHttpHandler({
        runtime: runtime as never,
        sessionKey: "agent:main:main",
        gatewayRequest: vi.fn(),
      }),
    );

    const page = await fetch(`${base}/plugins/lumina-open-design`);
    expect(page.status).toBe(200);
    const pageHtml = await page.text();
    expect(pageHtml).toContain("Lumina Diseño");
    expect(pageHtml).toContain("function readStoredTheme()");

    const catalog = await fetch(`${base}/plugins/lumina-open-design/api/catalog`).then(
      async (response) => (await response.json()) as Record<string, unknown>,
    );
    expect(catalog.counts).toEqual({ skills: 1, designSystems: 1, plugins: 1 });
  });

  it("creates a project and sends the brief to Lumina without delegated runs", async () => {
    const runtime = runtimeMock();
    const gatewayRequest = vi.fn(async () => ({ runId: "run-1", status: "started" }));
    const base = await serve(
      createLuminaOpenDesignHttpHandler({
        runtime: runtime as never,
        sessionKey: "agent:main:main",
        gatewayRequest,
      }),
    );

    const response = await fetch(`${base}/plugins/lumina-open-design/api/design`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Launch board",
        brief: "Create a clear release dashboard.",
        kind: "dashboard",
        designSystem: "linear-app",
      }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ projectId: "launch-board", runId: "run-1" });
    expect(gatewayRequest).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({
        sessionKey: "agent:main:main",
        deliver: false,
        message: expect.stringContaining(
          "No cambies de modelo, no delegues agentes y no uses start_run",
        ),
      }),
      expect.objectContaining({ scopes: ["operator.write"] }),
    );
  });
});
