import type { ShellRouteState } from "./app-host-route-state.ts";

export function preparePluginWindowShellClass(routeState: ShellRouteState): string {
  const active =
    routeState.routeId === "plugin" &&
    new URLSearchParams(routeState.location?.search ?? "").get("pluginWindow") === "1";
  if (active) {
    void import("../styles/plugin-window.css");
  }
  return active ? " shell--plugin-window" : "";
}
