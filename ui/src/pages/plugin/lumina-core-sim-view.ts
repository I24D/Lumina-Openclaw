/**
 * lumina-core-sim-view.ts — Learning to move in simulation, as the Robot view shows it.
 *
 * Lumina spec §133: a person starts training; the view shows progress and,
 * once done, how the learned navigation compares with the default on rooms it
 * never saw, and whether it was accepted for the simulated body.
 */
import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";
import { card, chip, table, type Action } from "./lumina-core-parts.ts";
import type { CoreStatePayload } from "./lumina-core-types.ts";

export function renderSimTraining(
  s: CoreStatePayload,
  act: Action,
): TemplateResult | typeof nothing {
  const training = s.simTraining;
  if (training === undefined || training === null) {
    return nothing;
  }
  const report = training.report;
  const rows = report
    ? [
        { name: t("luminaCore.sim.default"), ...report.baseline },
        { name: t("luminaCore.sim.learned"), ...report.learned },
      ]
    : [];
  return card(
    t("luminaCore.sim.title"),
    html`<div class="lumina-core__actions">
        ${
          training.running
            ? chip(
                t("luminaCore.sim.running", {
                  iteration: String(training.progress?.iteration ?? 0),
                }),
                true,
              )
            : act(t("luminaCore.sim.train"), "lumina.core.sim.train", {}, "primary")
        }
        ${
          report
            ? chip(
                report.accepted ? t("luminaCore.sim.accepted") : t("luminaCore.sim.rejected"),
                report.accepted,
              )
            : nothing
        }
      </div>
      ${training.error ? html`<p class="muted">${training.error}</p>` : nothing}
      ${
        report
          ? table(rows, [
              [t("luminaCore.columns.name"), (r) => r.name],
              [t("luminaCore.sim.success"), (r) => `${Math.round(r.successRate * 100)}%`],
              [t("luminaCore.sim.personContacts"), (r) => String(r.personContacts)],
              [t("luminaCore.sim.obstacleContacts"), (r) => String(r.obstacleContacts)],
              [
                t("luminaCore.sim.margin"),
                (r) => (r.minPersonM === null ? "—" : `${r.minPersonM} m`),
              ],
              [t("luminaCore.sim.seconds"), (r) => `${r.meanSeconds} s`],
            ])
          : nothing
      }`,
    t("luminaCore.sim.hint"),
  );
}
