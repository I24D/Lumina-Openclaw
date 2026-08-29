import { describe, expect, it } from "vitest";
import { preparePluginWindowShellClass } from "./app-shell-plugin-window.ts";

describe("preparePluginWindowShellClass", () => {
  it("activates only for detached plugin routes", () => {
    expect(
      preparePluginWindowShellClass({
        routeId: "plugin",
        location: { pathname: "/plugin", search: "?pluginWindow=1", hash: "" },
      }),
    ).toBe(" shell--plugin-window");
    expect(
      preparePluginWindowShellClass({
        routeId: "plugin",
        location: { pathname: "/plugin", search: "", hash: "" },
      }),
    ).toBe("");
    expect(
      preparePluginWindowShellClass({
        routeId: "chat",
        location: { pathname: "/chat", search: "?pluginWindow=1", hash: "" },
      }),
    ).toBe("");
  });
});
