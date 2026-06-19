import test from "node:test";
import assert from "node:assert/strict";
import { requestsLuminaCodeDevelopment } from "../tool-proxy/lumina-code-routing.mjs";

const positives = [
  "Usa Lumina Code para corregir este bug del frontend.",
  "Crea un proyecto React con Lumina Code.",
  "Escribe un script Python que procese estos archivos.",
  "Corrige package.json y arregla el build.",
  "Lumina Code, implementa esta extension VSIX.",
  "Refactoriza src/main.ts para separar el router.",
];

const negatives = [
  "hola",
  "Dime si puedes conectarte a Lumina Code",
  "Como funciona OpenClaw?",
  "OpenClaw marca error cuando cambio de provider.",
  "Necesito investigar noticias de IA en internet.",
  "Explicame que herramientas tienes disponibles.",
  "No uses Lumina Code para esto, solo responde.",
  "Actualiza mi investigacion sobre Lumina humanoide.",
  "Crea un archivo IDENTITY.md en el workspace de Lumina.",
  "Crea con tus herramientas locales un archivo llamado .codex-bridge-test.txt con el contenido ok en el workspace de Lumina.",
];

for (const message of positives) {
  test(`delegates development request: ${message}`, () => {
    assert.equal(requestsLuminaCodeDevelopment(message), true);
  });
}

for (const message of negatives) {
  test(`keeps normal OpenClaw chat: ${message}`, () => {
    assert.equal(requestsLuminaCodeDevelopment(message), false);
  });
}
