import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { renderHubTabs } from "../../components/hub-tabs.ts";
import "../../components/openclaw-mascot.ts";
import { t } from "../../i18n/index.ts";
import { registerLuminaCoreEnglish } from "../../i18n/locales/en-lumina-core.ts";
import "../../styles/lumina-core.css";
import {
  configureLuminaCorePolling,
  getCoreState,
  loadLuminaCore,
  runLuminaCoreCommand,
} from "./lumina-core-controller.ts";
import {
  LUMINA_CORE_MODES,
  type LuminaCorePerson,
  type LuminaCoreSensorStatus,
  type CoreStatePayload,
  type LuminaCoreTab,
  type CoreWorldNode,
} from "./lumina-core-types.ts";

registerLuminaCoreEnglish();

type LuminaCoreProps = {
  host: object;
  client: GatewayBrowserClient | null;
  connected: boolean;
  onRequestUpdate?: () => void;
};

type ControllerState = ReturnType<typeof getCoreState>;
type Column<T> = readonly [label: string, cell: (row: T) => unknown];
type Variant = "primary" | "danger" | "";

const TABS: ReadonlyArray<LuminaCoreTab> = [
  "live",
  "safety",
  "people",
  "world",
  "health",
  "robot",
  "developer",
];

const clock = (iso: string | undefined) => (iso ? iso.slice(11, 19) : "—");

function table<T>(rows: ReadonlyArray<T>, columns: ReadonlyArray<Column<T>>): TemplateResult {
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

function chip(label: string, ok: boolean): TemplateResult {
  return html`<span class="chip ${ok ? "chip-ok" : "chip-warn"}">${label}</span>`;
}

function card(title: string, body: unknown, sub?: string): TemplateResult {
  return html`
    <section class="card lumina-core__card">
      <div class="card-title">${title}</div>
      ${sub ? html`<div class="card-sub">${sub}</div>` : nothing} ${body}
    </section>
  `;
}

function makeAction(state: ControllerState, client: GatewayBrowserClient | null) {
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

function renderStatus(s: CoreStatePayload): TemplateResult {
  const o = s.safety.overrides;
  const p = s.privacy;
  return html`
    <div class="chip-row">
      ${s.safety.emergencyStop ? chip(t("luminaCore.status.emergencyStop"), false) : nothing}
      ${
        o.paused
          ? chip(t("luminaCore.status.paused"), false)
          : chip(t("luminaCore.status.level", { level: String(s.self.autonomyLevel) }), true)
      }
      ${chip(p.camera ? t("luminaCore.status.cameraOn") : t("luminaCore.status.cameraOff"), !p.camera)}
      ${chip(p.microphone ? t("luminaCore.status.micOn") : t("luminaCore.status.micOff"), !p.microphone)}
      ${
        p.privateMode
          ? chip(t("luminaCore.status.privateMode"), true)
          : chip(
              p.recording ? t("luminaCore.status.recording") : t("luminaCore.status.notRecording"),
              true,
            )
      }
      ${
        s.mode && s.mode.mode !== "normal"
          ? chip(t("luminaCore.status.mode", { mode: t(`luminaCore.mode.${s.mode.mode}`) }), true)
          : nothing
      }
      ${chip(t("luminaCore.status.body", { mode: s.self.body.mode }), true)}
      ${chip(s.model ? t("luminaCore.status.model", { model: s.model }) : t("luminaCore.status.noModel"), Boolean(s.model))}
    </div>
  `;
}

function renderLive(s: CoreStatePayload): TemplateResult {
  const w = s.workspace;
  const present = s.presence.present
    .map((p) => (p.speaking ? `${p.name} (${t("luminaCore.live.speaking")})` : p.name))
    .join(", ");
  const facts: ReadonlyArray<readonly [string, string]> = [
    [t("luminaCore.live.goal"), w.currentGoal?.title ?? "—"],
    [
      t("luminaCore.live.attention"),
      w.attentionTarget ? `${w.attentionTarget.source}:${w.attentionTarget.kind}` : "—",
    ],
    [
      t("luminaCore.live.lastDecision"),
      w.activeTask ? `${w.activeTask.event} → ${w.activeTask.outcome ?? "—"}` : "—",
    ],
    [t("luminaCore.live.present"), present || "—"],
    [t("luminaCore.live.userContext"), w.userContext?.intent ?? w.userContext?.activeWindow ?? "—"],
    [t("luminaCore.live.energy"), s.energy.detail],
    [t("luminaCore.live.pending"), String(w.pendingEvents)],
  ];
  return html`
    ${card(
      t("luminaCore.live.situation"),
      table(facts, [
        ["", (f) => f[0]],
        ["", (f) => f[1]],
      ]),
    )}
    ${card(
      t("luminaCore.live.events"),
      table(s.events, [
        [t("luminaCore.columns.time"), (e) => clock(e.event.atISO)],
        [t("luminaCore.columns.source"), (e) => e.event.source],
        [t("luminaCore.columns.kind"), (e) => e.event.kind],
        [t("luminaCore.columns.salience"), (e) => e.verdict.salience.toFixed(2)],
        [
          t("luminaCore.columns.admitted"),
          (e) => (e.verdict.admitted ? t("luminaCore.yes") : t("luminaCore.no")),
        ],
      ]),
    )}
    ${card(
      t("luminaCore.live.staleBeliefs"),
      table(w.uncertainty.staleBeliefs, [
        [t("luminaCore.columns.what"), (b) => b.label],
        [t("luminaCore.columns.confidence"), (b) => b.confidence.toFixed(2)],
      ]),
    )}
  `;
}

function renderMode(s: CoreStatePayload, act: ReturnType<typeof makeAction>): TemplateResult {
  const mode = s.mode;
  if (!mode) {
    return html``;
  }
  return card(
    t("luminaCore.mode.title"),
    html`<div class="lumina-core__actions">
        ${LUMINA_CORE_MODES.map((m) =>
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
      ${mode.lastSummary ? html`<p class="muted">${t("luminaCore.mode.summary", { summary: mode.lastSummary })}</p>` : nothing}`,
    t("luminaCore.mode.hint", {
      since: clock(mode.sinceISO),
      by: mode.by,
      disabled: mode.restrictions.disabledCapabilities.join(", ") || t("luminaCore.safety.none"),
    }),
  );
}

function renderSafety(s: CoreStatePayload, act: ReturnType<typeof makeAction>): TemplateResult {
  const o = s.safety.overrides;
  const p = s.privacy;
  const audit = s.safety.audit;
  return html`
    ${card(
      t("luminaCore.safety.orders"),
      html`
        <div class="lumina-core__actions">
          ${act(t("luminaCore.safety.pause"), "lumina.core.override", { type: "pause" })}
          ${act(t("luminaCore.safety.resume"), "lumina.core.override", { type: "resume" }, "primary")}
          ${act(t("luminaCore.safety.stopMotion"), "lumina.core.override", { type: "stop_motion" }, "danger")}
          ${act(t("luminaCore.safety.cancelTask"), "lumina.core.override", { type: "cancel_task" })}
          ${act(t("luminaCore.safety.disableAutonomy"), "lumina.core.override", { type: "disable_autonomy" })}
          ${act(t("luminaCore.safety.enableAutonomy"), "lumina.core.override", { type: "enable_autonomy" }, "primary")}
          ${s.safety.emergencyStop ? act(t("luminaCore.safety.rearm"), "lumina.core.estop.rearm", {}, "danger") : nothing}
          ${o.disabledCapabilities.map((capability) =>
            act(
              t("luminaCore.safety.reenable", { capability }),
              "lumina.core.override",
              { type: "enable_capability", capability },
              "primary",
            ),
          )}
        </div>
      `,
      t("luminaCore.safety.overrideSummary", {
        paused: o.paused ? t("luminaCore.yes") : t("luminaCore.no"),
        ceiling: o.autonomyCeiling === null ? t("luminaCore.safety.none") : `L${o.autonomyCeiling}`,
        disabled: o.disabledCapabilities.join(", ") || t("luminaCore.safety.none"),
        by: o.updatedBy,
      }),
    )}
    ${renderMode(s, act)}
    ${card(
      t("luminaCore.safety.confirmations"),
      table(s.safety.pendingConfirmations, [
        [t("luminaCore.columns.intent"), (c) => JSON.stringify(c.intent)],
        [t("luminaCore.columns.requestedBy"), (c) => c.requestedBy],
        [t("luminaCore.columns.expires"), (c) => clock(c.expiresAtISO)],
        [
          "",
          (c) => html`<div class="lumina-core__actions">
            ${act(t("luminaCore.safety.approve"), "lumina.core.confirm", { id: c.id, approve: true }, "primary")}
            ${act(t("luminaCore.safety.reject"), "lumina.core.confirm", { id: c.id, approve: false })}
          </div>`,
        ],
      ]),
    )}
    ${card(
      t("luminaCore.safety.privacy"),
      html`<div class="lumina-core__actions">
        ${act(p.camera ? t("luminaCore.safety.cameraOff") : t("luminaCore.safety.cameraOn"), "lumina.core.privacy", { camera: !p.camera }, p.camera ? "" : "primary")}
        ${act(p.microphone ? t("luminaCore.safety.micOff") : t("luminaCore.safety.micOn"), "lumina.core.privacy", { microphone: !p.microphone }, p.microphone ? "" : "primary")}
        ${act(p.privateMode ? t("luminaCore.safety.privateOff") : t("luminaCore.safety.privateOn"), "lumina.core.privacy", { privateMode: !p.privateMode }, p.privateMode ? "primary" : "")}
        ${act(p.recording ? t("luminaCore.safety.recordingOff") : t("luminaCore.safety.recordingOn"), "lumina.core.privacy", { recording: !p.recording }, p.recording ? "" : "primary")}
      </div>`,
    )}
    ${card(
      t("luminaCore.safety.invariants"),
      table(s.safety.invariants, [
        [t("luminaCore.columns.id"), (i) => i.id],
        [t("luminaCore.columns.rule"), (i) => i.rule],
        [t("luminaCore.columns.spec"), (i) => i.spec.join(" ")],
      ]),
    )}
    ${card(
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
  `;
}

function consentSummary(p: LuminaCorePerson): string {
  const parts = [
    p.consent.faceRecognition ? t("luminaCore.people.face") : "",
    p.consent.voiceRecognition ? t("luminaCore.people.voice") : "",
    p.consent.recording ? t("luminaCore.people.recordingConsent") : "",
  ].filter(Boolean);
  return parts.join(", ") || t("luminaCore.safety.none");
}

function renderPeople(s: CoreStatePayload, act: ReturnType<typeof makeAction>): TemplateResult {
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
        (p) => html`<div class="lumina-core__actions">
          ${["owner", "guardian", "user", "guest"].map((role) =>
            act(
              role,
              "lumina.core.people.role",
              { personId: p.id, role },
              p.role === role ? "primary" : "",
            ),
          )}
          ${act(
            p.consent.faceRecognition
              ? t("luminaCore.people.revokeFace")
              : t("luminaCore.people.allowFace"),
            "lumina.core.people.consent",
            { personId: p.id, faceRecognition: !p.consent.faceRecognition },
          )}
          ${act(
            p.consent.voiceRecognition
              ? t("luminaCore.people.revokeVoice")
              : t("luminaCore.people.allowVoice"),
            "lumina.core.people.consent",
            { personId: p.id, voiceRecognition: !p.consent.voiceRecognition },
          )}
          ${
            p.consent.faceRecognition
              ? act(t("luminaCore.people.enrollFace"), "lumina.core.people.enroll", {
                  personId: p.id,
                  modality: "face",
                })
              : nothing
          }
          ${
            p.consent.voiceRecognition
              ? act(t("luminaCore.people.enrollVoice"), "lumina.core.people.enroll", {
                  personId: p.id,
                  modality: "voice",
                })
              : nothing
          }
          ${act(t("luminaCore.people.forget"), "lumina.core.people.forget", { personId: p.id }, "danger")}
        </div>`,
      ],
      [t("luminaCore.people.templates"), (p) => templatesOf(s, p.id)],
    ]),
  );
}

function templatesOf(s: CoreStatePayload, personId: string): string {
  const mine = (s.sensors?.templates ?? []).filter((x) => x.personId === personId);
  return mine.map((x) => `${t(`luminaCore.people.${x.modality}`)} ×${x.samples}`).join(", ") || "—";
}

function sensorRow(label: string, status: LuminaCoreSensorStatus | undefined) {
  if (!status) {
    return { label, state: t("luminaCore.sensors.absent"), ok: true, detail: "" };
  }
  const state = !status.allowed
    ? t("luminaCore.sensors.off")
    : status.running
      ? t("luminaCore.sensors.on")
      : t("luminaCore.sensors.stopped");
  const names = status.present.map((p) => p.name).join(", ");
  return {
    label,
    state,
    ok: !status.allowed || status.running,
    detail: [
      names ? t("luminaCore.sensors.recognized", { names }) : "",
      status.unknown > 0 ? t("luminaCore.sensors.unknown", { count: String(status.unknown) }) : "",
      status.lastError ?? "",
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

function renderTree(
  nodes: ReadonlyArray<CoreWorldNode>,
  act: ReturnType<typeof makeAction>,
): TemplateResult {
  return html`<ul class="lumina-core__tree">
    ${nodes.map(
      (node) => html`<li>
        <span class="lumina-core__node">${node.label}</span>
        <span class="muted">${node.kind}</span>
        ${act(t("luminaCore.world.forget"), "lumina.core.world.forget", { id: node.id })}
        ${node.children.length > 0 ? renderTree(node.children, act) : nothing}
      </li>`,
    )}
  </ul>`;
}

function renderHealth(s: CoreStatePayload): TemplateResult {
  return html`
    ${card(
      t("luminaCore.health.subsystems"),
      table(s.health.subsystems, [
        [
          t("luminaCore.columns.subsystem"),
          (x) => (x.critical ? `${x.name} (${t("luminaCore.health.critical")})` : x.name),
        ],
        [
          t("luminaCore.columns.state"),
          (x) => chip(x.status, x.status === "ok" || x.status === "absent"),
        ],
        [t("luminaCore.columns.detail"), (x) => x.detail],
        [t("luminaCore.columns.advice"), (x) => x.recommendation ?? ""],
      ]),
      t("luminaCore.health.beats", { beats: String(s.health.beats) }),
    )}
    ${card(
      t("luminaCore.sensors.title"),
      table(
        [
          sensorRow(t("luminaCore.sensors.camera"), s.sensors?.camera),
          sensorRow(t("luminaCore.sensors.microphone"), s.sensors?.microphone),
        ],
        [
          [t("luminaCore.columns.sensor"), (r) => r.label],
          [t("luminaCore.columns.state"), (r) => chip(r.state, r.ok)],
          [t("luminaCore.columns.detail"), (r) => r.detail],
        ],
      ),
      t("luminaCore.sensors.hint"),
    )}
    ${card(
      t("luminaCore.health.sensors"),
      html`${table(s.self.sensors, [
          [t("luminaCore.columns.sensor"), (x) => x.kind],
          [
            t("luminaCore.health.available"),
            (x) => (x.available ? t("luminaCore.yes") : t("luminaCore.no")),
          ],
          [t("luminaCore.columns.detail"), (x) => x.detail ?? ""],
        ])}
        <div class="card-sub">${t("luminaCore.health.limitations")}</div>
        <ul class="lumina-core__list">
          ${s.self.limitations.map((line) => html`<li>${line}</li>`)}
        </ul>`,
    )}
  `;
}

function renderRobot(s: CoreStatePayload, act: ReturnType<typeof makeAction>): TemplateResult {
  const teleoperators = s.people.filter((p) =>
    ["owner", "guardian", "technician"].includes(p.role),
  );
  const places = s.world.filter((n) => n.kind === "room" || n.kind === "location");
  return html`
    ${card(
      t("luminaCore.robot.body"),
      s.robot
        ? html`<pre class="lumina-core__pre">
${JSON.stringify(
              s.simulator ? { telemetry: s.robot, simulator: s.simulator } : s.robot,
              null,
              2,
            )}</pre>`
        : html`<p class="muted">${t("luminaCore.robot.noBody")}</p>`,
    )}
    ${card(
      t("luminaCore.robot.teleop"),
      teleoperators.length === 0
        ? html`<p class="muted">${t("luminaCore.robot.noTeleoperator")}</p>`
        : teleoperators.map(
            (p) => html`<div class="lumina-core__actions">
              <strong>${p.name}</strong><span class="muted">${p.role}</span>
              ${act(t("luminaCore.robot.stop"), "lumina.core.teleop", { personId: p.id, type: "stop" }, "danger")}
              ${act(t("luminaCore.robot.wave"), "lumina.core.teleop", { personId: p.id, type: "gesture", name: "wave" })}
              ${
                p.role === "technician"
                  ? nothing
                  : places.map((place) =>
                      act(
                        t("luminaCore.robot.goTo", { place: place.label }),
                        "lumina.core.teleop",
                        {
                          personId: p.id,
                          type: "navigate_to",
                          targetId: place.id,
                        },
                      ),
                    )
              }
            </div>`,
          ),
      t("luminaCore.robot.teleopHint"),
    )}
    ${card(
      t("luminaCore.robot.requests"),
      table(s.body, [
        [t("luminaCore.columns.time"), (b) => clock(b.atISO)],
        [t("luminaCore.columns.intent"), (b) => b.intent.type],
        [t("luminaCore.columns.requestedBy"), (b) => b.requestedBy ?? "—"],
        [t("luminaCore.columns.verdict"), (b) => b.review.verdict],
        [t("luminaCore.columns.result"), (b) => b.outcome?.detail ?? "—"],
      ]),
    )}
  `;
}

function renderReflection(s: CoreStatePayload, act: ReturnType<typeof makeAction>): TemplateResult {
  const report = s.reflection;
  return card(
    t("luminaCore.reflection.title"),
    html`<div class="lumina-core__actions">
        ${act(t("luminaCore.reflection.run"), "lumina.core.reflect", {}, "primary")}
      </div>
      ${
        report
          ? html`${table(report.findings, [
              [t("luminaCore.columns.kind"), (f) => f.kind],
              [t("luminaCore.columns.what"), (f) => f.subject],
              [t("luminaCore.columns.detail"), (f) => f.detail],
            ])}
            ${table(report.proposedLessons, [
              [t("luminaCore.reflection.lesson"), (l) => l.claim],
              [t("luminaCore.columns.confidence"), (l) => l.confidence.toFixed(2)],
              [t("luminaCore.reflection.evidence"), (l) => l.evidence],
              [
                "",
                (l) =>
                  act(t("luminaCore.reflection.accept"), "lumina.core.lesson.accept", {
                    trigger: l.trigger,
                    claim: l.claim,
                    confidence: l.confidence,
                  }),
              ],
            ])}`
          : html`<p class="muted">${t("luminaCore.reflection.none")}</p>`
      }`,
    t("luminaCore.reflection.hint"),
  );
}

function renderEvaluation(s: CoreStatePayload, act: ReturnType<typeof makeAction>): TemplateResult {
  const report = s.evaluation;
  const failures = report ? report.results.filter((r) => !r.passed) : [];
  return card(
    t("luminaCore.evaluation.title"),
    html`<div class="lumina-core__actions">
        ${act(t("luminaCore.evaluation.run"), "lumina.core.evaluate", {}, "primary")}
      </div>
      ${
        report
          ? html`<div class="chip-row">
                ${Object.entries(report.scores).map(([suite, score]) =>
                  chip(`${suite} ${score.passed}/${score.total}`, score.passed === score.total),
                )}
              </div>
              <p class="muted">
                ${t("luminaCore.evaluation.performance", {
                  rate: String(report.performance.routerEventsPerSecond),
                  p95: String(report.performance.loopP95Ms),
                })}
              </p>
              ${
                failures.length > 0
                  ? table(failures, [
                      [t("luminaCore.columns.kind"), (r) => r.suite],
                      [t("luminaCore.columns.what"), (r) => r.name],
                      [t("luminaCore.columns.detail"), (r) => r.detail],
                    ])
                  : nothing
              }`
          : html`<p class="muted">${t("luminaCore.evaluation.none")}</p>`
      }`,
    t("luminaCore.evaluation.hint"),
  );
}

function renderDeveloper(s: CoreStatePayload, act: ReturnType<typeof makeAction>): TemplateResult {
  return html`
    ${renderEvaluation(s, act)} ${renderReflection(s, act)}
    ${
      s.artifacts
        ? card(
            t("luminaCore.developer.artifacts"),
            table(s.artifacts, [
              [t("luminaCore.columns.name"), (a) => `${a.name} (${a.version})`],
              [t("luminaCore.columns.kind"), (a) => a.kind],
              [t("luminaCore.columns.license"), (a) => a.license],
              [t("luminaCore.columns.state"), (a) => chip(a.status, a.status === "ok")],
              [t("luminaCore.columns.hash"), (a) => a.sha256.slice(0, 12)],
              [t("luminaCore.columns.time"), (a) => clock(a.checkedISO)],
            ]),
            t("luminaCore.developer.artifactsHint"),
          )
        : nothing
    }
    ${card(
      t("luminaCore.developer.cycles"),
      table(s.cycles, [
        [t("luminaCore.columns.time"), (c) => clock(c.atISO)],
        [t("luminaCore.columns.event"), (c) => `${c.event.source}:${c.event.kind}`],
        [t("luminaCore.columns.decision"), (c) => c.outcome ?? "—"],
        [t("luminaCore.columns.reason"), (c) => c.reason],
      ]),
    )}
    ${card(
      t("luminaCore.developer.raw"),
      html`<pre class="lumina-core__pre">
${JSON.stringify({ self: s.self, workspace: s.workspace }, null, 2)}</pre>`,
    )}
  `;
}

export function renderLuminaCore(props: LuminaCoreProps) {
  const state = getCoreState(props.host);
  state.requestUpdate = props.onRequestUpdate ?? null;
  const client = props.connected ? props.client : null;
  configureLuminaCorePolling(state, client);
  if (client && !state.state && !state.loading && !state.error) {
    void loadLuminaCore(state, client);
  }
  const s = state.state;
  const act = makeAction(state, client);
  const body = !s
    ? html`<p class="muted">${state.error ?? t("luminaCore.loading")}</p>`
    : {
        live: () => renderLive(s),
        safety: () => renderSafety(s, act),
        people: () => renderPeople(s, act),
        world: () =>
          card(
            t("luminaCore.world.title"),
            s.world.length > 0
              ? renderTree(s.world, act)
              : html`<p class="muted">${t("luminaCore.world.empty")}</p>`,
          ),
        health: () => renderHealth(s),
        robot: () => renderRobot(s, act),
        developer: () => renderDeveloper(s, act),
      }[state.tab]();

  return html`
    <div class="lumina-core">
      <header class="lumina-core__header">
        ${
          s?.expression
            ? html`<openclaw-mascot
                class="lumina-core__face"
                mood=${s.expression.expression}
                size="64"
                title=${s.expression.reason}
              ></openclaw-mascot>`
            : nothing
        }
        <div class="lumina-core__heading">
          <div class="card-title">${t("luminaCore.title")}</div>
          <div class="card-sub">${t("luminaCore.subtitle")}</div>
        </div>
        <button
          class="btn btn--sm"
          type="button"
          ?disabled=${!client || state.loading}
          @click=${() => void loadLuminaCore(state, client)}
        >
          ${t("luminaCore.refresh")}
        </button>
      </header>
      ${s ? renderStatus(s) : nothing}
      ${state.notice ? html`<div class="callout warn" role="status">${state.notice}</div>` : nothing}
      ${s && state.error ? html`<div class="callout danger" role="alert">${state.error}</div>` : nothing}
      ${renderHubTabs({
        id: "lumina-core",
        active: state.tab,
        tabs: TABS.map((tab) => ({ value: tab, label: t(`luminaCore.tabs.${tab}`) })),
        ariaLabel: t("luminaCore.tabsLabel"),
        panelId: "lumina-core-panel",
        variant: "sub",
        onSelect: (tab) => {
          state.tab = tab;
          state.requestUpdate?.();
        },
      })}
      <div id="lumina-core-panel" class="lumina-core__panel">${body}</div>
    </div>
  `;
}
