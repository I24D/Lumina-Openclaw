import { html, nothing } from "lit";
import type { AppViewState } from "../app-view-state.ts";
import { icons } from "../icons.ts";

function statusLabel(ready: boolean | undefined, readyText: string, missingText: string): string {
  if (ready === undefined) {
    return "Pendiente";
  }
  return ready ? readyText : missingText;
}

export function renderLuminaCode(state: AppViewState) {
  const status = state.luminaCodeStatus;
  const vscodeReady = status?.vscode.available;
  const vsixReady = status?.extension.vsixAvailable;
  const canOpen = !state.luminaCodeOpening && vscodeReady !== false && vsixReady !== false;

  return html`
    <section class="lumina-code-page stack">
      <div class="card lumina-code-hero">
        <div class="lumina-code-hero__icon" aria-hidden="true">${icons.fileCode}</div>
        <div class="lumina-code-hero__body">
          <p class="lumina-code-hero__eyebrow">Lumina Code</p>
          <h2 class="lumina-code-hero__title">Conecta OpenClaw con VS Code</h2>
          <p class="lumina-code-hero__text">
            Abre VS Code, instala la extensión Lumina Code incluida en el runtime y deja
            listo el panel de Lumina Code para trabajar sobre el workspace local.
          </p>
          <div class="row lumina-code-actions">
            <button
              type="button"
              class="btn primary"
              ?disabled=${state.luminaCodeOpening || state.luminaCodeStatusLoading || !canOpen}
              @click=${() => state.openLuminaCode()}
            >
              ${state.luminaCodeOpening ? "Abriendo..." : "Abrir Lumina Code"}
            </button>
            <button
              type="button"
              class="btn"
              ?disabled=${state.luminaCodeStatusLoading}
              @click=${() => state.loadLuminaCodeStatus()}
            >
              ${state.luminaCodeStatusLoading ? "Revisando..." : "Revisar estado"}
            </button>
          </div>
        </div>
      </div>

      ${state.luminaCodeError
        ? html`<div class="callout danger" role="alert">${state.luminaCodeError}</div>`
        : nothing}
      ${state.luminaCodeMessage
        ? html`<div class="callout success" role="status">${state.luminaCodeMessage}</div>`
        : nothing}

      <div class="grid grid-cols-3 lumina-code-status-grid">
        <div class="card">
          <div class="card-title">VS Code</div>
          <p class="card-sub">
            ${statusLabel(vscodeReady, "Detectado", "No detectado")}
          </p>
          ${status?.vscode.executablePath
            ? html`<p class="lumina-code-path">${status.vscode.executablePath}</p>`
            : nothing}
        </div>
        <div class="card">
          <div class="card-title">Extensión Lumina</div>
          <p class="card-sub">
            ${statusLabel(vsixReady, "VSIX listo", "VSIX no incluido")}
          </p>
          ${status?.extension.version
            ? html`<p class="lumina-code-path">${status.extension.id} v${status.extension.version}</p>`
            : nothing}
        </div>
        <div class="card">
          <div class="card-title">Workspace</div>
          <p class="card-sub">${status?.workspace.exists ? "Existe" : "Se creará al abrir"}</p>
          ${status?.workspace.path
            ? html`<p class="lumina-code-path">${status.workspace.path}</p>`
            : nothing}
        </div>
      </div>

      <div class="callout info">
        Si VS Code no está instalado, instala VS Code 1.85 o superior. Después vuelve a esta sección
        y pulsa “Abrir Lumina Code”; Lumina instalará la extensión incluida automáticamente.
      </div>
    </section>
  `;
}
