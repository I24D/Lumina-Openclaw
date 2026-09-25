import type {
  OpenClawPluginApi,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  connectToTarget,
  listPageTargets,
  selectTarget,
  type CdpConnection,
} from "./cdp-client.js";
import { createOrderGate, type RelayCandidate } from "./order-policy.js";
import { BRIDGE_BINDING_NAME, buildObserverSource, parseObservedTurn } from "./page-observer.js";

const SERVICE_ID = "chatgpt-bridge";
const SETTLE_MS = 1200;
const RETRY_IDLE_MS = 10_000;
const RETRY_ERROR_MS = 5_000;

type BridgeConfig = {
  enabled: boolean;
  cdpUrl: string;
  sessionKey: string;
  agentId?: string;
  marker: string;
  urlPattern: string;
  maxOrderChars: number;
  userTurnWindowMs: number;
  minIntervalMs: number;
  maxPerHour: number;
  denyPatterns: readonly string[];
};

const DEFAULT_DENY_PATTERNS: readonly string[] = [
  "bitso",
  "api[_ -]?key",
  "api[_ -]?secret",
  "\\.env\\b",
  "rm\\s+-rf",
];

function readString(source: Record<string, unknown>, key: string, fallback: string): string {
  const value = source[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function readNumber(source: Record<string, unknown>, key: string, fallback: number): number {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function resolveBridgeConfig(pluginConfig: unknown): BridgeConfig {
  const source = isRecord(pluginConfig) ? pluginConfig : {};
  const denyPatterns = Array.isArray(source.denyPatterns)
    ? source.denyPatterns.filter((entry): entry is string => typeof entry === "string")
    : DEFAULT_DENY_PATTERNS;
  const agentId =
    typeof source.agentId === "string" && source.agentId.trim() ? source.agentId.trim() : undefined;
  return {
    enabled: source.enabled !== false,
    cdpUrl: readString(source, "cdpUrl", "http://127.0.0.1:18800"),
    sessionKey: readString(source, "sessionKey", "agent:main:main"),
    ...(agentId ? { agentId } : {}),
    marker: readString(source, "marker", "@OPENCLAW:"),
    urlPattern: readString(source, "urlPattern", "chatgpt.com"),
    maxOrderChars: readNumber(source, "maxOrderChars", 2000),
    userTurnWindowMs: readNumber(source, "userTurnWindowMs", 300_000),
    minIntervalMs: readNumber(source, "minIntervalMs", 3_000),
    maxPerHour: readNumber(source, "maxPerHour", 40),
    denyPatterns,
  };
}

/**
 * Watches the ChatGPT tab and relays marked orders into an OpenClaw session.
 *
 * Runs inside the Gateway so it lives and dies with it: there is no separate
 * process to supervise, and editing its `plugins.entries` block reloads the
 * plugin, which restarts this service with the new config.
 */
export function createChatGptBridgeService(api: OpenClawPluginApi): OpenClawPluginService {
  let stopped = false;
  let connection: CdpConnection | undefined;
  let loop: Promise<void> | undefined;

  const start = async (ctx: OpenClawPluginServiceContext): Promise<void> => {
    stopped = false;
    const config = resolveBridgeConfig(api.pluginConfig);
    if (!config.enabled) {
      ctx.logger.info("chatgpt-bridge disabled by config");
      return;
    }
    const gate = createOrderGate({
      marker: config.marker,
      maxOrderChars: config.maxOrderChars,
      userTurnWindowMs: config.userTurnWindowMs,
      minIntervalMs: config.minIntervalMs,
      maxPerHour: config.maxPerHour,
      denyPatterns: config.denyPatterns,
    });

    const relay = async (candidate: RelayCandidate): Promise<void> => {
      const decision = gate.evaluate(candidate);
      if (!decision.relay) {
        if (decision.reason !== "no marker" && decision.reason !== "already relayed") {
          ctx.logger.warn(`chatgpt-bridge refused an order: ${decision.reason}`);
        }
        return;
      }
      try {
        await api.runtime.gateway.request(
          "chat.send",
          {
            sessionKey: config.sessionKey,
            ...(config.agentId ? { agentId: config.agentId } : {}),
            message: decision.order,
            idempotencyKey: `chatgpt-bridge:${candidate.messageId}`,
            // Relayed text is authored by a model that reads untrusted pages, so it
            // enters under the same restricted policy as any external requester.
            systemInputProvenance: { kind: "external_user", sourceChannel: "chatgpt-bridge" },
          },
          { scopes: ["operator.admin"] },
        );
        gate.commit(candidate, candidate.observedAt);
        ctx.logger.info(`chatgpt-bridge relayed an order (${decision.order.length} chars)`);
      } catch (error) {
        ctx.logger.error(`chatgpt-bridge could not deliver an order: ${String(error)}`);
      }
    };

    const attachOnce = async (): Promise<number> => {
      const targets = await listPageTargets(config.cdpUrl);
      const target = selectTarget(targets, config.urlPattern);
      if (!target) {
        return RETRY_IDLE_MS;
      }
      const active = await connectToTarget(target);
      connection = active;
      active.on("Runtime.bindingCalled", (params) => {
        if (params.name !== BRIDGE_BINDING_NAME) {
          return;
        }
        const turn = parseObservedTurn(params.payload);
        if (turn) {
          void relay(turn);
        }
      });
      await active.send("Runtime.enable");
      await active.send("Runtime.addBinding", { name: BRIDGE_BINDING_NAME });
      await active.send("Page.enable");
      const source = buildObserverSource(SETTLE_MS);
      // Survives full reloads; the immediate evaluate covers the current document.
      await active.send("Page.addScriptToEvaluateOnNewDocument", { source });
      await active.send("Runtime.evaluate", { expression: source, returnByValue: true });
      ctx.logger.info(`chatgpt-bridge watching ${target.url} -> ${config.sessionKey}`);
      await active.closed;
      connection = undefined;
      return stopped ? 0 : RETRY_ERROR_MS;
    };

    loop = (async () => {
      while (!stopped) {
        let wait = RETRY_ERROR_MS;
        try {
          wait = await attachOnce();
        } catch (error) {
          ctx.logger.warn(`chatgpt-bridge attach failed: ${String(error)}`);
        }
        if (stopped || wait === 0) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    })();
  };

  return {
    id: SERVICE_ID,
    // No `reload` here: the plugin service contract in the SDK does not expose it,
    // and the Gateway already reloads the whole plugin when its `plugins.entries`
    // block changes, which restarts this service with the new config.
    start: (ctx) => {
      void start(ctx);
    },
    stop: async () => {
      stopped = true;
      connection?.close();
      connection = undefined;
      await loop?.catch(() => undefined);
      loop = undefined;
    },
  };
}
