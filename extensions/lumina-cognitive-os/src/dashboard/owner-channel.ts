/**
 * owner-channel.ts — What a person sees and decides in the Control UI's M3GAN tab.
 *
 * M3GAN spec §49 (dashboard), §65–§72 (live, people, memory, world, robot,
 * model and developer views), §134 (teleoperation) and §143 (a person's
 * overrides). The Control UI reaches this through gateway methods that require
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
import type { PrivacyChange } from "../privacy/privacy-state.js";
import { isRole } from "../safety/authority.js";
import type { OverrideAction } from "../safety/overrides.js";

const OWNER = { channel: "owner", actor: "dashboard" } as const;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,160}$/u;

export type OwnerChannelDeps = {
  readonly runtime: CognitiveRuntime;
  readonly version: string;
  /** Re-arm the global emergency stop; a person's action only. */
  readonly rearmEmergencyStop: () => void;
  readonly activeModel: () => string | undefined;
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
  const node = (id: string, depth: number): M3ganWorldNode => {
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

export type M3ganWorldNode = {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
  readonly children: ReadonlyArray<M3ganWorldNode>;
};

/** The whole picture the M3GAN tab shows, in one call. */
export function m3ganState(deps: OwnerChannelDeps) {
  const { runtime } = deps;
  return {
    version: deps.version,
    workspace: runtime.workspace.snapshot(),
    self: runtime.selfModel(),
    safety: runtime.safety.status(),
    privacy: runtime.privacy.state(),
    people: runtime.people.list(),
    presence: runtime.presence(),
    world: worldTree(runtime),
    health: runtime.brainstem.status(),
    energy: runtime.energy(),
    robot: runtime.robot?.telemetry() ?? null,
    model: deps.activeModel() ?? null,
    audit: runtime.audit.recent(25),
    cycles: runtime.loop.recent(25),
    events: runtime.router.recent(25),
    body: runtime.body.recent(10),
  };
}

export type M3ganState = ReturnType<typeof m3ganState>;

/** Commands a person runs from the M3GAN tab, keyed by their gateway method name. */
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
    "m3gan.override": async (params: Params) => {
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
    "m3gan.privacy": async (params: Params) =>
      runtime.privacy.set(
        booleanFields(params, [
          "microphone",
          "camera",
          "recording",
          "privateMode",
        ]) as PrivacyChange,
        OWNER,
      ),
    "m3gan.confirm": async (params: Params) => {
      const id = idField(params, "id");
      return params.approve === true
        ? runtime.body.approve(id, OWNER)
        : { ok: runtime.body.reject(id, { actor: "owner:dashboard" }) };
    },
    "m3gan.estop.rearm": async () => {
      deps.rearmEmergencyStop();
      audited("estop.rearm", "a person re-armed the emergency stop", true);
      return { ok: true };
    },
    "m3gan.people.role": async (params: Params) => {
      const role = params.role;
      if (!isRole(role)) {
        throw new OwnerChannelError("unknown role");
      }
      const personId = idField(params, "personId");
      const r = runtime.people.setRole(personId, role, OWNER);
      audited("people.role", `${personId} -> ${role}`, r.ok);
      return r;
    },
    "m3gan.people.consent": async (params: Params) => {
      const personId = idField(params, "personId");
      const consent = booleanFields(params, ["faceRecognition", "voiceRecognition", "recording"]);
      const r = runtime.people.setConsent(personId, consent, OWNER);
      audited("people.consent", `${personId} ${JSON.stringify(consent)}`, r.ok);
      return r;
    },
    "m3gan.people.forget": async (params: Params) => {
      const personId = idField(params, "personId");
      const ok = runtime.people.forget(personId);
      audited("people.forget", personId, ok);
      return { ok };
    },
    "m3gan.world.forget": async (params: Params) => {
      const id = idField(params, "id");
      const removed = runtime.world.forget(id);
      audited("world.forget", `${id}: ${removed} observations`, removed > 0);
      return { ok: true, removed };
    },
    "m3gan.teleop": async (params: Params) => {
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
