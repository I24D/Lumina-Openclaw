import type { ShellRouteState } from "./app-host-route-state.ts";

export function prepareTalkWindowShellClass(routeState: ShellRouteState): string {
  const active =
    routeState.routeId === "chat" &&
    new URLSearchParams(routeState.location?.search ?? "").get("talk") === "1";
  if (active) {
    void import("../styles/chat/talk-window.css");
  }
  return active ? " shell--talk-window" : "";
}
