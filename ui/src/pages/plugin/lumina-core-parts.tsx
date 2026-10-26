/**
 * lumina-core-parts.tsx — The small building blocks every view of the Lumina tab shares:
 * cards, tables, chips, times and command buttons.
 */
import type { JSX } from "@solidjs/web";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { getCoreState, runLuminaCoreCommand } from "./lumina-core-controller.ts";

export type ControllerState = ReturnType<typeof getCoreState>;
export type Column<T> = readonly [label: string, cell: (row: T) => JSX.Element];
export type Variant = "primary" | "danger" | "";

export const clock = (iso: string | undefined) => (iso ? iso.slice(11, 19) : "—");

export function table<T>(rows: ReadonlyArray<T>, columns: ReadonlyArray<Column<T>>): JSX.Element {
  if (rows.length === 0) {
    return <p class="muted">—</p>;
  }
  return (
    <div class="data-table-container">
      <table class="data-table">
        <thead>
          <tr>
            {columns.map(([label]) => (
              <th>{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr>
              {columns.map(([, cell]) => (
                <td>{cell(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function chip(label: string, ok: boolean): JSX.Element {
  return <span class={`chip ${ok ? "chip-ok" : "chip-warn"}`}>{label}</span>;
}

export function card(title: string, body: JSX.Element, sub?: string): JSX.Element {
  return (
    <section class="card lumina-core__card">
      <div class="card-title">{title}</div>
      {sub ? <div class="card-sub">{sub}</div> : null}
      {body}
    </section>
  );
}

export function makeAction(state: ControllerState, client: GatewayBrowserClient | null) {
  return (
    label: string,
    method: string,
    params: Record<string, unknown> = {},
    variant: Variant = "",
  ): JSX.Element => (
    <button
      class={variant ? `btn btn--sm ${variant}` : "btn btn--sm"}
      type="button"
      disabled={state.pending !== null}
      onClick={() => void runLuminaCoreCommand(state, client, method, params)}
    >
      {label}
    </button>
  );
}

export type Action = ReturnType<typeof makeAction>;
