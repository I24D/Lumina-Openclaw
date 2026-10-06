import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { resolveEmbedSandbox } from "../../lib/chat/tool-display.ts";
import type { renderLogbook } from "./logbook-view.ts";

/**
 * Views shipped with the Control UI use this adapter. Native plugin entries
 * mount through the contribution runtime; descriptor paths use sandboxed frames.
 */
export type BundledPluginTabView = {
  render: (props: Parameters<typeof renderLogbook>[0]) => unknown;
  stop: (host: object) => void;
};

const TRUSTED_SAME_ORIGIN_TABS = new Set(["lumina-open-design/design"]);

export function resolveLuminaDesignHostMethod(action: unknown): string | null {
  if (action === "create") {
    return "lumina.openDesign.create";
  }
  if (action === "studio") {
    return "lumina.openDesign.studio";
  }
  return null;
}

/**
 * Answers a request from the mounted Lumina Design frame: same origin only, the
 * known write methods only, through the parent's authenticated gateway session.
 */
export function answerLuminaDesignFrameRequest(params: {
  event: MessageEvent;
  frame: HTMLIFrameElement | null;
  client: GatewayBrowserClient | null;
  connected: boolean;
}): void {
  const { event, frame, client } = params;
  if (
    event.origin !== window.location.origin ||
    !frame?.contentWindow ||
    event.source !== frame.contentWindow
  ) {
    return;
  }
  const data = event.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return;
  }
  const request = data as { type?: unknown; id?: unknown; action?: unknown; payload?: unknown };
  const method = resolveLuminaDesignHostMethod(request.action);
  if (
    request.type !== "lumina-open-design:request" ||
    typeof request.id !== "string" ||
    !/^[A-Za-z0-9-]{1,80}$/u.test(request.id) ||
    !method
  ) {
    return;
  }
  const source = frame.contentWindow;
  const respond = (message: Record<string, unknown>) => {
    source.postMessage(
      { type: "lumina-open-design:response", id: request.id, ...message },
      event.origin,
    );
  };
  if (!client || !params.connected) {
    respond({ ok: false, error: "Gateway unavailable" });
    return;
  }
  void client
    .request(method, request.payload ?? {}, { timeoutMs: 30_000 })
    .then((result) => respond({ ok: true, result }))
    .catch((error: unknown) =>
      respond({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
}

export function resolvePluginTabSandbox(
  pluginId: string,
  tabId: string,
  mode: Parameters<typeof resolveEmbedSandbox>[0],
): string {
  // Lumina Design is a bundled, authenticated operator surface. It needs
  // same-origin access to call its route-scoped Gateway API from the frame.
  if (TRUSTED_SAME_ORIGIN_TABS.has(`${pluginId}/${tabId}`)) {
    return `${resolveEmbedSandbox("trusted")} allow-forms`;
  }
  return resolveEmbedSandbox(mode);
}

// Keyed by pluginId/tabId: tab ids are only unique within their plugin.
export const BUNDLED_TAB_VIEWS: Record<string, () => Promise<BundledPluginTabView>> = {
  "logbook/logbook": async () => {
    const [{ renderLogbook }, { stopLogbookPolling }] = await Promise.all([
      import("./logbook-view.ts"),
      import("./logbook-controller.ts"),
    ]);
    return { render: renderLogbook, stop: stopLogbookPolling };
  },
  "lumina-cognitive-os/core": async () => {
    const [{ renderLuminaCore }, { stopLuminaCorePolling }] = await Promise.all([
      import("./lumina-core-view.ts"),
      import("./lumina-core-controller.ts"),
    ]);
    return { render: renderLuminaCore, stop: stopLuminaCorePolling };
  },
};
