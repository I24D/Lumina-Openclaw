import type { ShellRouteState } from "./app-host-route-state.ts";

/** Lumina Design opens plugin tabs with `pluginWindow=1` as a chrome-less detached window. */
export function isPluginWindowShell(routeState: ShellRouteState): boolean {
  const active =
    routeState.routeId === "plugin" &&
    new URLSearchParams(routeState.location?.search ?? "").get("pluginWindow") === "1";
  if (active) {
    void import("../styles/plugin-window.css");
  }
  return active;
}
