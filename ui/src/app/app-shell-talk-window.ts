import type { ShellRouteState } from "./app-host-route-state.ts";
import { preparePluginWindowShellClass } from "./app-shell-plugin-window.ts";

export function prepareDetachedWindowShellClass(routeState: ShellRouteState): string {
  return `${prepareTalkWindowShellClass(routeState)}${preparePluginWindowShellClass(routeState)}`;
}

export function prepareTalkWindowShellClass(routeState: ShellRouteState): string {
  const active =
    routeState.routeId === "chat" &&
    new URLSearchParams(routeState.location?.search ?? "").get("talk") === "1";
  if (active) {
    void import("../styles/chat/talk-window.css");
  }
  return active ? " shell--talk-window" : "";
}
