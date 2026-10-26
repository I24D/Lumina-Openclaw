import type { JSX } from "@solidjs/web";
import { createSignal, onCleanup, Show } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import "../../components/openclaw-mascot.tsx";
import { HubTabs } from "../../components/solid/hub-tabs.tsx";
import { registerLuminaCoreEnglish } from "../../i18n/locales/en-lumina-core.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import "../../styles/lumina-core.css";
import {
  configureLuminaCorePolling,
  getCoreState,
  loadLuminaCore,
  stopLuminaCorePolling,
} from "./lumina-core-controller.ts";
import { MemorySearch, renderMemory } from "./lumina-core-memory-view.tsx";
import {
  card,
  chip,
  clock,
  each,
  makeAction,
  table,
  type ControllerState,
} from "./lumina-core-parts.tsx";
import { renderPeople, renderSafety } from "./lumina-core-safety-view.tsx";
import { renderSimTraining } from "./lumina-core-sim-view.tsx";
import type {
  CoreStatePayload,
  CoreWorldNode,
  LuminaCoreSensorStatus,
  LuminaCoreTab,
} from "./lumina-core-types.ts";

registerEnglishCatalog(registerLuminaCoreEnglish);

export type LuminaCoreProps = {
  /** PluginPage's keyed host keeps this client fixed until the view is disposed. */
  initialClient: GatewayBrowserClient | null;
};

const TABS: ReadonlyArray<LuminaCoreTab> = [
  "live",
  "safety",
  "people",
  "world",
  "memory",
  "health",
  "robot",
  "developer",
];

type Act = ReturnType<typeof makeAction>;

function renderStatus(s: CoreStatePayload): JSX.Element {
  const o = s.safety.overrides;
  const p = s.privacy;
  return (
    <div class="chip-row">
      {s.safety.emergencyStop ? chip(t("luminaCore.status.emergencyStop"), false) : null}
      {o.paused
        ? chip(t("luminaCore.status.paused"), false)
        : chip(t("luminaCore.status.level", { level: String(s.self.autonomyLevel) }), true)}
      {chip(
        p.camera ? t("luminaCore.status.cameraOn") : t("luminaCore.status.cameraOff"),
        !p.camera,
      )}
      {chip(
        p.microphone ? t("luminaCore.status.micOn") : t("luminaCore.status.micOff"),
        !p.microphone,
      )}
      {p.privateMode
        ? chip(t("luminaCore.status.privateMode"), true)
        : chip(
            p.recording ? t("luminaCore.status.recording") : t("luminaCore.status.notRecording"),
            true,
          )}
      {s.mode && s.mode.mode !== "normal"
        ? chip(t("luminaCore.status.mode", { mode: t(`luminaCore.mode.${s.mode.mode}`) }), true)
        : null}
      {chip(t("luminaCore.status.body", { mode: s.self.body.mode }), true)}
      {chip(
        s.model ? t("luminaCore.status.model", { model: s.model }) : t("luminaCore.status.noModel"),
        Boolean(s.model),
      )}
    </div>
  );
}

function renderLive(s: CoreStatePayload): JSX.Element {
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
  return (
    <>
      {card(
        t("luminaCore.live.situation"),
        table(facts, [
          ["", (f) => f[0]],
          ["", (f) => f[1]],
        ]),
      )}
      {card(
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
      {card(
        t("luminaCore.live.staleBeliefs"),
        table(w.uncertainty.staleBeliefs, [
          [t("luminaCore.columns.what"), (b) => b.label],
          [t("luminaCore.columns.confidence"), (b) => b.confidence.toFixed(2)],
        ]),
      )}
    </>
  );
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

function renderTree(nodes: ReadonlyArray<CoreWorldNode>, act: Act): JSX.Element {
  return (
    <ul class="lumina-core__tree">
      {each(nodes, (node) => (
        <li>
          <span class="lumina-core__node">{node.label}</span>
          <span class="muted">{node.kind}</span>
          {act(t("luminaCore.world.forget"), "lumina.core.world.forget", { id: node.id })}
          {node.children.length > 0 ? renderTree(node.children, act) : null}
        </li>
      ))}
    </ul>
  );
}

function renderHealth(s: CoreStatePayload): JSX.Element {
  return (
    <>
      {card(
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
      {card(
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
      {card(
        t("luminaCore.health.sensors"),
        <>
          {table(s.self.sensors, [
            [t("luminaCore.columns.sensor"), (x) => x.kind],
            [
              t("luminaCore.health.available"),
              (x) => (x.available ? t("luminaCore.yes") : t("luminaCore.no")),
            ],
            [t("luminaCore.columns.detail"), (x) => x.detail ?? ""],
          ])}
          <div class="card-sub">{t("luminaCore.health.limitations")}</div>
          <ul class="lumina-core__list">
            {each(s.self.limitations, (line) => (
              <li>{line}</li>
            ))}
          </ul>
        </>,
      )}
    </>
  );
}

function renderRobot(s: CoreStatePayload, act: Act): JSX.Element {
  const teleoperators = s.people.filter((p) =>
    ["owner", "guardian", "technician"].includes(p.role),
  );
  const places = s.world.filter((n) => n.kind === "room" || n.kind === "location");
  return (
    <>
      {renderSimTraining(s, act)}
      {card(
        t("luminaCore.robot.body"),
        s.robot ? (
          <pre class="lumina-core__pre">
            {JSON.stringify(
              s.simulator ? { telemetry: s.robot, simulator: s.simulator } : s.robot,
              null,
              2,
            )}
          </pre>
        ) : (
          <p class="muted">{t("luminaCore.robot.noBody")}</p>
        ),
      )}
      {card(
        t("luminaCore.robot.teleop"),
        teleoperators.length === 0 ? (
          <p class="muted">{t("luminaCore.robot.noTeleoperator")}</p>
        ) : (
          each(teleoperators, (p) => (
            <div class="lumina-core__actions">
              <strong>{p.name}</strong>
              <span class="muted">{p.role}</span>
              {act(
                t("luminaCore.robot.stop"),
                "lumina.core.teleop",
                { personId: p.id, type: "stop" },
                "danger",
              )}
              {act(t("luminaCore.robot.wave"), "lumina.core.teleop", {
                personId: p.id,
                type: "gesture",
                name: "wave",
              })}
              {p.role === "technician"
                ? null
                : each(places, (place) =>
                    act(t("luminaCore.robot.goTo", { place: place.label }), "lumina.core.teleop", {
                      personId: p.id,
                      type: "navigate_to",
                      targetId: place.id,
                    }),
                  )}
            </div>
          ))
        ),
        t("luminaCore.robot.teleopHint"),
      )}
      {card(
        t("luminaCore.robot.requests"),
        table(s.body, [
          [t("luminaCore.columns.time"), (b) => clock(b.atISO)],
          [t("luminaCore.columns.intent"), (b) => b.intent.type],
          [t("luminaCore.columns.requestedBy"), (b) => b.requestedBy ?? "—"],
          [t("luminaCore.columns.verdict"), (b) => b.review.verdict],
          [t("luminaCore.columns.result"), (b) => b.outcome?.detail ?? "—"],
        ]),
      )}
    </>
  );
}

function renderReflection(s: CoreStatePayload, act: Act): JSX.Element {
  const report = s.reflection;
  return card(
    t("luminaCore.reflection.title"),
    <>
      <div class="lumina-core__actions">
        {act(t("luminaCore.reflection.run"), "lumina.core.reflect", {}, "primary")}
      </div>
      {report ? (
        <>
          {table(report.findings, [
            [t("luminaCore.columns.kind"), (f) => f.kind],
            [t("luminaCore.columns.what"), (f) => f.subject],
            [t("luminaCore.columns.detail"), (f) => f.detail],
          ])}
          {table(report.proposedLessons, [
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
          ])}
        </>
      ) : (
        <p class="muted">{t("luminaCore.reflection.none")}</p>
      )}
    </>,
    t("luminaCore.reflection.hint"),
  );
}

function renderEvaluation(s: CoreStatePayload, act: Act): JSX.Element {
  const report = s.evaluation;
  const failures = report ? report.results.filter((r) => !r.passed) : [];
  return card(
    t("luminaCore.evaluation.title"),
    <>
      <div class="lumina-core__actions">
        {act(t("luminaCore.evaluation.run"), "lumina.core.evaluate", {}, "primary")}
      </div>
      {report ? (
        <>
          <div class="chip-row">
            {each(Object.entries(report.scores), ([suite, score]) =>
              chip(`${suite} ${score.passed}/${score.total}`, score.passed === score.total),
            )}
          </div>
          <p class="muted">
            {t("luminaCore.evaluation.performance", {
              rate: String(report.performance.routerEventsPerSecond),
              p95: String(report.performance.loopP95Ms),
            })}
          </p>
          {failures.length > 0
            ? table(failures, [
                [t("luminaCore.columns.kind"), (r) => r.suite],
                [t("luminaCore.columns.what"), (r) => r.name],
                [t("luminaCore.columns.detail"), (r) => r.detail],
              ])
            : null}
        </>
      ) : (
        <p class="muted">{t("luminaCore.evaluation.none")}</p>
      )}
    </>,
    t("luminaCore.evaluation.hint"),
  );
}

function renderDeveloper(s: CoreStatePayload, act: Act): JSX.Element {
  return (
    <>
      {renderEvaluation(s, act)}
      {renderReflection(s, act)}
      {s.artifacts
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
        : null}
      {card(
        t("luminaCore.developer.cycles"),
        table(s.cycles, [
          [t("luminaCore.columns.time"), (c) => clock(c.atISO)],
          [t("luminaCore.columns.event"), (c) => `${c.event.source}:${c.event.kind}`],
          [t("luminaCore.columns.decision"), (c) => c.outcome ?? "—"],
          [t("luminaCore.columns.reason"), (c) => c.reason],
        ]),
      )}
      {card(
        t("luminaCore.developer.raw"),
        <pre class="lumina-core__pre">
          {JSON.stringify({ self: s.self, workspace: s.workspace }, null, 2)}
        </pre>,
      )}
    </>
  );
}

function renderPanel(state: ControllerState, client: GatewayBrowserClient | null): JSX.Element {
  const s = state.state;
  if (!s) {
    return <p class="muted">{state.error ?? t("luminaCore.loading")}</p>;
  }
  const act = makeAction(state, client);
  return {
    live: () => renderLive(s),
    safety: () => renderSafety(s, act),
    people: () => renderPeople(s, act),
    world: () =>
      card(
        t("luminaCore.world.title"),
        s.world.length > 0 ? (
          renderTree(s.world, act)
        ) : (
          <p class="muted">{t("luminaCore.world.empty")}</p>
        ),
      ),
    memory: () => renderMemory(s, act, state),
    health: () => renderHealth(s),
    robot: () => renderRobot(s, act),
    developer: () => renderDeveloper(s, act),
  }[state.tab]();
}

/**
 * The Lumina cognitive core tab. The controller owns the polled state; every
 * change bumps one revision, and the panels re-render from that state.
 */
export function LuminaCore(props: LuminaCoreProps): JSX.Element {
  const host = {};
  const state = getCoreState(host);
  const client = props.initialClient;
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  state.requestUpdate = () => setRevision((value) => value + 1);
  configureLuminaCorePolling(state, client);
  if (client && !state.state && !state.loading && !state.error) {
    void loadLuminaCore(state, client);
  }
  onCleanup(() => {
    state.requestUpdate = null;
    configureLuminaCorePolling(state, null);
    stopLuminaCorePolling(host);
  });
  const current = () => {
    revision();
    return state;
  };
  const tab = () => current().tab;
  const status = () => {
    const s = current().state;
    return s ? renderStatus(s) : null;
  };
  const notice = () => {
    const text = current().notice;
    return text ? (
      <div class="callout warn" role="status">
        {text}
      </div>
    ) : null;
  };
  const failure = () => {
    const { state: s, error } = current();
    return s && error ? (
      <div class="callout danger" role="alert">
        {error}
      </div>
    ) : null;
  };
  const face = () => {
    const expression = current().state?.expression;
    return expression ? (
      <openclaw-mascot
        class="lumina-core__face"
        mood={expression.expression}
        prop:size={64}
        title={expression.reason}
      />
    ) : null;
  };
  const panel = () => renderPanel(current(), client);
  return (
    <div class="lumina-core">
      <header class="lumina-core__header">
        {face()}
        <div class="lumina-core__heading">
          <div class="card-title">{t("luminaCore.title")}</div>
          <div class="card-sub">{t("luminaCore.subtitle")}</div>
        </div>
        <button
          class="btn btn--sm"
          type="button"
          disabled={!client || current().loading}
          onClick={() => void loadLuminaCore(state, client)}
        >
          {t("luminaCore.refresh")}
        </button>
      </header>
      {status()}
      {notice()}
      {failure()}
      <HubTabs
        id="lumina-core"
        active={tab()}
        tabs={TABS.map((value) => ({ value, label: t(`luminaCore.tabs.${value}`) }))}
        ariaLabel={t("luminaCore.tabsLabel")}
        panelId="lumina-core-panel"
        variant="sub"
        onSelect={(value) => {
          state.tab = value;
          state.requestUpdate?.();
        }}
      />
      <div id="lumina-core-panel" class="lumina-core__panel">
        <Show when={tab() === "memory" && Boolean(current().state?.memory)}>
          <MemorySearch state={state} />
        </Show>
        {panel()}
      </div>
    </div>
  );
}
