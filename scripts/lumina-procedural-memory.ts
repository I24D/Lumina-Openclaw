import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// Distills procedural memory from what actually happened: OpenClaw's audit log
// already records every tool call with its outcome, error code and duration, so
// this turns that evidence into Memory Wiki concept pages ("how X behaves here")
// instead of trusting a conversation that merely felt successful.
//
// Each page carries claims with measured confidence, the failures worth knowing
// about, and a `notEnoughFor` warning when a tool is unreliable. Run it, then
// `openclaw wiki compile --agent <id>`.
import { DatabaseSync } from "node:sqlite";

type ToolStat = {
  tool: string;
  runs: number;
  succeeded: number;
  failed: number;
  timedOut: number;
  failures: Map<string, { count: number; lastAt: string }>;
  agents: Set<string>;
  lastAt: string;
};

const OPENCLAW_HOME = path.join(os.homedir(), ".openclaw");
const STATE_DB = path.join(OPENCLAW_HOME, "state", "openclaw.sqlite");
const DEFAULT_VAULT = path.join(OPENCLAW_HOME, "wiki", "lumina");
const DEFAULT_WINDOW_DAYS = 30;
// Below this many runs a success rate says more about luck than about the tool.
const MIN_RUNS = 5;
const UNRELIABLE_SUCCESS_RATE = 0.9;

function parseArgs(argv: string[]): { vault: string; windowDays: number; dryRun: boolean } {
  let vault = DEFAULT_VAULT;
  let windowDays = DEFAULT_WINDOW_DAYS;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--vault") {
      vault = argv[++index] ?? vault;
    } else if (arg === "--days") {
      windowDays = Number(argv[++index] ?? windowDays);
    } else if (arg === "--dry-run") {
      dryRun = true;
    }
  }
  return { vault, windowDays, dryRun };
}

function collectToolStats(windowDays: number): ToolStat[] {
  const db = new DatabaseSync(STATE_DB, { readOnly: true });
  const since = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const rows = db
    .prepare(
      `SELECT tool_name, status, error_code, reason_code, failure_stage, agent_id, occurred_at
       FROM audit_events
       WHERE kind = 'tool_action' AND action = 'tool.action.finished'
         AND tool_name IS NOT NULL AND occurred_at >= ?
       ORDER BY occurred_at`,
    )
    .all(since) as Array<Record<string, string | number | null>>;
  db.close();

  const byTool = new Map<string, ToolStat>();
  for (const row of rows) {
    const tool = String(row.tool_name);
    const entry = byTool.get(tool) ?? {
      tool,
      runs: 0,
      succeeded: 0,
      failed: 0,
      timedOut: 0,
      failures: new Map<string, { count: number; lastAt: string }>(),
      agents: new Set<string>(),
      lastAt: "",
    };
    const at = new Date(Number(row.occurred_at)).toISOString();
    entry.runs += 1;
    if (row.status === "succeeded") {
      entry.succeeded += 1;
    } else if (row.status === "timed_out") {
      entry.timedOut += 1;
    } else {
      entry.failed += 1;
    }
    if (row.status !== "succeeded") {
      // The failure label is what a future run would recognize, not a stack trace.
      const label = String(
        row.error_code ?? row.reason_code ?? row.failure_stage ?? row.status ?? "unknown",
      );
      const failure = entry.failures.get(label) ?? { count: 0, lastAt: at };
      failure.count += 1;
      failure.lastAt = at;
      entry.failures.set(label, failure);
    }
    if (row.agent_id) {
      entry.agents.add(String(row.agent_id));
    }
    entry.lastAt = at;
    byTool.set(tool, entry);
  }

  return [...byTool.values()]
    .filter((entry) => entry.runs >= MIN_RUNS)
    .toSorted((a, b) => b.runs - a.runs);
}

/** Emits YAML lines for one mapping, indented by `indent` spaces. */
function yamlMapping(object: Record<string, unknown>, indent: number): string[] {
  const pad = " ".repeat(indent);
  const lines: string[] = [];
  for (const [key, value] of Object.entries(object)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${pad}${key}: []`);
        continue;
      }
      lines.push(`${pad}${key}:`);
      for (const item of value) {
        if (item && typeof item === "object") {
          const inner = yamlMapping(item as Record<string, unknown>, indent + 4);
          lines.push(`${pad}  - ${(inner[0] ?? "").trimStart()}`, ...inner.slice(1));
        } else {
          lines.push(`${pad}  - ${JSON.stringify(item)}`);
        }
      }
      continue;
    }
    if (value && typeof value === "object") {
      lines.push(`${pad}${key}:`, ...yamlMapping(value as Record<string, unknown>, indent + 2));
      continue;
    }
    lines.push(`${pad}${key}: ${JSON.stringify(value)}`);
  }
  return lines;
}

function buildPage(stat: ToolStat, now: string, windowDays: number): string {
  const successRate = stat.succeeded / stat.runs;
  const slug = stat.tool.replaceAll(/[^a-z0-9]+/giu, "-").toLowerCase();
  const evidence = (note: string) => [
    {
      kind: "audit-log",
      sourceId: "source.openclaw.audit-events",
      note,
      confidence: Math.min(0.95, 0.5 + stat.runs / 200),
      updatedAt: now,
    },
  ];
  const topFailures = [...stat.failures.entries()].toSorted((a, b) => b[1].count - a[1].count);
  const claims = [
    {
      id: `claim.procedimiento.${slug}.tasa`,
      text: `El tool \`${stat.tool}\` se ejecutó ${stat.runs} veces en los últimos ${windowDays} días con ${(successRate * 100).toFixed(1)} % de éxito (${stat.failed} fallos, ${stat.timedOut} por tiempo agotado).`,
      status: successRate >= UNRELIABLE_SUCCESS_RATE ? "supported" : "contested",
      confidence: Math.min(0.95, 0.5 + stat.runs / 200),
      evidence: evidence(`audit_events: tool.action.finished, ${stat.runs} registros`),
      updatedAt: now,
    },
    // `duration_ms` is null for tool events in this build, so no latency claim
    // is emitted: an unmeasured 0 ms would be a false fact in the wiki.
    ...(stat.agents.size > 0
      ? [
          {
            id: `claim.procedimiento.${slug}.agentes`,
            text: `Agentes que ejecutan \`${stat.tool}\`: ${[...stat.agents].join(", ")}.`,
            status: "supported",
            confidence: 0.8,
            evidence: evidence("agent_id de audit_events"),
            updatedAt: now,
          },
        ]
      : []),
    ...topFailures.slice(0, 3).map(([label, failure]) => ({
      id: `claim.procedimiento.${slug}.fallo.${label.replaceAll(/[^a-z0-9]+/giu, "-").toLowerCase()}`,
      text: `Modo de fallo conocido de \`${stat.tool}\`: ${label} (${failure.count} veces; el último, ${failure.lastAt.slice(0, 10)}).`,
      status: "supported",
      confidence: Math.min(0.9, 0.5 + failure.count / 50),
      evidence: evidence(`audit_events: status distinto de succeeded, etiqueta ${label}`),
      updatedAt: now,
    })),
  ];

  const frontmatter: Record<string, unknown> = {
    pageType: "concept",
    id: `concept.procedimiento.${slug}`,
    canonicalId: `procedure.${slug}`,
    title: `Procedimiento: ${stat.tool}`,
    aliases: [stat.tool, `tool ${stat.tool}`, `procedimiento ${stat.tool}`],
    privacyTier: "local-private",
    sourceIds: ["source.openclaw.audit-events"],
    bestUsedFor: [`Saber si conviene reintentar \`${stat.tool}\` y qué error esperar`],
    notEnoughFor:
      successRate >= UNRELIABLE_SUCCESS_RATE
        ? []
        : [`Darlo por hecho: falla ${((1 - successRate) * 100).toFixed(0)} % de las veces`],
    claims,
    relationships: [
      {
        targetId: "entity.lumina",
        targetTitle: "Lumina",
        kind: "procedure-of",
        weight: 1,
        confidence: 0.9,
        evidenceKind: "audit-log",
        updatedAt: now,
      },
    ],
    lastRefreshedAt: now,
    updatedAt: now,
  };

  const body = [
    `Destilado del registro de auditoría el ${now.slice(0, 10)} (ventana: ${windowDays} días).`,
    "",
    "| Resultado | Veces |",
    "| --- | --- |",
    `| Éxito | ${stat.succeeded} |`,
    `| Fallo | ${stat.failed} |`,
    `| Tiempo agotado | ${stat.timedOut} |`,
    "",
    topFailures.length > 0
      ? `Fallos observados: ${topFailures.map(([label, f]) => `${label} (${f.count})`).join(", ")}.`
      : "Sin fallos registrados en la ventana.",
  ].join("\n");

  return `---\n${yamlMapping(frontmatter, 0).join("\n")}\n---\n\n# Procedimiento: ${stat.tool}\n\n${body}\n`;
}

function buildSourcePage(now: string, windowDays: number, tools: number): string {
  const frontmatter: Record<string, unknown> = {
    pageType: "source",
    id: "source.openclaw.audit-events",
    title: "Registro de auditoría de OpenClaw",
    sourceType: "audit-log",
    sourcePath: STATE_DB,
    status: "active",
    updatedAt: now,
  };
  const body = [
    `Tabla \`audit_events\` de \`state/openclaw.sqlite\`: una fila por llamada de herramienta,`,
    `con resultado, código de error y duración. Destilada el ${now.slice(0, 10)}`,
    `sobre ${windowDays} días y ${tools} herramientas.`,
  ].join(" ");
  return `---\n${yamlMapping(frontmatter, 0).join("\n")}\n---\n\n# Registro de auditoría de OpenClaw\n\n${body}\n`;
}

const args = parseArgs(process.argv.slice(2));
const now = new Date().toISOString();
const stats = collectToolStats(args.windowDays);
if (stats.length === 0) {
  console.log(`No tool outcomes in the last ${args.windowDays} days.`);
  process.exit(0);
}
if (args.dryRun) {
  for (const stat of stats) {
    console.log(
      `${stat.tool}: ${stat.runs} runs, ${((stat.succeeded / stat.runs) * 100).toFixed(1)}% ok, failures: ${[...stat.failures.keys()].join(", ") || "none"}`,
    );
  }
  process.exit(0);
}

fs.mkdirSync(path.join(args.vault, "concepts"), { recursive: true });
fs.mkdirSync(path.join(args.vault, "sources"), { recursive: true });
fs.writeFileSync(
  path.join(args.vault, "sources", "openclaw-audit-events.md"),
  buildSourcePage(now, args.windowDays, stats.length),
);
for (const stat of stats) {
  const slug = stat.tool.replaceAll(/[^a-z0-9]+/giu, "-").toLowerCase();
  fs.writeFileSync(
    path.join(args.vault, "concepts", `procedimiento-${slug}.md`),
    buildPage(stat, now, args.windowDays),
  );
}
console.log(
  `Wrote ${stats.length} procedure pages to ${path.join(args.vault, "concepts")}. Run: openclaw wiki compile --agent <id>`,
);
