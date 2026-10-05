import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { renderHubTabs } from "../../components/hub-tabs.ts";
import { t } from "../../i18n/index.ts";
import { registerM3ganEnglish } from "../../i18n/locales/en-m3gan.ts";
import "../../styles/m3gan.css";
import {
  configureM3ganPolling,
  getM3ganState,
  loadM3gan,
  runM3ganCommand,
} from "./m3gan-controller.ts";
import type { M3ganPerson, M3ganStatePayload, M3ganTab, M3ganWorldNode } from "./m3gan-types.ts";

registerM3ganEnglish();

type M3ganProps = {
  host: object;
  client: GatewayBrowserClient | null;
  connected: boolean;
  onRequestUpdate?: () => void;
};

type ControllerState = ReturnType<typeof getM3ganState>;
type Column<T> = readonly [label: string, cell: (row: T) => unknown];
type Variant = "primary" | "danger" | "";

const TABS: ReadonlyArray<M3ganTab> = [
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
    <section class="card m3gan__card">
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
      @click=${() => void runM3ganCommand(state, client, method, params)}
    >
      ${label}
    </button>`;
}

function renderStatus(s: M3ganStatePayload): TemplateResult {
  const o = s.safety.overrides;
  const p = s.privacy;
  return html`
    <div class="chip-row">
      ${s.safety.emergencyStop ? chip(t("m3gan.status.emergencyStop"), false) : nothing}
      ${
        o.paused
          ? chip(t("m3gan.status.paused"), false)
          : chip(t("m3gan.status.level", { level: String(s.self.autonomyLevel) }), true)
      }
      ${chip(p.camera ? t("m3gan.status.cameraOn") : t("m3gan.status.cameraOff"), !p.camera)}
      ${chip(p.microphone ? t("m3gan.status.micOn") : t("m3gan.status.micOff"), !p.microphone)}
      ${
        p.privateMode
          ? chip(t("m3gan.status.privateMode"), true)
          : chip(p.recording ? t("m3gan.status.recording") : t("m3gan.status.notRecording"), true)
      }
      ${chip(t("m3gan.status.body", { mode: s.self.body.mode }), true)}
      ${chip(s.model ? t("m3gan.status.model", { model: s.model }) : t("m3gan.status.noModel"), Boolean(s.model))}
    </div>
  `;
}

function renderLive(s: M3ganStatePayload): TemplateResult {
  const w = s.workspace;
  const present = s.presence.present
    .map((p) => (p.speaking ? `${p.name} (${t("m3gan.live.speaking")})` : p.name))
    .join(", ");
  const facts: ReadonlyArray<readonly [string, string]> = [
    [t("m3gan.live.goal"), w.currentGoal?.title ?? "—"],
    [
      t("m3gan.live.attention"),
      w.attentionTarget ? `${w.attentionTarget.source}:${w.attentionTarget.kind}` : "—",
    ],
    [
      t("m3gan.live.lastDecision"),
      w.activeTask ? `${w.activeTask.event} → ${w.activeTask.outcome ?? "—"}` : "—",
    ],
    [t("m3gan.live.present"), present || "—"],
    [t("m3gan.live.userContext"), w.userContext?.intent ?? w.userContext?.activeWindow ?? "—"],
    [t("m3gan.live.energy"), s.energy.detail],
    [t("m3gan.live.pending"), String(w.pendingEvents)],
  ];
  return html`
    ${card(
      t("m3gan.live.situation"),
      table(facts, [
        ["", (f) => f[0]],
        ["", (f) => f[1]],
      ]),
    )}
    ${card(
      t("m3gan.live.events"),
      table(s.events, [
        [t("m3gan.columns.time"), (e) => clock(e.event.atISO)],
        [t("m3gan.columns.source"), (e) => e.event.source],
        [t("m3gan.columns.kind"), (e) => e.event.kind],
        [t("m3gan.columns.salience"), (e) => e.verdict.salience.toFixed(2)],
        [t("m3gan.columns.admitted"), (e) => (e.verdict.admitted ? t("m3gan.yes") : t("m3gan.no"))],
      ]),
    )}
    ${card(
      t("m3gan.live.staleBeliefs"),
      table(w.uncertainty.staleBeliefs, [
        [t("m3gan.columns.what"), (b) => b.label],
        [t("m3gan.columns.confidence"), (b) => b.confidence.toFixed(2)],
      ]),
    )}
  `;
}

function renderSafety(s: M3ganStatePayload, act: ReturnType<typeof makeAction>): TemplateResult {
  const o = s.safety.overrides;
  const p = s.privacy;
  const audit = s.safety.audit;
  return html`
    ${card(
      t("m3gan.safety.orders"),
      html`
        <div class="m3gan__actions">
          ${act(t("m3gan.safety.pause"), "m3gan.override", { type: "pause" })}
          ${act(t("m3gan.safety.resume"), "m3gan.override", { type: "resume" }, "primary")}
          ${act(t("m3gan.safety.stopMotion"), "m3gan.override", { type: "stop_motion" }, "danger")}
          ${act(t("m3gan.safety.cancelTask"), "m3gan.override", { type: "cancel_task" })}
          ${act(t("m3gan.safety.disableAutonomy"), "m3gan.override", { type: "disable_autonomy" })}
          ${act(t("m3gan.safety.enableAutonomy"), "m3gan.override", { type: "enable_autonomy" }, "primary")}
          ${s.safety.emergencyStop ? act(t("m3gan.safety.rearm"), "m3gan.estop.rearm", {}, "danger") : nothing}
          ${o.disabledCapabilities.map((capability) =>
            act(
              t("m3gan.safety.reenable", { capability }),
              "m3gan.override",
              { type: "enable_capability", capability },
              "primary",
            ),
          )}
        </div>
      `,
      t("m3gan.safety.overrideSummary", {
        paused: o.paused ? t("m3gan.yes") : t("m3gan.no"),
        ceiling: o.autonomyCeiling === null ? t("m3gan.safety.none") : `L${o.autonomyCeiling}`,
        disabled: o.disabledCapabilities.join(", ") || t("m3gan.safety.none"),
        by: o.updatedBy,
      }),
    )}
    ${card(
      t("m3gan.safety.confirmations"),
      table(s.safety.pendingConfirmations, [
        [t("m3gan.columns.intent"), (c) => JSON.stringify(c.intent)],
        [t("m3gan.columns.requestedBy"), (c) => c.requestedBy],
        [t("m3gan.columns.expires"), (c) => clock(c.expiresAtISO)],
        [
          "",
          (c) => html`<div class="m3gan__actions">
            ${act(t("m3gan.safety.approve"), "m3gan.confirm", { id: c.id, approve: true }, "primary")}
            ${act(t("m3gan.safety.reject"), "m3gan.confirm", { id: c.id, approve: false })}
          </div>`,
        ],
      ]),
    )}
    ${card(
      t("m3gan.safety.privacy"),
      html`<div class="m3gan__actions">
        ${act(p.camera ? t("m3gan.safety.cameraOff") : t("m3gan.safety.cameraOn"), "m3gan.privacy", { camera: !p.camera }, p.camera ? "" : "primary")}
        ${act(p.microphone ? t("m3gan.safety.micOff") : t("m3gan.safety.micOn"), "m3gan.privacy", { microphone: !p.microphone }, p.microphone ? "" : "primary")}
        ${act(p.privateMode ? t("m3gan.safety.privateOff") : t("m3gan.safety.privateOn"), "m3gan.privacy", { privateMode: !p.privateMode }, p.privateMode ? "primary" : "")}
        ${act(p.recording ? t("m3gan.safety.recordingOff") : t("m3gan.safety.recordingOn"), "m3gan.privacy", { recording: !p.recording }, p.recording ? "" : "primary")}
      </div>`,
    )}
    ${card(
      t("m3gan.safety.invariants"),
      table(s.safety.invariants, [
        [t("m3gan.columns.id"), (i) => i.id],
        [t("m3gan.columns.rule"), (i) => i.rule],
        [t("m3gan.columns.spec"), (i) => i.spec.join(" ")],
      ]),
    )}
    ${card(
      t("m3gan.safety.audit"),
      table(s.audit, [
        [t("m3gan.columns.time"), (r) => clock(r.atISO)],
        [t("m3gan.columns.actor"), (r) => r.actor],
        [t("m3gan.columns.action"), (r) => r.action],
        [t("m3gan.columns.result"), (r) => r.execution],
        [t("m3gan.columns.reason"), (r) => r.reason],
      ]),
      audit.ok
        ? t("m3gan.safety.auditIntact", { count: String(audit.entries) })
        : t("m3gan.safety.auditBroken", { at: String(audit.brokenAt ?? "?") }),
    )}
  `;
}

function consentSummary(p: M3ganPerson): string {
  const parts = [
    p.consent.faceRecognition ? t("m3gan.people.face") : "",
    p.consent.voiceRecognition ? t("m3gan.people.voice") : "",
    p.consent.recording ? t("m3gan.people.recordingConsent") : "",
  ].filter(Boolean);
  return parts.join(", ") || t("m3gan.safety.none");
}

function renderPeople(s: M3ganStatePayload, act: ReturnType<typeof makeAction>): TemplateResult {
  return card(
    t("m3gan.people.title"),
    table(s.people, [
      [t("m3gan.columns.name"), (p) => p.name],
      [t("m3gan.columns.role"), (p) => p.role],
      [t("m3gan.people.relationship"), (p) => p.relationship ?? "—"],
      [
        t("m3gan.people.preferences"),
        (p) =>
          Object.entries(p.preferences)
            .map(([k, v]) => `${k}: ${v}`)
            .join("; ") || "—",
      ],
      [t("m3gan.people.consent"), (p) => consentSummary(p)],
      [
        "",
        (p) => html`<div class="m3gan__actions">
          ${["owner", "guardian", "user", "guest"].map((role) =>
            act(
              role,
              "m3gan.people.role",
              { personId: p.id, role },
              p.role === role ? "primary" : "",
            ),
          )}
          ${act(
            p.consent.faceRecognition ? t("m3gan.people.revokeFace") : t("m3gan.people.allowFace"),
            "m3gan.people.consent",
            { personId: p.id, faceRecognition: !p.consent.faceRecognition },
          )}
          ${act(
            p.consent.voiceRecognition
              ? t("m3gan.people.revokeVoice")
              : t("m3gan.people.allowVoice"),
            "m3gan.people.consent",
            { personId: p.id, voiceRecognition: !p.consent.voiceRecognition },
          )}
          ${act(t("m3gan.people.forget"), "m3gan.people.forget", { personId: p.id }, "danger")}
        </div>`,
      ],
    ]),
  );
}

function renderTree(
  nodes: ReadonlyArray<M3ganWorldNode>,
  act: ReturnType<typeof makeAction>,
): TemplateResult {
  return html`<ul class="m3gan__tree">
    ${nodes.map(
      (node) => html`<li>
        <span class="m3gan__node">${node.label}</span>
        <span class="muted">${node.kind}</span>
        ${act(t("m3gan.world.forget"), "m3gan.world.forget", { id: node.id })}
        ${node.children.length > 0 ? renderTree(node.children, act) : nothing}
      </li>`,
    )}
  </ul>`;
}

function renderHealth(s: M3ganStatePayload): TemplateResult {
  return html`
    ${card(
      t("m3gan.health.subsystems"),
      table(s.health.subsystems, [
        [
          t("m3gan.columns.subsystem"),
          (x) => (x.critical ? `${x.name} (${t("m3gan.health.critical")})` : x.name),
        ],
        [
          t("m3gan.columns.state"),
          (x) => chip(x.status, x.status === "ok" || x.status === "absent"),
        ],
        [t("m3gan.columns.detail"), (x) => x.detail],
        [t("m3gan.columns.advice"), (x) => x.recommendation ?? ""],
      ]),
      t("m3gan.health.beats", { beats: String(s.health.beats) }),
    )}
    ${card(
      t("m3gan.health.sensors"),
      html`${table(s.self.sensors, [
          [t("m3gan.columns.sensor"), (x) => x.kind],
          [t("m3gan.health.available"), (x) => (x.available ? t("m3gan.yes") : t("m3gan.no"))],
          [t("m3gan.columns.detail"), (x) => x.detail ?? ""],
        ])}
        <div class="card-sub">${t("m3gan.health.limitations")}</div>
        <ul class="m3gan__list">
          ${s.self.limitations.map((line) => html`<li>${line}</li>`)}
        </ul>`,
    )}
  `;
}

function renderRobot(s: M3ganStatePayload, act: ReturnType<typeof makeAction>): TemplateResult {
  const teleoperators = s.people.filter((p) =>
    ["owner", "guardian", "technician"].includes(p.role),
  );
  const places = s.world.filter((n) => n.kind === "room" || n.kind === "location");
  return html`
    ${card(
      t("m3gan.robot.body"),
      s.robot
        ? html`<pre class="m3gan__pre">${JSON.stringify(s.robot, null, 2)}</pre>`
        : html`<p class="muted">${t("m3gan.robot.noBody")}</p>`,
    )}
    ${card(
      t("m3gan.robot.teleop"),
      teleoperators.length === 0
        ? html`<p class="muted">${t("m3gan.robot.noTeleoperator")}</p>`
        : teleoperators.map(
            (p) => html`<div class="m3gan__actions">
              <strong>${p.name}</strong><span class="muted">${p.role}</span>
              ${act(t("m3gan.robot.stop"), "m3gan.teleop", { personId: p.id, type: "stop" }, "danger")}
              ${act(t("m3gan.robot.wave"), "m3gan.teleop", { personId: p.id, type: "gesture", name: "wave" })}
              ${
                p.role === "technician"
                  ? nothing
                  : places.map((place) =>
                      act(t("m3gan.robot.goTo", { place: place.label }), "m3gan.teleop", {
                        personId: p.id,
                        type: "navigate_to",
                        targetId: place.id,
                      }),
                    )
              }
            </div>`,
          ),
      t("m3gan.robot.teleopHint"),
    )}
    ${card(
      t("m3gan.robot.requests"),
      table(s.body, [
        [t("m3gan.columns.time"), (b) => clock(b.atISO)],
        [t("m3gan.columns.intent"), (b) => b.intent.type],
        [t("m3gan.columns.requestedBy"), (b) => b.requestedBy ?? "—"],
        [t("m3gan.columns.verdict"), (b) => b.review.verdict],
        [t("m3gan.columns.result"), (b) => b.outcome?.detail ?? "—"],
      ]),
    )}
  `;
}

function renderDeveloper(s: M3ganStatePayload): TemplateResult {
  return html`
    ${card(
      t("m3gan.developer.cycles"),
      table(s.cycles, [
        [t("m3gan.columns.time"), (c) => clock(c.atISO)],
        [t("m3gan.columns.event"), (c) => `${c.event.source}:${c.event.kind}`],
        [t("m3gan.columns.decision"), (c) => c.outcome ?? "—"],
        [t("m3gan.columns.reason"), (c) => c.reason],
      ]),
    )}
    ${card(
      t("m3gan.developer.raw"),
      html`<pre class="m3gan__pre">
${JSON.stringify({ self: s.self, workspace: s.workspace }, null, 2)}</pre>`,
    )}
  `;
}

export function renderM3gan(props: M3ganProps) {
  const state = getM3ganState(props.host);
  state.requestUpdate = props.onRequestUpdate ?? null;
  const client = props.connected ? props.client : null;
  configureM3ganPolling(state, client);
  if (client && !state.state && !state.loading && !state.error) {
    void loadM3gan(state, client);
  }
  const s = state.state;
  const act = makeAction(state, client);
  const body = !s
    ? html`<p class="muted">${state.error ?? t("m3gan.loading")}</p>`
    : {
        live: () => renderLive(s),
        safety: () => renderSafety(s, act),
        people: () => renderPeople(s, act),
        world: () =>
          card(
            t("m3gan.world.title"),
            s.world.length > 0
              ? renderTree(s.world, act)
              : html`<p class="muted">${t("m3gan.world.empty")}</p>`,
          ),
        health: () => renderHealth(s),
        robot: () => renderRobot(s, act),
        developer: () => renderDeveloper(s),
      }[state.tab]();

  return html`
    <div class="m3gan">
      <header class="m3gan__header">
        <div>
          <div class="card-title">${t("m3gan.title")}</div>
          <div class="card-sub">${t("m3gan.subtitle")}</div>
        </div>
        <button
          class="btn btn--sm"
          type="button"
          ?disabled=${!client || state.loading}
          @click=${() => void loadM3gan(state, client)}
        >
          ${t("m3gan.refresh")}
        </button>
      </header>
      ${s ? renderStatus(s) : nothing}
      ${state.notice ? html`<div class="callout warn" role="status">${state.notice}</div>` : nothing}
      ${s && state.error ? html`<div class="callout danger" role="alert">${state.error}</div>` : nothing}
      ${renderHubTabs({
        id: "m3gan",
        active: state.tab,
        tabs: TABS.map((tab) => ({ value: tab, label: t(`m3gan.tabs.${tab}`) })),
        ariaLabel: t("m3gan.tabsLabel"),
        panelId: "m3gan-panel",
        variant: "sub",
        onSelect: (tab) => {
          state.tab = tab;
          state.requestUpdate?.();
        },
      })}
      <div id="m3gan-panel" class="m3gan__panel">${body}</div>
    </div>
  `;
}
