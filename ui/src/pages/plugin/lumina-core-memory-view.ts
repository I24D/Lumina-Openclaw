/**
 * lumina-core-memory-view.ts — The Memory view of the Lumina tab (Lumina spec §68).
 *
 * Search what Lumina remembers, see where each memory came from and how sure
 * it is, and correct it: confirm or contradict a lesson, archive or restore
 * it, forget a lesson, an episode or a thing, and merge two things that are
 * the same. Searching filters what the core sent; every change is an owner
 * command over the gateway.
 */
import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";
import {
  card,
  chip,
  clock,
  table,
  type Action,
  type ControllerState,
} from "./lumina-core-parts.ts";
import type { CoreStatePayload } from "./lumina-core-types.ts";

const matches = (query: string, ...fields: ReadonlyArray<string>) =>
  !query || fields.some((field) => field.toLowerCase().includes(query));

/** Groups of things sharing a label: candidates to merge. */
function duplicates(entities: NonNullable<CoreStatePayload["memory"]>["entities"]) {
  const byLabel = new Map<string, typeof entities>();
  for (const entity of entities) {
    const key = `${entity.kind}:${entity.label.trim().toLowerCase()}`;
    byLabel.set(key, [...(byLabel.get(key) ?? []), entity]);
  }
  return [...byLabel.values()].filter((group) => group.length > 1);
}

export function renderMemory(
  s: CoreStatePayload,
  act: Action,
  state: ControllerState,
): TemplateResult {
  const memory = s.memory;
  if (!memory) {
    return html`<p class="muted">${t("luminaCore.memory.unavailable")}</p>`;
  }
  const query = state.memoryQuery.trim().toLowerCase();
  const lessons = memory.lessons.filter((l) => matches(query, l.trigger, l.claim));
  const episodes = memory.episodes.filter((e) => matches(query, e.summary, e.kind, ...e.tags));
  const entities = memory.entities.filter((e) => matches(query, e.label, e.kind, e.origin));
  const beliefs = memory.beliefs.filter((b) => matches(query, b.proposition, b.holderId));
  const pairs = duplicates(memory.entities);
  return html`
    <label class="lumina-core__search">
      <span class="muted">${t("luminaCore.memory.search")}</span>
      <input
        type="search"
        .value=${state.memoryQuery}
        placeholder=${t("luminaCore.memory.searchPlaceholder")}
        @input=${(event: Event) => {
          state.memoryQuery = (event.target as HTMLInputElement).value;
          state.requestUpdate?.();
        }}
      />
    </label>
    ${card(
      t("luminaCore.memory.lessons"),
      table(lessons, [
        [t("luminaCore.memory.when"), (l) => l.trigger],
        [t("luminaCore.memory.claim"), (l) => l.claim],
        [t("luminaCore.columns.confidence"), (l) => l.confidence.toFixed(2)],
        [
          t("luminaCore.memory.origin"),
          (l) => (l.archived ? chip(t("luminaCore.memory.archived"), false) : l.origin),
        ],
        [
          "",
          (l) => html`<div class="lumina-core__actions">
            ${act(t("luminaCore.memory.confirm"), "lumina.core.memory.lesson", { id: l.id, action: "confirm" })}
            ${act(t("luminaCore.memory.contradict"), "lumina.core.memory.lesson", { id: l.id, action: "contradict" })}
            ${
              l.archived
                ? act(t("luminaCore.memory.restore"), "lumina.core.memory.lesson", {
                    id: l.id,
                    action: "restore",
                  })
                : act(t("luminaCore.memory.archive"), "lumina.core.memory.lesson", {
                    id: l.id,
                    action: "archive",
                  })
            }
            ${act(t("luminaCore.memory.forget"), "lumina.core.memory.lesson", { id: l.id, action: "forget" }, "danger")}
          </div>`,
        ],
      ]),
      t("luminaCore.memory.lessonsHint"),
    )}
    ${card(
      t("luminaCore.memory.episodes"),
      table(episodes, [
        [t("luminaCore.columns.time"), (e) => clock(e.atISO)],
        [t("luminaCore.columns.kind"), (e) => e.kind],
        [t("luminaCore.columns.what"), (e) => e.summary],
        [
          "",
          (e) =>
            act(
              t("luminaCore.memory.forget"),
              "lumina.core.memory.episode.forget",
              { id: e.id },
              "danger",
            ),
        ],
      ]),
    )}
    ${card(
      t("luminaCore.memory.things"),
      html`${
        pairs.length > 0
          ? html`<div class="lumina-core__actions">
              ${pairs.map(([keep, ...rest]) =>
                rest.map((drop) =>
                  act(
                    t("luminaCore.memory.merge", { drop: drop.label, keep: keep?.label ?? "" }),
                    "lumina.core.world.merge",
                    { keepId: keep?.id, dropId: drop.id },
                  ),
                ),
              )}
            </div>`
          : nothing
      }
      ${table(entities, [
        [t("luminaCore.columns.name"), (e) => e.label],
        [t("luminaCore.columns.kind"), (e) => e.kind],
        [t("luminaCore.memory.origin"), (e) => e.origin],
        [t("luminaCore.columns.confidence"), (e) => e.confidence.toFixed(2)],
        [t("luminaCore.columns.time"), (e) => clock(e.lastSeenISO)],
        [
          "",
          (e) =>
            act(t("luminaCore.memory.forget"), "lumina.core.world.forget", { id: e.id }, "danger"),
        ],
      ])}`,
      t("luminaCore.memory.thingsHint"),
    )}
    ${card(
      t("luminaCore.memory.beliefs"),
      table(beliefs, [
        [t("luminaCore.memory.who"), (b) => b.holderId],
        [t("luminaCore.memory.claim"), (b) => `${b.stance}: ${b.proposition}`],
        [t("luminaCore.memory.origin"), (b) => b.provenance],
        [t("luminaCore.columns.confidence"), (b) => b.confidence.toFixed(2)],
      ]),
      t("luminaCore.memory.beliefsHint"),
    )}
  `;
}
