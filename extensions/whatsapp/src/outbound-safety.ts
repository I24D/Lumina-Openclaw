// Whatsapp plugin module protects outbound text from provider reasoning leaks.

export type WhatsAppOutboundTextSafetyResult =
  | { action: "send"; text: string; filtered: boolean }
  | { action: "suppress" };

const SILENT_REPLY_RE = /^\s*NO_REPLY\s*$/i;
const REASONING_LABEL_RE = /^\s*(?:analysis|reasoning|thinking|internal monologue)\s*:?\s*$/i;
const REASONING_TAG_RE = /<\/?\s*(?:analysis|reasoning|think(?:ing)?|thought)\b[^>]*>/i;
const DELIBERATION_LEAD_RE =
  /^\s*(?:wait|okay|ok|hmm|hold on|let me think|primero|espera|un momento|d[e\u00e9]jame|perm[i\u00ed]teme)\b/i;

const OBSERVATION_PATTERNS = [
  /\b(?:she|he|they|the user|user|sender|contact)(?:'s|\s+is|\s+are|\s+was|\s+were)?\s+(?:saying|asking|responding|being|feeling|seems?|wants?|means?|mentions?|confirms?)\b/i,
  /\bnow i (?:have|see|understand) (?:more|the) context\b/i,
  /\bthe (?:conversation|exchange|message|context) (?:is|was|feels?|shows?|suggests?)\b/i,
  /\bthis is (?:a |an )?(?:genuine|warm|sweet|positive|casual|friendly)\b/i,
  /\b(?:el contacto|la persona|el usuario|la usuaria)(?:\s+es|\s+est[a\u00e1]|\s+dice|\s+dijo|\s+pregunta|\s+responde|\s+respondi[o\u00f3]|\s+parece|\s+quiere|\s+menciona|\s+confirma)\b/i,
  /\bahora (?:tengo|veo|entiendo) (?:m[a\u00e1]s|el) contexto\b/i,
  /\b(?:la conversaci[o\u00f3]n|el mensaje|el contexto) (?:es|fue|parece|muestra|sugiere)\b/i,
];

const RESPONSE_PLANNING_PATTERNS = [
  /\blet me (?:respond|reply|answer|keep|say|write|phrase|acknowledge|handle|look|check|re-?examine)\b/i,
  /\bi (?:should|need to|will|can) (?:respond|reply|answer|keep|say|write|phrase|acknowledge|handle|look|check|re-?examine)\b/i,
  /\b(?:respond|reply|answer) naturally\b/i,
  /\bkeep (?:it|the (?:reply|response)) (?:casual|warm|simple|short|friendly|natural)\b/i,
  /\b(?:d[e\u00e9]jame|perm[i\u00ed]teme) (?:responder|contestar|buscar|verificar|revisar|archivar|comprobar|decir|escribir|formular)\b/i,
  /\b(?:debo|necesito|voy a|puedo) (?:responder|contestar|buscar|verificar|revisar|archivar|comprobar|decir|escribir|formular)\b/i,
  /\b(?:respuesta|contestaci[o\u00f3]n) (?:corta|breve|casual|c[a\u00e1]lida|amigable|natural)\b/i,
  /\b(?:responder|contestar) (?:naturalmente|brevemente|de forma (?:casual|c[a\u00e1]lida|amigable|natural))\b/i,
];

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function isLikelyInternalReasoning(text: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.some((line) => REASONING_LABEL_RE.test(line)) || REASONING_TAG_RE.test(text)) {
    return true;
  }
  const plansResponse = matchesAny(text, RESPONSE_PLANNING_PATTERNS);
  return (
    (matchesAny(text, OBSERVATION_PATTERNS) && plansResponse) ||
    (DELIBERATION_LEAD_RE.test(text) && plansResponse)
  );
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\r?\n[ \t]*\r?\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Removes high-confidence provider monologue prefixes from WhatsApp text.
 * Ambiguous text is preserved; recognized reasoning without a separable final
 * answer is suppressed so internal analysis cannot reach a contact.
 */
export function sanitizeWhatsAppOutboundText(text: string): WhatsAppOutboundTextSafetyResult {
  const trimmed = text.trim();
  if (!trimmed) {
    return { action: "send", text, filtered: false };
  }
  if (SILENT_REPLY_RE.test(trimmed)) {
    return { action: "suppress" };
  }

  const paragraphs = splitParagraphs(trimmed);
  for (let answerStart = 1; answerStart < paragraphs.length; answerStart += 1) {
    const prefix = paragraphs.slice(0, answerStart).join("\n\n");
    const answer = paragraphs.slice(answerStart).join("\n\n").trim();
    if (
      isLikelyInternalReasoning(prefix) &&
      answer &&
      !SILENT_REPLY_RE.test(answer) &&
      !isLikelyInternalReasoning(answer)
    ) {
      return { action: "send", text: answer, filtered: true };
    }
  }

  if (isLikelyInternalReasoning(trimmed)) {
    return { action: "suppress" };
  }
  return { action: "send", text, filtered: false };
}
