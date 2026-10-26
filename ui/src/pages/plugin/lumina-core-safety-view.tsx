/**
 * lumina-core-safety-view.tsx — The Safety and People views of the Lumina tab:
 * the owner's orders, modes, confirmations, privacy, invariants and audit, and
 * the people Lumina knows with their roles and consent.
 */
import type { JSX } from "@solidjs/web";
import { t } from "../../lib/reactive/i18n.ts";
import { card, chip, clock, each, table, type Action } from "./lumina-core-parts.tsx";
import {
  LUMINA_CORE_MODES,
  type CoreStatePayload,
  type LuminaCorePerson,
} from "./lumina-core-types.ts";

type Act = Action;

function renderMode(s: CoreStatePayload, act: Act): JSX.Element {
  const mode = s.mode;
  if (!mode) {
    return null;
  }
  return card(
    t("luminaCore.mode.title"),
    <>
      <div class="lumina-core__actions">
        {each(LUMINA_CORE_MODES, (m) =>
          m === mode.mode
            ? chip(t(`luminaCore.mode.${m}`), true)
            : act(
                t(`luminaCore.mode.${m}`),
                "lumina.core.mode",
                { mode: m },
                m === "normal" ? "primary" : "",
              ),
        )}
      </div>
      {mode.lastSummary ? (
        <p class="muted">{t("luminaCore.mode.summary", { summary: mode.lastSummary })}</p>
      ) : null}
    </>,
    t("luminaCore.mode.hint", {
      since: clock(mode.sinceISO),
      by: mode.by,
      disabled: mode.restrictions.disabledCapabilities.join(", ") || t("luminaCore.safety.none"),
    }),
  );
}

export function renderSafety(s: CoreStatePayload, act: Act): JSX.Element {
  const o = s.safety.overrides;
  const p = s.privacy;
  const audit = s.safety.audit;
  return (
    <>
      {card(
        t("luminaCore.safety.orders"),
        <div class="lumina-core__actions">
          {act(t("luminaCore.safety.pause"), "lumina.core.override", { type: "pause" })}
          {act(
            t("luminaCore.safety.resume"),
            "lumina.core.override",
            { type: "resume" },
            "primary",
          )}
          {act(
            t("luminaCore.safety.stopMotion"),
            "lumina.core.override",
            { type: "stop_motion" },
            "danger",
          )}
          {act(t("luminaCore.safety.cancelTask"), "lumina.core.override", { type: "cancel_task" })}
          {act(t("luminaCore.safety.disableAutonomy"), "lumina.core.override", {
            type: "disable_autonomy",
          })}
          {act(
            t("luminaCore.safety.enableAutonomy"),
            "lumina.core.override",
            { type: "enable_autonomy" },
            "primary",
          )}
          {s.safety.emergencyStop
            ? act(t("luminaCore.safety.rearm"), "lumina.core.estop.rearm", {}, "danger")
            : null}
          {each(o.disabledCapabilities, (capability) =>
            act(
              t("luminaCore.safety.reenable", { capability }),
              "lumina.core.override",
              { type: "enable_capability", capability },
              "primary",
            ),
          )}
        </div>,
        t("luminaCore.safety.overrideSummary", {
          paused: o.paused ? t("luminaCore.yes") : t("luminaCore.no"),
          ceiling:
            o.autonomyCeiling === null ? t("luminaCore.safety.none") : `L${o.autonomyCeiling}`,
          disabled: o.disabledCapabilities.join(", ") || t("luminaCore.safety.none"),
          by: o.updatedBy,
        }),
      )}
      {renderMode(s, act)}
      {card(
        t("luminaCore.safety.confirmations"),
        table(s.safety.pendingConfirmations, [
          [t("luminaCore.columns.intent"), (c) => JSON.stringify(c.intent)],
          [t("luminaCore.columns.requestedBy"), (c) => c.requestedBy],
          [t("luminaCore.columns.expires"), (c) => clock(c.expiresAtISO)],
          [
            "",
            (c) => (
              <div class="lumina-core__actions">
                {act(
                  t("luminaCore.safety.approve"),
                  "lumina.core.confirm",
                  { id: c.id, approve: true },
                  "primary",
                )}
                {act(t("luminaCore.safety.reject"), "lumina.core.confirm", {
                  id: c.id,
                  approve: false,
                })}
              </div>
            ),
          ],
        ]),
      )}
      {card(
        t("luminaCore.safety.privacy"),
        <div class="lumina-core__actions">
          {act(
            p.camera ? t("luminaCore.safety.cameraOff") : t("luminaCore.safety.cameraOn"),
            "lumina.core.privacy",
            { camera: !p.camera },
            p.camera ? "" : "primary",
          )}
          {act(
            p.microphone ? t("luminaCore.safety.micOff") : t("luminaCore.safety.micOn"),
            "lumina.core.privacy",
            { microphone: !p.microphone },
            p.microphone ? "" : "primary",
          )}
          {act(
            p.privateMode ? t("luminaCore.safety.privateOff") : t("luminaCore.safety.privateOn"),
            "lumina.core.privacy",
            { privateMode: !p.privateMode },
            p.privateMode ? "primary" : "",
          )}
          {act(
            p.recording ? t("luminaCore.safety.recordingOff") : t("luminaCore.safety.recordingOn"),
            "lumina.core.privacy",
            { recording: !p.recording },
            p.recording ? "" : "primary",
          )}
        </div>,
      )}
      {card(
        t("luminaCore.safety.invariants"),
        table(s.safety.invariants, [
          [t("luminaCore.columns.id"), (i) => i.id],
          [t("luminaCore.columns.rule"), (i) => i.rule],
          [t("luminaCore.columns.spec"), (i) => i.spec.join(" ")],
        ]),
      )}
      {card(
        t("luminaCore.safety.audit"),
        table(s.audit, [
          [t("luminaCore.columns.time"), (r) => clock(r.atISO)],
          [t("luminaCore.columns.actor"), (r) => r.actor],
          [t("luminaCore.columns.action"), (r) => r.action],
          [t("luminaCore.columns.result"), (r) => r.execution],
          [t("luminaCore.columns.reason"), (r) => r.reason],
        ]),
        audit.ok
          ? t("luminaCore.safety.auditIntact", { count: String(audit.entries) })
          : t("luminaCore.safety.auditBroken", { at: String(audit.brokenAt ?? "?") }),
      )}
    </>
  );
}

function consentSummary(p: LuminaCorePerson): string {
  const parts = [
    p.consent.faceRecognition ? t("luminaCore.people.face") : "",
    p.consent.voiceRecognition ? t("luminaCore.people.voice") : "",
    p.consent.recording ? t("luminaCore.people.recordingConsent") : "",
  ].filter(Boolean);
  return parts.join(", ") || t("luminaCore.safety.none");
}

function templatesOf(s: CoreStatePayload, personId: string): string {
  const mine = (s.sensors?.templates ?? []).filter((x) => x.personId === personId);
  return mine.map((x) => `${t(`luminaCore.people.${x.modality}`)} ×${x.samples}`).join(", ") || "—";
}

export function renderPeople(s: CoreStatePayload, act: Act): JSX.Element {
  return card(
    t("luminaCore.people.title"),
    table(s.people, [
      [t("luminaCore.columns.name"), (p) => p.name],
      [t("luminaCore.columns.role"), (p) => p.role],
      [t("luminaCore.people.relationship"), (p) => p.relationship ?? "—"],
      [
        t("luminaCore.people.preferences"),
        (p) =>
          Object.entries(p.preferences)
            .map(([k, v]) => `${k}: ${v}`)
            .join("; ") || "—",
      ],
      [t("luminaCore.people.consent"), (p) => consentSummary(p)],
      [
        "",
        (p) => (
          <div class="lumina-core__actions">
            {each(["owner", "guardian", "user", "guest"], (role) =>
              act(
                role,
                "lumina.core.people.role",
                { personId: p.id, role },
                p.role === role ? "primary" : "",
              ),
            )}
            {act(
              p.consent.faceRecognition
                ? t("luminaCore.people.revokeFace")
                : t("luminaCore.people.allowFace"),
              "lumina.core.people.consent",
              { personId: p.id, faceRecognition: !p.consent.faceRecognition },
            )}
            {act(
              p.consent.voiceRecognition
                ? t("luminaCore.people.revokeVoice")
                : t("luminaCore.people.allowVoice"),
              "lumina.core.people.consent",
              { personId: p.id, voiceRecognition: !p.consent.voiceRecognition },
            )}
            {p.consent.faceRecognition
              ? act(t("luminaCore.people.enrollFace"), "lumina.core.people.enroll", {
                  personId: p.id,
                  modality: "face",
                })
              : null}
            {p.consent.voiceRecognition
              ? act(t("luminaCore.people.enrollVoice"), "lumina.core.people.enroll", {
                  personId: p.id,
                  modality: "voice",
                })
              : null}
            {act(
              t("luminaCore.people.forget"),
              "lumina.core.people.forget",
              { personId: p.id },
              "danger",
            )}
          </div>
        ),
      ],
      [t("luminaCore.people.templates"), (p) => templatesOf(s, p.id)],
    ]),
  );
}
