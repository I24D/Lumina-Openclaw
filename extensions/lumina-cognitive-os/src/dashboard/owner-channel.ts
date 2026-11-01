/**
 * owner-channel.ts — What a person sees and decides in the Control UI's Lumina tab.
 *
 * Lumina spec §49 (dashboard), §65–§72 (live, people, memory, world, robot,
 * model and developer views), §134 (teleoperation), §143 (a person's
 * overrides) and §41/§96/§125 (interaction modes). The Control UI reaches this through gateway methods that require
 * an authenticated operator session, so it is the owner channel the agent's
 * tools do not have. Only from here can a person resume, re-enable, turn
 * sensors back on, assign roles, grant recognition consent, forget someone,
 * re-arm the emergency stop, teleoperate and confirm a physical action.
 *
 * Transport-agnostic on purpose: gateway-methods.ts maps each command to an
 * RPC method and health-http.ts serves /health, /ready and /version, so the
 * logic lives once.
 *
 * Residual risk, stated plainly: an agent driving a browser that already holds
 * an operator session could reach these methods. Confirmations that no
 * software can forge need a physical button or a separate device (PLANNED).
 */
import type { CognitiveRuntime } from "../cognition/cognitive-runtime.js";
import { intentFromParams } from "../embodiment/body-tool.js";
import { BODY_INTENT_TYPES, type BodyIntentType } from "../embodiment/body.js";
import type { SimTraining } from "../embodiment/sim-training.js";
import type { Evaluation } from "../evaluation/core-eval.js";
import type { PrivacyChange } from "../privacy/privacy-state.js";
import { isRole } from "../safety/authority.js";
import { INTERACTION_MODES, type InteractionMode } from "../safety/interaction-mode.js";
import type { OverrideAction } from "../safety/overrides.js";
import { expressionOf } from "../social/expression.js";
import { memoryCommands, memoryState } from "./memory-channel.js";

const OWNER = { channel: "owner", actor: "dashboard" } as const;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,160}$/u;

export type OwnerChannelDeps = {
  readonly runtime: CognitiveRuntime;
  readonly version: string;
  /** Re-arm the global emergency stop; a person's action only. */
  readonly rearmEmergencyStop: () => void;
  readonly activeModel: () => string | undefined;
  /** The evaluation suite, run in sandboxes from the Lumina tab. */
  readonly evaluation?: Evaluation;
  /** Learning to move in simulation, when the body runs on MuJoCo. */
  readonly training?: SimTraining;
};

/** A request the channel will not run as given; nothing was changed. */
export class OwnerChannelError extends Error {}

type Params = Readonly<Record<string, unknown>>;

function idField(params: Params, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new OwnerChannelError(`${name} must be an id`);
  }
  return value;
}

function textField(params: Params, name: string): string | undefined {
  const value = params[name];
  return typeof value === "string" ? value : undefined;
}

function booleanFields<K extends string>(params: Params, keys: ReadonlyArray<K>) {
  const out: Partial<Record<K, boolean>> = {};
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "boolean") {
      out[key] = value;
    }
  }
  return out;
}

const OVERRIDE_TYPES = new Set([
  "pause",
  "resume",
  "stop_motion",
  "cancel_task",
  "disable_autonomy",
  "enable_autonomy",
  "disable_capability",
  "enable_capability",
]);

/** Places as a tree: rooms, then what is in or on them (spec §69). */
function worldTree(runtime: CognitiveRuntime) {
  const all = runtime.world.query();
  const children = new Map<string, typeof all>();
  for (const scored of all) {
    const place = scored.entity.position?.placeId;
    if (place) {
      children.set(place, [...(children.get(place) ?? []), scored]);
    }
  }
  const node = (id: string, depth: number): CoreWorldNode => {
    const entity = runtime.world.get(id);
    return {
      id,
      label: entity?.label ?? id,
      kind: entity?.kind ?? "unknown",
      children:
        depth >= 4 ? [] : (children.get(id) ?? []).map(({ entity: e }) => node(e.id, depth + 1)),
    };
  };
  const roots = all.filter(
    ({ entity }) =>
      entity.kind === "room" || entity.kind === "location" || !entity.position?.placeId,
  );
  return roots.map(({ entity }) => node(entity.id, 0));
}

export type CoreWorldNode = {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
  readonly children: ReadonlyArray<CoreWorldNode>;
};

/** The whole picture the Lumina tab shows, in one call. */
export function coreState(deps: OwnerChannelDeps) {
  const { runtime } = deps;
  const workspace = runtime.workspace.snapshot();
  const safety = runtime.safety.status();
  const presence = runtime.presence();
  const owner = runtime.people.owner();
  return {
    version: deps.version,
    workspace,
    self: runtime.selfModel(),
    // The avatar's face: functional state, never a claimed feeling (spec §28, §88).
    expression: expressionOf({
      emergencyStop: safety.emergencyStop,
      paused: safety.overrides.paused,
      pendingEvents: workspace.pendingEvents,
      ...(workspace.activeTask?.executed ? { lastExecutedAtISO: workspace.activeTask.atISO } : {}),
      presence,
      ...(owner ? { ownerId: owner.id } : {}),
      nowMs: Date.now(),
    }),
    safety,
    privacy: runtime.privacy.state(),
    mode: { ...runtime.modes.state(), restrictions: runtime.modes.restrictions() },
    people: runtime.people.list(),
    presence,
    world: worldTree(runtime),
    health: runtime.brainstem.status(),
    energy: runtime.energy(),
    robot: runtime.robot?.telemetry() ?? null,
    simulator: runtime.bodyAdapter.describe?.() ?? null,
    model: deps.activeModel() ?? null,
    audit: runtime.audit.recent(25),
    cycles: runtime.loop.recent(25),
    events: runtime.router.recent(25),
    body: runtime.body.recent(10),
    sensors: runtime.recognition.status(),
    reflection: runtime.reflection.latest() ?? null,
    evaluation: deps.evaluation?.latest() ?? null,
    artifacts: runtime.artifacts.checks(),
    simTraining: deps.training?.status() ?? null,
    memory: memoryState(runtime),
    persona: runtime.persona
      ? { current: runtime.persona.current() ?? null, versions: runtime.persona.history().length }
      : null,
  };
}

export type CoreState = ReturnType<typeof coreState>;

/** Commands a person runs from the Lumina tab, keyed by their gateway method name. */
export function createOwnerCommands(deps: OwnerChannelDeps) {
  const { runtime } = deps;
  const audited = (action: string, reason: string, ok: boolean) =>
    runtime.audit.append({
      actor: "owner:dashboard",
      action,
      reason,
      execution: ok ? "executed" : "refused",
    });

  return {
    ...memoryCommands(runtime, audited),
    "lumina.core.override": async (params: Params) => {
      const type = params.type;
      if (typeof type !== "string" || !OVERRIDE_TYPES.has(type)) {
        throw new OwnerChannelError("unknown override");
      }
      const action = (
        type === "disable_capability" || type === "enable_capability"
          ? { type, capability: idField(params, "capability") }
          : { type }
      ) as OverrideAction;
      return runtime.safety.override(action, OWNER);
    },
    "lumina.core.privacy": async (params: Params) =>
      runtime.privacy.set(
        booleanFields(params, [
          "microphone",
          "camera",
          "recording",
          "privateMode",
        ]) as PrivacyChange,
        OWNER,
      ),
    "lumina.core.confirm": async (params: Params) => {
      const id = idField(params, "id");
      return params.approve === true
        ? runtime.body.approve(id, OWNER)
        : { ok: runtime.body.reject(id, { actor: "owner:dashboard" }) };
    },
    "lumina.core.estop.rearm": async () => {
      deps.rearmEmergencyStop();
      audited("estop.rearm", "a person re-armed the emergency stop", true);
      return { ok: true };
    },
    "lumina.core.people.role": async (params: Params) => {
      const role = params.role;
      if (!isRole(role)) {
        throw new OwnerChannelError("unknown role");
      }
      const personId = idField(params, "personId");
      const r = runtime.people.setRole(personId, role, OWNER);
      audited("people.role", `${personId} -> ${role}`, r.ok);
      return r;
    },
    "lumina.core.people.consent": async (params: Params) => {
      const personId = idField(params, "personId");
      const consent = booleanFields(params, ["faceRecognition", "voiceRecognition", "recording"]);
      const r = runtime.people.setConsent(personId, consent, OWNER);
      audited("people.consent", `${personId} ${JSON.stringify(consent)}`, r.ok);
      // Revoked consent deletes the template, not only stops using it.
      if (r.ok && consent.faceRecognition === false) {
        runtime.recognition.forget(personId, "face");
      }
      if (r.ok && consent.voiceRecognition === false) {
        runtime.recognition.forget(personId, "voice");
      }
      return r;
    },
    "lumina.core.people.enroll": async (params: Params) => {
      const personId = idField(params, "personId");
      const modality = params.modality;
      if (modality !== "face" && modality !== "voice") {
        throw new OwnerChannelError("modality must be face or voice");
      }
      const r = await runtime.recognition.enroll(personId, modality);
      audited("people.enroll", `${personId} ${modality}`, r.ok);
      return r;
    },
    "lumina.core.people.forget": async (params: Params) => {
      const personId = idField(params, "personId");
      const ok = runtime.people.forget(personId);
      runtime.recognition.forget(personId);
      runtime.practice.forgetPerson(personId);
      audited("people.forget", personId, ok);
      return { ok };
    },
    "lumina.core.mode": async (params: Params) => {
      const mode = params.mode;
      if (
        typeof mode !== "string" ||
        !(INTERACTION_MODES as ReadonlyArray<string>).includes(mode)
      ) {
        throw new OwnerChannelError("unknown interaction mode");
      }
      return runtime.modes.set(mode as InteractionMode, OWNER);
    },
    "lumina.core.sim.train": async () => {
      if (!deps.training) {
        throw new OwnerChannelError("training needs the MuJoCo body (bodySimulator mujoco)");
      }
      const started = deps.training.start();
      audited("sim.train", started.reason ?? "started", started.started);
      return started;
    },
    "lumina.core.reflect": async () => runtime.reflection.run(),
    "lumina.core.evaluate": async () => {
      if (!deps.evaluation) {
        throw new OwnerChannelError("no evaluation suite here");
      }
      return deps.evaluation.run();
    },
    "lumina.core.lesson.accept": async (params: Params) => {
      const trigger = textField(params, "trigger")?.trim();
      const claim = textField(params, "claim")?.trim();
      if (!trigger || !claim || trigger.length > 160 || claim.length > 480) {
        throw new OwnerChannelError("a lesson needs a trigger and a claim");
      }
      const confidence =
        typeof params.confidence === "number" && Number.isFinite(params.confidence)
          ? Math.min(1, Math.max(0, params.confidence))
          : 0.6;
      const lesson = runtime.lessons.learn({ trigger, claim, confidence });
      audited("lesson.accept", `${trigger}: ${claim}`, true);
      return { ok: true, lesson };
    },
    "lumina.core.world.forget": async (params: Params) => {
      const id = idField(params, "id");
      const removed = runtime.world.forget(id);
      audited("world.forget", `${id}: ${removed} observations`, removed > 0);
      return { ok: true, removed };
    },
    "lumina.core.teleop": async (params: Params) => {
      const personId = idField(params, "personId");
      const type = params.type;
      if (
        typeof type !== "string" ||
        !(BODY_INTENT_TYPES as ReadonlyArray<string>).includes(type)
      ) {
        throw new OwnerChannelError("unknown body intent");
      }
      const intent = intentFromParams({
        type: type as BodyIntentType,
        targetId: textField(params, "targetId"),
        personId: textField(params, "targetPersonId"),
        objectId: textField(params, "objectId"),
        onId: textField(params, "onId"),
        name: textField(params, "name"),
      });
      return runtime.teleop.request(personId, intent);
    },
  } as const;
}

export type OwnerCommandName = keyof ReturnType<typeof createOwnerCommands>;
