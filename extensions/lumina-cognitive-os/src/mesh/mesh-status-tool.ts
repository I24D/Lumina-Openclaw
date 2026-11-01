/**
 * mesh-status-tool.ts — The mesh's live counters, read from the running loop.
 *
 * Every number here is read at call time from the outbox and inbox, which read
 * their rows from the durable store. Nothing is cached, sampled or seeded with
 * demonstration values: if the mesh has never run, `lastPassAt` is null and the
 * counters are zero, and those two states are deliberately distinguishable.
 */
import { Type } from "typebox";
import { jsonResult, type AnyAgentTool } from "../shared/tool-result.js";
import type { MeshRuntime } from "./mesh-runtime.js";

export function createMeshStatusTool(resolve: () => MeshRuntime | undefined): AnyAgentTool {
  return {
    name: "lumina_mesh_status",
    label: "Lumina Mesh Status",
    description:
      "Live state of the LUMINA-MESH/1 service: whether the loop is running, its current poll interval, " +
      "the outbound backlog (open, due now, oldest due age, dead letters, awaiting ack, by priority), " +
      "the inbound ledger (applied, failed, in-progress, needs-manual, suppressed duplicates), the inbound " +
      "cursor, messages with no registered handler, the registered topics, and the last pass and error. " +
      "Returns running:false when the mesh is not wired in this process.",
    parameters: Type.Object({}),
    async execute() {
      const runtime = resolve();
      if (!runtime) {
        return jsonResult({
          ok: true,
          running: false,
          reason:
            "the mesh runtime is not active in this process: either disabled by configuration, " +
            "or this is a discovery or CLI load rather than the live gateway",
        });
      }
      return jsonResult({ ok: true, ...(await runtime.snapshot()) });
    },
  };
}
