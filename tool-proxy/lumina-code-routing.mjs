function normalizeRoutingText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2019\u2018]/g, "'")
    .toLowerCase()
    .trim();
}

const LUMINA_CODE_TARGET_RE = /\b(?:lumina\s*code|vs\s*code|vscode|vsc)\b/;

const OPT_OUT_RE =
  /\b(?:no\s+(?:uses?|usar|utilices?|utilizar)|sin\s+usar|do\s+not\s+use|don't\s+use|dont\s+use)\s+(?:a\s+)?(?:lumina\s*code|vs\s*code|vscode)\b/;

const EXPLICIT_DELEGATION_RE =
  /\b(?:usa|usar|utiliza|utilizar|envia|enviar|manda|mandar|delega|delegar|abre|abrir|lanza|lanzar|use|send|delegate|open|launch)\w*\b[\s\S]{0,180}\b(?:lumina\s*code|vs\s*code|vscode|vsc)\b/;

const CODE_ACTION_RE =
  /\b(?:desarrolla|desarrollar|implementa|implementar|programa|programar|codifica|codificar|refactoriza|refactorizar|depura|depurar|debug|corrige|corregir|arregla|arreglar|fix|crea|crear|create|write|escribe|escribir|edita|editar|modifica|modificar|actualiza|actualizar|ejecuta|ejecutar|run|build|compila|compilar|testea|testear|prueba|probar)\w*\b/;

const CODE_ARTIFACT_RE =
  /\b(?:codigo|code|script|snippet|programa|software|app|aplicacion|frontend|backend|api|repo|repositorio|repository|funcion|function|componente|component|extension|vsix|package\.json|cargo\.toml|typescript|javascript|python|rust|node|react|tauri|electron|css|html|sql|stack\s*trace)\b|\b\w+\.(?:js|jsx|ts|tsx|mjs|cjs|py|rs|go|java|cs|cpp|c|h|json|toml|yaml|yml|css|html|sql)\b/;

const TARGETED_ACTION_RE =
  /\b(?:lumina\s*code|vs\s*code|vscode|vsc)\b[\s\S]{0,180}\b(?:desarrolla|desarrollar|implementa|implementar|programa|programar|codifica|codificar|refactoriza|refactorizar|depura|depurar|debug|corrige|corregir|arregla|arreglar|fix|crea|crear|create|write|escribe|escribir|edita|editar|modifica|modificar|actualiza|actualizar|ejecuta|ejecutar|run|build|compila|compilar|testea|testear|prueba|probar)\w*\b/;

const META_QUESTION_RE =
  /^(?:dime|cuentame|explica|explicame|como|que|cual|puedes|podrias|sabes|tienes|hay|existe|how|what|can|could)\b/;

export function requestsLuminaCodeDevelopment(message) {
  const text = normalizeRoutingText(message);
  if (!text || text.startsWith("/")) {
    return false;
  }

  if (OPT_OUT_RE.test(text)) {
    return false;
  }

  const mentionsLuminaCode = LUMINA_CODE_TARGET_RE.test(text);
  const hasCodeAction = CODE_ACTION_RE.test(text);
  const hasCodeArtifact = CODE_ARTIFACT_RE.test(text);
  const explicitDelegation = EXPLICIT_DELEGATION_RE.test(text);
  const targetedAction = TARGETED_ACTION_RE.test(text);

  if (explicitDelegation || targetedAction) {
    return true;
  }

  if (META_QUESTION_RE.test(text) && !hasCodeAction) {
    return false;
  }

  if (mentionsLuminaCode && hasCodeAction && hasCodeArtifact) {
    return true;
  }

  return hasCodeAction && hasCodeArtifact;
}
