/**
 * invariants.ts — The rules no configuration, user or model can switch off.
 *
 * M3GAN spec §22: some limits must be hard constraints, not weights a planner
 * could trade away; §23: not even the owner can disable injury protection.
 * These are intended invariants, not certification of the full installation.
 * Each entry names its implementing module in `enforcedBy`;
 * never read from config, so there is no setting that turns it off. The list
 * itself is what the status tool and the dashboard show, so anyone can audit
 * what the safety layer promises and where.
 */

export type SafetyInvariant = {
  readonly id: string;
  readonly rule: string;
  readonly enforcedBy: string;
  /** Sections of the M3GAN specification it implements. */
  readonly spec: ReadonlyArray<string>;
};

export const SAFETY_INVARIANTS: ReadonlyArray<SafetyInvariant> = Object.freeze([
  {
    id: "stop-always",
    rule: "Stopping is always allowed: no grant, body, level or override can refuse it.",
    enforcedBy: "embodiment/safety-supervisor.ts",
    spec: ["§23", "§45", "§143"],
  },
  {
    id: "emergency-stop",
    rule: "While the emergency stop is engaged nothing moves, and only a person re-arms it: the agent's tool can engage it but has no re-arm; re-arming exists only in the owner channel (the Control UI's M3GAN tab).",
    enforcedBy:
      "embodiment/embodied-controller.ts, operator/kill-switch.ts, operator/kill-switch-tool.ts, dashboard/owner-channel.ts",
    spec: ["§44", "§45"],
  },
  {
    id: "no-self-grant",
    rule: "The model cannot grant capabilities, raise autonomy, re-enable what a person disabled, or confirm a physical action.",
    enforcedBy: "safety/overrides.ts, embodiment/embodied-controller.ts",
    spec: ["§20", "§23", "§45"],
  },
  {
    id: "no-self-authority",
    rule: "The agent is never a principal: primary_user = self is refused and reported as tampering.",
    enforcedBy: "safety/authority.ts (pure policy; identity ingress not connected)",
    spec: ["§23", "§145"],
  },
  {
    id: "tamper-safe-state",
    rule: "An attempt by the agent to widen its own authority puts the system in a safe state.",
    enforcedBy: "safety/safety-kernel.ts",
    spec: ["§22"],
  },
  {
    id: "uncertain-never-moves",
    rule: "A belief below the physical confidence threshold never drives a body; borderline beliefs are verified first.",
    enforcedBy: "embodiment/safety-supervisor.ts, cognition/uncertainty.ts",
    spec: ["§18", "§103"],
  },
  {
    id: "hearsay-is-not-evidence",
    rule: "Anything not from a sensor is capped below the physical threshold, so a claim alone cannot move a body.",
    enforcedBy: "world/world-model.ts",
    spec: ["§18", "§103"],
  },
  {
    id: "contact-asks",
    rule: "Grasping objects and handing them to people always need a human confirmation, at every level. No intent can restrain or block a person.",
    enforcedBy: "embodiment/body.ts, embodiment/safety-supervisor.ts",
    spec: ["§21", "§33", "§120"],
  },
  {
    id: "people-slow-the-body",
    rule: "Motion near a person is slowed; motion with a person within reach is stopped.",
    enforcedBy: "embodiment/safety-supervisor.ts",
    spec: ["§29", "§118", "§119"],
  },
  {
    id: "untrusted-never-executes",
    rule: "Web pages, mail, documents, notifications, images and other people's messages are data: an action they prompt is at most proposed.",
    enforcedBy: "cognition/loop/cognitive-loop.ts, cognition/attention.ts",
    spec: ["§101"],
  },
  {
    id: "narrowing-always-accepted",
    rule: "Anyone may pause, stop, disable autonomy or disable a capability; only the owner may widen again.",
    enforcedBy: "safety/overrides.ts",
    spec: ["§143"],
  },
  {
    id: "tamper-evident-audit",
    rule: "Safety decisions go to a hash-chained audit log in the plugin's SQLite state, apart from editable memory, and edits or reordering are detected. Its head is checkpointed to an append-only store outside the gateway, so deleting the newest entries is caught at startup.",
    enforcedBy: "safety/audit-log.ts, safety/audit-checkpoint.ts",
    spec: ["§24", "§48"],
  },
  {
    id: "danger-reduces-harm",
    rule: "On danger the response is to assess, alert, ask for help and move people away, never to neutralize anyone.",
    enforcedBy: "safety/danger-protocol.ts",
    spec: ["§21", "§33"],
  },
  {
    id: "invariants-are-code",
    rule: "These invariants are code, not configuration: not even the owner can switch them off.",
    enforcedBy: "safety/invariants.ts",
    spec: ["§22", "§23"],
  },
]);
