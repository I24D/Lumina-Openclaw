import process from "node:process";
import { resolveAcpSessionAvailability } from "openclaw/plugin-sdk/acp-runtime";
import { resolveSessionAgentIdsStrict } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveNodeHostExecutable } from "openclaw/plugin-sdk/node-host";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  createSessionCatalogAdoptionCoordinator,
  importSessionCatalogHistory,
  listAdoptedSessionCatalogSessions,
  sessionCatalogAdoptedSessionKey,
  sessionCatalogAdoptedSourceKey,
  type SessionCatalogProvider,
} from "openclaw/plugin-sdk/session-catalog";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  CLINE_LOCAL_HOST_ID,
  clineUsesProcessHomeFallback,
  listLocalClineSessionPage,
  readLocalClineTranscriptPage,
  requireLocalClineSession,
} from "./session-catalog.js";

const ACPX_BACKEND_ID = "acpx";
const CLINE_ACP_AGENT_ID = "cline";
const ADOPTED_KEY_PREFIX = "plugin:cline:catalog-adopt:";

function currentConfig(api: OpenClawPluginApi): OpenClawConfig {
  return (api.runtime.config?.current?.() ?? api.config ?? {}) as OpenClawConfig;
}

function enabled(pluginConfig: unknown): boolean {
  return (
    !isRecord(pluginConfig) ||
    !isRecord(pluginConfig.sessionCatalog) ||
    pluginConfig.sessionCatalog.enabled !== false
  );
}

export function registerClineSessionCatalog(api: OpenClawPluginApi): void {
  if (!enabled(api.pluginConfig)) {
    return;
  }
  const adoption = createSessionCatalogAdoptionCoordinator<{ sessionKey: string }>();
  const provider: SessionCatalogProvider = {
    id: "cline",
    label: "Cline",
    supportsProcessHomeIsolation: true,
    async list(query) {
      if (query.hostIds && !query.hostIds.includes(CLINE_LOCAL_HOST_ID)) {
        return [];
      }
      if (query.allowProcessHomeFallback === false && clineUsesProcessHomeFallback()) {
        return [];
      }
      const executable = resolveNodeHostExecutable("cline", {
        env: process.env,
        pathEnv: process.env.PATH ?? process.env.Path ?? "",
        strategy: "fallback",
      });
      if (!executable) {
        return [];
      }
      const availability = resolveAcpSessionAvailability({
        config: currentConfig(api),
        backendId: ACPX_BACKEND_ID,
        agentId: CLINE_ACP_AGENT_ID,
      });
      const adopted = query.sessionEntries
        ? listAdoptedSessionCatalogSessions({
            ...(query.agentId ? { agentId: query.agentId } : {}),
            config: currentConfig(api),
            pluginId: api.id,
            runtime: api.runtime,
            sessionEntries: query.sessionEntries,
            sourceFromEntry: (entry) => {
              const cline = isRecord(entry.pluginExtensions?.cline)
                ? entry.pluginExtensions.cline
                : undefined;
              const marker =
                cline && isRecord(cline.sessionCatalog) ? cline.sessionCatalog : undefined;
              return marker && typeof marker.sourceThreadId === "string"
                ? { hostId: CLINE_LOCAL_HOST_ID, threadId: marker.sourceThreadId }
                : undefined;
            },
          })
        : new Map<string, string>();
      const page = await listLocalClineSessionPage({
        limit: query.limitPerHost,
        ...(query.search ? { searchTerm: query.search } : {}),
        cursor: query.cursors?.[CLINE_LOCAL_HOST_ID],
      });
      const host = {
        hostId: CLINE_LOCAL_HOST_ID,
        label: "Local Cline",
        kind: "gateway" as const,
        connected: true,
        ...page,
        sessions: page.sessions.map((session) => {
          const sessionKey = adopted.get(
            sessionCatalogAdoptedSourceKey(CLINE_LOCAL_HOST_ID, session.threadId),
          );
          return Object.assign({}, session, {
            canContinue: availability.available,
            canOpenTerminal: true,
            ...(sessionKey ? { sessionKey } : {}),
          });
        }),
      };
      query.onHost?.(host);
      return [host];
    },
    async read(request) {
      if (request.hostId !== CLINE_LOCAL_HOST_ID) {
        throw new Error("Cline session catalog hostId is invalid");
      }
      if (request.allowProcessHomeFallback === false && clineUsesProcessHomeFallback()) {
        throw new Error("Local Cline sessions are unavailable in isolated state");
      }
      return await readLocalClineTranscriptPage({
        threadId: request.threadId,
        ...(request.limit ? { limit: request.limit } : {}),
        ...(request.cursor !== undefined ? { cursor: request.cursor } : {}),
      });
    },
    async continueSession(request) {
      if (request.hostId !== CLINE_LOCAL_HOST_ID) {
        throw new Error("Cline sessions on paired nodes are view-only");
      }
      const availability = resolveAcpSessionAvailability({
        config: currentConfig(api),
        backendId: ACPX_BACKEND_ID,
        agentId: CLINE_ACP_AGENT_ID,
      });
      if (!availability.available) {
        throw new Error(availability.message);
      }
      const agentId = resolveSessionAgentIdsStrict({
        config: api.config,
        agentId: request.agentId,
      }).sessionAgentId;
      return await adoption({
        sourceKey: sessionCatalogAdoptedSourceKey(request.hostId, request.threadId),
        findExisting: () => {
          const adopted = listAdoptedSessionCatalogSessions({
            agentId,
            config: currentConfig(api),
            pluginId: api.id,
            runtime: api.runtime,
            sourceFromEntry: (entry) => {
              const cline = isRecord(entry.pluginExtensions?.cline)
                ? entry.pluginExtensions.cline
                : undefined;
              const marker =
                cline && isRecord(cline.sessionCatalog) ? cline.sessionCatalog : undefined;
              return marker && typeof marker.sourceThreadId === "string"
                ? { hostId: CLINE_LOCAL_HOST_ID, threadId: marker.sourceThreadId }
                : undefined;
            },
          });
          return adopted.get(sessionCatalogAdoptedSourceKey(CLINE_LOCAL_HOST_ID, request.threadId));
        },
        create: async () => {
          const session = await requireLocalClineSession(request.threadId);
          const marker = { sourceThreadId: request.threadId };
          const created = await api.runtime.agent.session.createSessionEntry({
            cfg: currentConfig(api),
            key: sessionCatalogAdoptedSessionKey(ADOPTED_KEY_PREFIX, request.threadId),
            agentId,
            recoverMatchingInitialEntry: true,
            ...(session.name ? { displayName: session.name } : {}),
            ...(session.cwd ? { spawnedCwd: session.cwd } : {}),
            initialEntry: {
              acpBackendId: ACPX_BACKEND_ID,
              acpSessionBinding: {
                acpAgentId: CLINE_ACP_AGENT_ID,
                agentSessionId: request.threadId,
              },
              pluginExtensions: { cline: { sessionCatalog: marker } },
            },
            afterCreate: async (entry) => {
              await importSessionCatalogHistory({
                catalogId: "cline",
                threadId: request.threadId,
                read: async ({ cursor, limit }) =>
                  await readLocalClineTranscriptPage({
                    threadId: request.threadId,
                    limit,
                    ...(cursor ? { cursor } : {}),
                  }),
                sessionId: entry.sessionId,
                sessionKey: entry.key,
                agentId: entry.agentId,
                ...(session.cwd ? { cwd: session.cwd } : {}),
                config: currentConfig(api),
              });
              return { pluginExtensions: { cline: { sessionCatalog: marker } } };
            },
          });
          return { sessionKey: created.key };
        },
        complete: async (continued) => continued,
      });
    },
    async openTerminal(request) {
      if (request.hostId !== CLINE_LOCAL_HOST_ID) {
        throw new Error("Cline terminal hostId is invalid");
      }
      const session = await requireLocalClineSession(request.threadId);
      const resolution = resolveNodeHostExecutable("cline", {
        env: process.env,
        pathEnv: process.env.PATH ?? process.env.Path ?? "",
        strategy: "fallback",
      });
      if (!resolution) {
        throw new Error("Cline CLI is unavailable");
      }
      return {
        kind: "local",
        argv: [resolution.executable, "--id", request.threadId, "--tui"],
        ...(session.cwd ? { cwd: session.cwd } : {}),
        ...(resolution.pathEnv ? { pathEnv: resolution.pathEnv } : {}),
        title: `cline --id ${request.threadId.slice(0, 12)}…`,
      };
    },
  };
  api.registerSessionCatalog(provider);
}
