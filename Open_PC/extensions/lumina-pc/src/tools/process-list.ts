/**
 * process-list.ts
 * Tool: lumina_process_list
 *
 * Lists running processes on the Windows PC via PowerShell.
 * Allows I24D to observe what the user has open and detect anomalies.
 */

import { Type } from "@sinclair/typebox";
import { jsonResult } from "../../../../src/agents/tools/common.js";
import type { AnyAgentTool } from "../../../../src/agents/tools/common.js";
import { psEscape, runPowerShell } from "../utils/powershell.js";

export function createProcessListTool(): AnyAgentTool {
  return {
    name: "lumina_process_list",
    description:
      "Lists running processes on the Windows PC with name, PID, CPU and memory usage. " +
      "Optionally filter by name. Use this for I24D to monitor what is running or to find a specific process.",
    parameters: Type.Object({
      filter: Type.Optional(
        Type.String({
          description: "Filter processes by name (partial match, case-insensitive). Leave empty for all.",
        }),
      ),
      top: Type.Optional(
        Type.Number({
          description: "Return only the top N processes sorted by CPU usage. Default: 50.",
          minimum: 1,
          maximum: 500,
        }),
      ),
      sort_by: Type.Optional(
        Type.Union([Type.Literal("cpu"), Type.Literal("memory"), Type.Literal("name")], {
          description: "Sort by cpu | memory | name. Default: cpu.",
        }),
      ),
    }),
    async execute(_toolCallId: string, params) {
      if (process.platform !== "win32") {
        return jsonResult({ ok: false, error: "lumina_process_list is only available on Windows." });
      }

      const top = Math.min(params.top ?? 50, 500);
      const sortBy = params.sort_by ?? "cpu";
      const sortProp = sortBy === "memory" ? "WorkingSet64" : sortBy === "name" ? "ProcessName" : "CPU";
      const sortDir = sortBy === "name" ? "-Ascending" : "-Descending";

      const filterClause = params.filter?.trim()
        ? `| Where-Object { $_.ProcessName -like "*${psEscape(params.filter.trim())}*" } `
        : "";

      const psCmd =
        `Get-Process ${filterClause}` +
        `| Sort-Object ${sortProp} ${sortDir} ` +
        `| Select-Object -First ${top} ` +
        `| Select-Object ProcessName, Id, CPU, ` +
        `@{N='MemoryMB';E={[Math]::Round($_.WorkingSet64/1MB,1)}}, ` +
        `@{N='Status';E={$_.Responding}} ` +
        `| ConvertTo-Json -Compress`;

      const result = await runPowerShell(psCmd, 15_000);

      if (!result.ok) {
        return jsonResult({ ok: false, error: result.error ?? result.stderr });
      }

      let processes: unknown[] = [];
      try {
        const parsed = JSON.parse(result.stdout);
        processes = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        processes = [];
      }

      return jsonResult({
        ok: true,
        count: processes.length,
        sort_by: sortBy,
        filter: params.filter ?? null,
        processes,
        timestamp: new Date().toISOString(),
      });
    },
  };
}
