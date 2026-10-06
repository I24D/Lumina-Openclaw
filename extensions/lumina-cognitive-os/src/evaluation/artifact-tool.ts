/**
 * artifact-tool.ts — Tool: lumina_artifacts.
 *
 * "¿Qué modelos usas y de dónde salen?": lists Lumina's own models and
 * datasets with source, licence, version, purpose and pinned hash, checks them
 * against those hashes, and records a new dataset kept for Lumina's learning.
 */
import { Type } from "typebox";
import { jsonResult, ToolInputError, type AnyAgentTool } from "../shared/tool-result.js";
import type { ArtifactRegistry } from "./artifact-registry.js";

const ARTIFACT_ACTIONS = ["list", "verify", "register_dataset"] as const;

export function createArtifactTool(registry: ArtifactRegistry): AnyAgentTool {
  return {
    name: "lumina_artifacts",
    label: "Lumina Artifacts",
    description:
      "Lumina's own models and datasets: 'list' gives source, licence, version, purpose and the pinned " +
      "SHA-256 of each; 'verify' re-hashes them and reports any that changed or went missing (a person " +
      "decides what to do; nothing is deleted or re-downloaded); 'register_dataset' records a dataset kept " +
      "for Lumina's learning (name, path, source, license, version, purpose).",
    parameters: Type.Object({
      action: Type.Union(
        ARTIFACT_ACTIONS.map((a) => Type.Literal(a)),
        { default: "list" },
      ),
      name: Type.Optional(Type.String({ maxLength: 160 })),
      path: Type.Optional(Type.String({ maxLength: 1024 })),
      source: Type.Optional(Type.String({ maxLength: 1024 })),
      license: Type.Optional(Type.String({ maxLength: 160 })),
      version: Type.Optional(Type.String({ maxLength: 80 })),
      purpose: Type.Optional(Type.String({ maxLength: 500 })),
    }),
    async execute(_id, rawParams) {
      const p = rawParams as {
        action?: (typeof ARTIFACT_ACTIONS)[number];
        name?: string;
        path?: string;
        source?: string;
        license?: string;
        version?: string;
        purpose?: string;
      };
      switch (p.action ?? "list") {
        case "list":
          await registry.ready;
          return jsonResult({ ok: true, artifacts: registry.list(), checks: registry.checks() });
        case "verify":
          return jsonResult({ ok: true, checks: await registry.verifyAll() });
        case "register_dataset": {
          const field = (value: string | undefined, name: string) => {
            if (!value?.trim()) {
              throw new ToolInputError(`${name} is required for register_dataset`);
            }
            return value.trim();
          };
          try {
            const check = await registry.register({
              kind: "dataset",
              name: field(p.name, "name"),
              path: field(p.path, "path"),
              source: field(p.source, "source"),
              license: field(p.license, "license"),
              version: field(p.version, "version"),
              purpose: field(p.purpose, "purpose"),
            });
            return jsonResult({ ok: true, artifact: check });
          } catch (error) {
            if (error instanceof ToolInputError) {
              throw error;
            }
            return jsonResult({ ok: false, error: `Cannot read ${p.path}: ${String(error)}` });
          }
        }
        default:
          throw new ToolInputError(`Unknown action: ${String(p.action)}`);
      }
    },
  };
}
