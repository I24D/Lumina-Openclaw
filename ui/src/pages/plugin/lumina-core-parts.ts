/**
 * lumina-core-parts.ts — The small building blocks every view of the Lumina tab shares:
 * cards, tables, chips, times and command buttons.
 */
import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { getCoreState, runLuminaCoreCommand } from "./lumina-core-controller.ts";

export type ControllerState = ReturnType<typeof getCoreState>;
export type Column<T> = readonly [label: string, cell: (row: T) => unknown];
export type Variant = "primary" | "danger" | "";

export const clock = (iso: string | undefined) => (iso ? iso.slice(11, 19) : "—");

export function table<T>(
  rows: ReadonlyArray<T>,
  columns: ReadonlyArray<Column<T>>,
): TemplateResult {
  if (rows.length === 0) {
    return html`<p class="muted">—</p>`;
  }
  return html`
    <div class="data-table-container">
      <table class="data-table">
        <thead>
          <tr>
            ${columns.map(([label]) => html`<th>${label}</th>`)}
          </tr>
        </thead>
        <tbody>
          ${rows.map(
            (row) =>
              html`<tr>
                ${columns.map(([, cell]) => html`<td>${cell(row)}</td>`)}
              </tr>`,
          )}
        </tbody>
      </table>
    </div>
  `;
}

export function chip(label: string, ok: boolean): TemplateResult {
  return html`<span class="chip ${ok ? "chip-ok" : "chip-warn"}">${label}</span>`;
}

export function card(title: string, body: unknown, sub?: string): TemplateResult {
  return html`
    <section class="card lumina-core__card">
      <div class="card-title">${title}</div>
      ${sub ? html`<div class="card-sub">${sub}</div>` : nothing} ${body}
    </section>
  `;
}

export function makeAction(state: ControllerState, client: GatewayBrowserClient | null) {
  return (
    label: string,
    method: string,
    params: Record<string, unknown> = {},
    variant: Variant = "",
  ) =>
    html`<button
      class="btn btn--sm ${variant}"
      type="button"
      ?disabled=${state.pending !== null}
      @click=${() => void runLuminaCoreCommand(state, client, method, params)}
    >
      ${label}
    </button>`;
}

export type Action = ReturnType<typeof makeAction>;
