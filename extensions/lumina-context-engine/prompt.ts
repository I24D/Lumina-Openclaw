// Builds the per-run guidance Lumina adds to the system prompt. Pure functions:
// no I/O, so the prompt path stays synchronous and testable.

export type LuminaContextEngineConfig = {
  abstention: boolean;
  wikiRouting: boolean;
  promptAppend?: string;
};

const DEFAULTS: LuminaContextEngineConfig = { abstention: true, wikiRouting: true };
// Wiki guidance is worthless when the run cannot call the wiki.
const WIKI_TOOLS = ["wiki_search", "wiki_get"];

export function normalizeLuminaContextEngineConfig(raw: unknown): LuminaContextEngineConfig {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const promptAppend = typeof record.promptAppend === "string" ? record.promptAppend.trim() : "";
  return {
    abstention: record.abstention !== false,
    wikiRouting: record.wikiRouting !== false,
    ...(promptAppend ? { promptAppend } : {}),
  };
}

export function buildLuminaSystemPromptAddition(
  config: LuminaContextEngineConfig = DEFAULTS,
  availableTools?: Set<string>,
): string | undefined {
  const sections: string[] = [];
  if (config.wikiRouting && WIKI_TOOLS.some((tool) => availableTools?.has(tool) ?? false)) {
    sections.push(
      [
        "Conocimiento curado de Lumina (Memory Wiki):",
        "- `entities/` son personas, sistemas y activos; `concepts/` son políticas y procedimientos.",
        "- Las páginas `Procedimiento: <tool>` dicen con qué frecuencia falla una herramienta y con qué error; consúltalas antes de reintentar algo que ya falló.",
        "- Una claim con `status: superseded` es el valor ANTERIOR: responde con la vigente y menciona la anterior solo si preguntan por el pasado.",
      ].join("\n"),
    );
  }
  if (config.abstention) {
    sections.push(
      [
        "Cuando la memoria no responde:",
        "- Si la búsqueda no devuelve evidencia clara, di que no lo sabes o que no está registrado. No inventes ni rellenes con suposiciones.",
        "- Un recuerdo con poca confianza se cita como tal: di de dónde sale y que puede estar desactualizado.",
      ].join("\n"),
    );
  }
  if (config.promptAppend) {
    sections.push(config.promptAppend);
  }
  return sections.length > 0 ? sections.join("\n\n") : undefined;
}
