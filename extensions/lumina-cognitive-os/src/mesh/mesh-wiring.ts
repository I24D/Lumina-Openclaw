/**
 * mesh-wiring.ts — What the plugin entry calls to put the mesh in production.
 *
 * Kept apart from `index.ts` so the entry stays a list of registrations, and
 * apart from `mesh-runtime.ts` so the runtime has no opinion about the host.
 *
 * ## Which topics get a handler, and which deliberately do not
 *
 * `mesh.ping` and `mesh.note` are registered. Both have a local, repeatable
 * effect — a line in the transparency log — so re-running one costs nothing and
 * the end-to-end path can be demonstrated on the live gateway without writing
 * anywhere that matters.
 *
 * Task handoff is **not** registered, and that is the point rather than an
 * omission. Closing a task goes through `lumina_finish_task` /
 * `lumina_finish_task_fenced`, and both defects recorded in MESH.md are still
 * open: the unfenced path admits a caller by `agent_key` alone, which every
 * attempt of one agent shares, and the fenced one is not idempotent, so a
 * second close overwrites `result` and can flip a settled task. Registering a
 * consumer for those RPCs would put a known-defective write path into
 * production. It stays unregistered until the migration is authorized, and a
 * `task.*` message therefore lands in the runtime's `unhandled` log where it is
 * counted and visible — not silently acknowledged.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { StateStorePort } from "../shared/state-store.js";
import type { ActivityLog } from "../transparency/activity-log.js";
import type { MeshParty } from "./envelope.js";
import type { MeshProcessedRecord } from "./inbox.js";
import { MeshRuntime, type MeshRuntimeLogger } from "./mesh-runtime.js";
import type { MeshOutboxRecord } from "./outbox.js";

/** This gateway's identity on the mesh. Matches `KNOWN_MESH_PARTIES`. */
export const GATEWAY_MESH_PARTY: MeshParty = "openclaw-gateway";

/**
 * Plain HTTP for the counters, behind gateway auth like every plugin route.
 *
 * Deliberately separate from the cognitive core's own `/health`: a supervisor
 * watching delivery should not have to go through an agent session, and an
 * agent tool is unavailable exactly when the plugin failed to register.
 */
export const MESH_HTTP_PATH = "/plugins/lumina-cognitive-os/mesh";

export type MeshWiringDeps = {
  /** Only the live gateway registration runs the loop. */
  readonly live: boolean;
  readonly openStore?: <T>(namespace: string) => StateStorePort<T>;
  readonly logger: MeshRuntimeLogger;
  readonly activity: ActivityLog;
  readonly namespaces: {
    readonly meshOutbox: string;
    readonly meshInbox: string;
    readonly meshJournal: string;
  };
  /** Operator kill switch, read once at registration. */
  readonly enabled: boolean;
  /** Registers the counters route when the host offers one. */
  readonly registerHttpRoute?: (route: {
    path: string;
    auth: "gateway";
    match: "prefix";
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  }) => void;
  readonly activeIntervalMs?: number;
  readonly idleIntervalMs?: number;
};

export type MeshWiring = {
  readonly runtime: MeshRuntime;
  stop(): Promise<void>;
};

/**
 * Builds and starts the runtime, or returns undefined with a reason logged.
 *
 * Returns undefined rather than throwing: a gateway whose mesh cannot start
 * must still serve everything else, and the reason belongs in the log where an
 * operator will find it.
 */
export function startMeshRuntime(deps: MeshWiringDeps): MeshWiring | undefined {
  if (!deps.enabled) {
    deps.logger.info("[mesh] disabled by configuration; no loop started");
    return undefined;
  }
  if (!deps.live) {
    // Discovery and CLI loads share the same plugin code. Starting a second
    // dispatcher there would claim deliveries the gateway is already holding.
    return undefined;
  }
  if (!deps.openStore) {
    deps.logger.warn("[mesh] no durable plugin state available; not starting");
    return undefined;
  }
  const openStore = deps.openStore;
  const runtime = new MeshRuntime({
    party: GATEWAY_MESH_PARTY,
    outboxStore: openStore<MeshOutboxRecord>(deps.namespaces.meshOutbox),
    inboxStore: openStore<MeshProcessedRecord>(deps.namespaces.meshInbox),
    journalStore: openStore<unknown>(deps.namespaces.meshJournal),
    logger: deps.logger,
    ...(deps.activeIntervalMs === undefined ? {} : { activeIntervalMs: deps.activeIntervalMs }),
    ...(deps.idleIntervalMs === undefined ? {} : { idleIntervalMs: deps.idleIntervalMs }),
  });

  runtime.handle("mesh.ping", {
    effect: "idempotent",
    run: async (envelope) => {
      deps.activity.push({
        category: "agent",
        summary: `Mesh: ping de ${envelope.origin}`,
        detail: `${envelope.event_type} · ${envelope.message_id}`,
        ref: { topic: envelope.topic, correlation_id: envelope.correlation_id },
      });
      return `activity:${envelope.message_id}`;
    },
  });

  runtime.handle("mesh.note", {
    effect: "idempotent",
    run: async (envelope) => {
      deps.activity.push({
        category: "memory",
        summary: `Mesh: nota de ${envelope.origin}`,
        // The payload itself is never carried in an envelope, only a reference,
        // so this records where to look rather than pretending to hold content.
        detail: envelope.payload_ref
          ? `${envelope.payload_ref.store}:${envelope.payload_ref.id}`
          : envelope.event_type,
        ref: { topic: envelope.topic, payload_ref: envelope.payload_ref ?? null },
      });
      return `activity:${envelope.message_id}`;
    },
  });

  deps.registerHttpRoute?.({
    path: MESH_HTTP_PATH,
    auth: "gateway",
    match: "prefix",
    handler: async (req, res) => {
      if (req.method !== "GET") {
        res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "method not allowed" }));
        return true;
      }
      const snapshot = await runtime.snapshot();
      const payload = JSON.stringify(snapshot);
      res.writeHead(200, {
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(payload),
        "content-type": "application/json; charset=utf-8",
      });
      res.end(payload);
      return true;
    },
  });

  void runtime.start().catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    deps.logger.warn(`[mesh] start failed: ${reason}`);
  });

  return {
    runtime,
    stop: () => runtime.stop(),
  };
}
