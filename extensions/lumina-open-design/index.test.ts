import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

describe("lumina-open-design plugin", () => {
  it("registers an authenticated design tab, route, and runtime service", () => {
    const registerControlUiDescriptor = vi.fn();
    const registerHttpRoute = vi.fn();
    const registerGatewayMethod = vi.fn();
    const registerService = vi.fn();
    plugin.register({
      pluginConfig: { autoStart: false },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      runtime: { gateway: { request: vi.fn(), isAvailable: vi.fn() } },
      session: { controls: { registerControlUiDescriptor } },
      registerGatewayMethod,
      registerHttpRoute,
      registerService,
    } as never);

    expect(registerControlUiDescriptor).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "design",
        label: "Diseño",
        openInNewWindow: true,
        path: "/plugins/lumina-open-design",
      }),
    );
    expect(registerHttpRoute).toHaveBeenCalledWith(
      expect.objectContaining({ auth: "gateway", match: "prefix" }),
    );
    expect(registerGatewayMethod).toHaveBeenCalledWith(
      "lumina.openDesign.create",
      expect.any(Function),
      { scope: "operator.write" },
    );
    expect(registerGatewayMethod).toHaveBeenCalledWith(
      "lumina.openDesign.studio",
      expect.any(Function),
      { scope: "operator.write", profileAccess: "independent" },
    );
    expect(registerService).toHaveBeenCalledWith(
      expect.objectContaining({ id: "lumina-open-design-runtime" }),
    );
  });
});
