/**
 * <lumina-tool-terminal>
 *
 * LitElement que renderiza el output de un tool en una vista tipo terminal
 * (xterm.js) con colores ANSI, scrollback y selección de texto. Se usa en
 * tool-cards.ts en lugar del `<pre>` plano cuando hay output de tools como
 * `lumina_shell_run`, `lumina_file_ops`, MCPs (`fetch`, `github`, etc.).
 *
 * Diseño seguro: si xterm falla al cargar/inicializar (e.g. ambiente sin DOM,
 * carga en SSR, dimensiones cero), caemos al render `<pre>` clásico — no
 * rompe nada que ya esté funcionando.
 *
 * El `text` se establece como propiedad; al cambiar, el contenido se reescribe
 * completo (no se appendea — los tool outputs llegan completos en una sola
 * pieza desde el agent runtime).
 */

import { html, LitElement, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { boundToolOutputForRender } from "./tool-helpers.ts";

type Terminal = import("@xterm/xterm").Terminal;
type FitAddon = import("@xterm/addon-fit").FitAddon;

const DEFAULT_ROWS = 18;
const MIN_ROWS = 6;
const MAX_ROWS = 40;
const CHAR_HEIGHT_PX = 17;

const TERMINAL_THEME = {
  background: "#0e1015",
  foreground: "#e0e0e0",
  cursor: "#888",
  selectionBackground: "#3a3a3a",
  selectionForeground: "#ffffff",
  black: "#0e1015",
  red: "#ff5555",
  green: "#50fa7b",
  yellow: "#f1fa8c",
  blue: "#6272a4",
  magenta: "#ff79c6",
  cyan: "#8be9fd",
  white: "#f8f8f2",
  brightBlack: "#6272a4",
  brightRed: "#ff6e6e",
  brightGreen: "#69ff94",
  brightYellow: "#ffffa5",
  brightBlue: "#d6acff",
  brightMagenta: "#ff92df",
  brightCyan: "#a4ffff",
  brightWhite: "#ffffff",
};

@customElement("lumina-tool-terminal")
export class LuminaToolTerminal extends LitElement {
  /** Output del tool a renderizar. Cualquier cambio reescribe el buffer. */
  @property({ type: String }) text = "";

  /** Nombre del tool (sólo para aria-label / debug). */
  @property({ type: String, attribute: "tool-name" }) toolName = "";

  /** Fuerza fallback al render <pre> sin tocar xterm. Útil para tests. */
  @property({ type: Boolean, attribute: "force-fallback", reflect: true })
  forceFallback = false;

  @state() private hasFallenBack = false;

  private terminal: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private initPromise: Promise<void> | null = null;

  /** Renderizamos en light DOM para que los estilos globales lleguen al contenedor. */
  override createRenderRoot() {
    return this;
  }

  override render() {
    if (this.forceFallback || this.hasFallenBack) {
      return html`<pre
        class="chat-tool-card__block-content lumina-tool-terminal__fallback"
      ><code>${this.text}</code></pre>`;
    }
    return html`
      <div
        class="lumina-tool-terminal"
        role="region"
        aria-label=${`Output of ${this.toolName || "tool"}`}
        style=${`min-height:${MIN_ROWS * CHAR_HEIGHT_PX}px;`}
      ></div>
    `;
  }

  override updated(changed: PropertyValues<this>) {
    if (this.forceFallback || this.hasFallenBack) {
      return;
    }
    if (changed.has("text") || !this.terminal) {
      void this.ensureTerminal().then(() => this.writeText());
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    try {
      this.terminal?.dispose();
    } catch {
      // ignorar — el dispose puede fallar si el DOM ya fue arrancado
    }
    this.terminal = null;
    this.fitAddon = null;
    this.initPromise = null;
  }

  private async ensureTerminal(): Promise<void> {
    if (this.terminal || this.initPromise) {
      return this.initPromise ?? Promise.resolve();
    }
    this.initPromise = this.bootstrapTerminal();
    return this.initPromise;
  }

  private async bootstrapTerminal(): Promise<void> {
    // Si no estamos en un entorno con DOM (SSR/test sin jsdom), fallback.
    if (typeof window === "undefined" || typeof document === "undefined") {
      this.hasFallenBack = true;
      return;
    }
    try {
      const [{ Terminal: TerminalCtor }, { FitAddon: FitAddonCtor }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      const host = this.querySelector<HTMLDivElement>(".lumina-tool-terminal");
      if (!host) {
        this.hasFallenBack = true;
        return;
      }
      const rows = this.estimateRows(this.text);
      const terminal = new TerminalCtor({
        rows,
        cols: 100,
        scrollback: 5000,
        cursorBlink: false,
        disableStdin: true,
        convertEol: true,
        fontFamily:
          "ui-monospace, 'JetBrains Mono', SFMono-Regular, Menlo, Consolas, 'Cascadia Mono', monospace",
        fontSize: 13,
        lineHeight: 1.25,
        theme: TERMINAL_THEME,
        allowProposedApi: true,
      });
      const fit = new FitAddonCtor();
      terminal.loadAddon(fit);
      terminal.open(host);
      try {
        fit.fit();
      } catch {
        // dimensiones no listas todavía — el observer las ajusta luego
      }
      this.terminal = terminal;
      this.fitAddon = fit;

      // Re-fit cuando el contenedor cambia de tamaño (chat collapsible, sidebar, etc.)
      if (typeof ResizeObserver !== "undefined") {
        this.resizeObserver = new ResizeObserver(() => {
          try {
            this.fitAddon?.fit();
          } catch {
            // ignorar — fit puede tirar si el elemento aún no está visible
          }
        });
        this.resizeObserver.observe(host);
      }
    } catch (err) {
      console.warn("[lumina-tool-terminal] xterm init failed, falling back to <pre>", err);
      this.hasFallenBack = true;
    }
  }

  private writeText() {
    if (!this.terminal) return;
    const text = boundToolOutputForRender(this.text ?? "");
    // Reset full y re-write — los outputs llegan en una sola pieza.
    this.terminal.reset();
    if (!text) return;
    // xterm necesita \r\n para newlines en modo no-stdin
    const normalized = text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
    this.terminal.write(normalized);
    // Auto-ajustar filas al contenido (sin pasar de MAX_ROWS) para no
    // ocupar pantalla entera cuando el output es corto.
    const rows = this.estimateRows(text);
    try {
      this.terminal.resize(this.terminal.cols, rows);
      this.fitAddon?.fit();
    } catch {
      // resize puede fallar si el host se desmontó
    }
  }

  private estimateRows(text: string): number {
    if (!text) return MIN_ROWS;
    const lineCount = text.split(/\r?\n/).length;
    return Math.min(MAX_ROWS, Math.max(MIN_ROWS, Math.min(lineCount + 1, DEFAULT_ROWS + 4)));
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lumina-tool-terminal": LuminaToolTerminal;
  }
}
