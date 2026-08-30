import { describe, expect, it } from "vitest";
import { renderLuminaOpenDesignUi } from "./ui.js";

function inlineScript(): string {
  const html = renderLuminaOpenDesignUi();
  const match = html.match(/<script>([\s\S]*?)<\/script>/u);
  expect(match, "the panel must ship exactly one inline script").not.toBeNull();
  return match![1]!;
}

describe("lumina-open-design panel", () => {
  // The panel is a template literal, so its browser script is opaque to the
  // type checker: a stray "\n" resolves while rendering and lands as a real
  // newline inside a single-quoted JS string. That leaves the whole <script>
  // unparsable, which silently kills every listener in it rather than failing
  // any build step.
  it("emits a browser script the engine can parse", () => {
    expect(() => new Function(inlineScript())).not.toThrow();
  });

  it("wires the controls the operator clicks", () => {
    const html = renderLuminaOpenDesignUi();
    const script = inlineScript();
    for (const id of ["themeButton", "studioButton", "syncButton", "submitButton"]) {
      expect(html, `${id} must exist in the markup`).toContain(`id="${id}"`);
    }
    for (const id of ["themeButton", "studioButton", "syncButton"]) {
      expect(script, `${id} must be bound`).toContain(`$('${id}').addEventListener`);
    }
  });
});
