import { describe, expect, it } from "vitest";
import { isPluginWindowShell } from "./app-shell-plugin-window.ts";

describe("isPluginWindowShell", () => {
  it("activates only for detached plugin routes", () => {
    expect(
      isPluginWindowShell({
        routeId: "plugin",
        location: { pathname: "/plugin", search: "?pluginWindow=1", hash: "" },
      }),
    ).toBe(true);
    expect(
      isPluginWindowShell({
        routeId: "plugin",
        location: { pathname: "/plugin", search: "", hash: "" },
      }),
    ).toBe(false);
    expect(
      isPluginWindowShell({
        routeId: "chat",
        location: { pathname: "/chat", search: "?pluginWindow=1", hash: "" },
      }),
    ).toBe(false);
  });
});
