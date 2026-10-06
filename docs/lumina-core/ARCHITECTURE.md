# Lumina cognitive core architecture

How Lumina's cognitive core is put together inside LUMINA OpenClaw, what crosses which boundary, and where
each piece of state lives. Status words follow §164 of the master specification. Paths are relative
to `extensions/lumina-cognitive-os/src/` unless they say otherwise.

## Principle

Lumina is not the body, not the model and not the database (§158). It is the continuity of identity,
memory, world model, cognition, relationships, abilities and history. So:

- models are replaceable engines behind OpenClaw's provider routing (§3.4, §106);
- durable state lives in OpenClaw's SQLite plugin state and Supabase, never inside a model;
- cognition, safety and physical control are separate layers with one-way contracts (§2, §160).

## Layers

```text
  IDENTITY        lumina-context-engine (who Lumina is, how to use the core), Supabase identity
       │
  COGNITION       thalamic router → attention queue → cognitive loop
                  global workspace, self model, goals, lessons, consolidation, planner
       │
  MODELS          world model · people, presence, theory of mind, affect · working/episodic memory
       │
  SAFETY          safety kernel: invariants, authority, overrides, danger protocol, audit log
                  privacy states · brainstem (health, energy, safe state)
       │
  EMBODIMENT      embodied controller → safety supervisor → body adapter (none | simulated)
                  behaviors, predict, HAL, digital twin
       │
  BODY            simulated desktop robot (MOCK) · ROS 2 / hardware (PLANNED)
```

| Layer      | Code                                                                                                     | Status                                                         |
| ---------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Identity   | `extensions/lumina-context-engine/prompt.ts`, Supabase identity tables                                   | IMPLEMENTED                                                    |
| Cognition  | `cognition/router`, `cognition/attention*.ts`, `cognition/loop`, `cognition/workspace`, `cognition/self` | IMPLEMENTED (the loop proposes; it does not execute by itself) |
| World      | `world/world-model.ts`, `world/world-perception.ts`                                                      | IMPLEMENTED                                                    |
| Social     | `social/people.ts`, `social/presence.ts`, `social/theory-of-mind.ts`, `social/affect.ts`                 | IMPLEMENTED in software; no camera or voice identification     |
| Safety     | `safety/*`, `privacy/*`, `brainstem/*`                                                                   | IMPLEMENTED in software; hardware interlocks PLANNED           |
| Embodiment | `embodiment/*`                                                                                           | IMPLEMENTED against the simulator; HAL is INTERFACE ONLY       |
| Body       | `embodiment/simulated-robot.ts`                                                                          | MOCK                                                           |

The composition root is `cognition/cognitive-runtime.ts`, which assembles the layers, and
`cognition/plugin-wiring.ts`, which connects them to the OpenClaw host. Lower layers never import
the composition root. There are no import cycles between files.

## Data flow

```text
awareness poller ──┐
screen perception ─┤ (untrusted)
agent tools ───────┼─▶ thalamic router ──admit? (privacy)──┬─▶ world model     (every event)
camera, mic (PLANNED)                                      └─▶ attention queue ─▶ cognitive loop
                                                                                    │ proposes
goals, lessons, people, presence, privacy, health, energy, body ─▶ global workspace │
                                                                                    ▼
                                      safety kernel ◀── agent tools ── embodied controller
                                           │                                │
                                     audit log (SQLite)            safety supervisor
                                                                            │ intents only
                                                                       body adapter
```

1. Every input becomes an `LuminaCoreEvent` from the event catalog (`events/catalog.ts`). Payloads are
   validated with TypeBox schemas; `CORE_EVENT_SCHEMA_VERSION` versions the contract.
2. The thalamic router asks the privacy layer whether to admit the event (with the microphone or
   camera off, events from those sensors are dropped; while nothing may be remembered, new world
   observations are dropped), then sends it to the world model and the attention queue.
3. The attention queue ranks by salience. Emergencies preempt the running cycle through an abort
   signal.
4. The cognitive loop handles one event at a time. Events from untrusted sources (web, email,
   documents, notifications, images, QR, OCR, other people's messages) can at most be proposed.
5. The global workspace is the single picture of the moment that tools and the context engine read.

## Event catalog (shared schemas)

`events/catalog.ts` is the one place event kinds are declared, with their payload schema and default
importance and urgency (trust is set per event or follows its source):

`person.detected`, `person.left`, `speech.recognized`, `object.moved`, `task.created`,
`tool.completed`, `battery.low`, `navigation.finished`, `robot.touched`, `memory.retrieved`,
`world.observed`, `danger.detected`, `privacy.changed`, `subsystem.health`, `screen.foreground`,
`screen.changed`.

New producers add a kind here first. A transport (NATS, MQTT or ROS 2) can later carry the same
envelope behind `ThalamicRouter.ingest()` without changing consumers.

## Trust boundaries and authority

- **The model never drives a motor.** It can emit body intents (`look_at`, `navigate_to`,
  `grasp`...). Trajectories and motor commands live behind `BodyAdapter` and the HAL.
- **Every check only narrows.** The supervisor, the autonomy levels, the overrides and the privacy
  states can turn "allow" into "confirm", "deny" or "stop", never the reverse.
- **Tools narrow, people widen.** Agent tools can pause, stop motion, cancel, disable autonomy,
  disable a capability, switch a sensor off and engage the emergency stop. Resuming, re-enabling,
  switching a sensor back on, assigning roles, granting recognition consent, confirming a physical
  action, teleoperating and re-arming the emergency stop exist only in the Control UI's Lumina tab
  (the owner channel).
- **The agent is never a principal.** Registering the agent as a person or as `primary_user` is
  refused and reported as tampering, and tampering puts the system in a safe state.
- **Authority and objectives.** Roles rank owner, guardian, user, technician, guest. Conflicts
  resolve by role and then by the fixed objective order: human safety, rights and autonomy,
  legitimate authority, privacy, preferences, task completion (`safety/authority.ts`).
- **Danger reduces harm.** The danger protocol assesses, alerts, asks for help and moves people
  away. Neutralizing, restraining, blocking, striking or pursuing a person is forbidden.
- **Invariants are code.** `safety/invariants.ts` lists them with the module that enforces each
  and the sections they come from. Configuration cannot switch them off, not even the owner's.

## Persistence

| Namespace (SQLite plugin state) | Contents                                     | Module                     |
| ------------------------------- | -------------------------------------------- | -------------------------- |
| `m3gan.audit`                   | Hash-chained safety audit records            | `safety/audit-log.ts`      |
| `m3gan.overrides`               | Pauses, disabled capabilities, queued orders | `safety/overrides.ts`      |
| `m3gan.world`                   | World observations (event-sourced)           | `world/world-model.ts`     |
| `m3gan.privacy`                 | Microphone, camera, recording, private mode  | `privacy/privacy-state.ts` |
| `m3gan.people`                  | People, roles, consent                       | `social/people.ts`         |
| `m3gan.beliefs`                 | Theory-of-mind beliefs                       | `social/theory-of-mind.ts` |

The `m3gan.` prefix is historic: it stays so the stored state, the audit chain included, survives
the rename to LUMINA (ADR 0010). All of them use `KeyedLog` (`shared/state-store.ts`): ordered keys, hydration before the first
write, serialized appends, and no write at all if hydration failed. While a store is loading, the
safe default applies: overrides read as paused and sensors read as off.

Only the gateway's live registration (`registrationMode === "full"`) opens these stores and starts
timers, sidecars and the hotkey. Discovery and CLI loads describe the tools against session-only
state, so two processes never append to one audit chain.

Goals, lessons and episodic memory still use the older JSONL files under the plugin's memory folder;
moving them to SQLite state is a task in `TASKS.md`.

## Health and observability

- `brainstem/brainstem.ts` runs probes without any model: awareness, network, energy, stores,
  audit chain, body, privacy and model availability. A critical probe puts the system in a safe
  state; recovery never resumes on its own.
- The plugin serves `GET /health` (503 when down), `GET /ready` and `GET /version` under
  `/plugins/lumina-cognitive-os/core`, behind gateway authentication.
- Kernel, brainstem and body decisions go to the transparency log that people see, and the agent
  can explain a decision from the audit and the loop's cycles (`lumina_explain`).

## The Lumina tab (owner channel)

The Control UI renders the Lumina tab natively, like Logbook (`ui/src/pages/plugin/lumina-core-view.ts`).
It reads `lumina.core.state` and calls one gateway method per command; reads need `operator.read`,
commands need `operator.write`. The commands live once in `dashboard/owner-channel.ts`;
`dashboard/gateway-methods.ts` maps them to methods and `dashboard/health-http.ts` serves the
probes. Views: live, safety, people, world, health, robot (with teleoperation) and developer.

## Agent tools of the core

`lumina_workspace`, `lumina_self_model`, `lumina_goal`, `lumina_world_observe`,
`lumina_world_query`, `lumina_body`, `lumina_behavior`, `lumina_safety`, `lumina_explain`,
`lumina_privacy`, `lumina_people`, `lumina_mind`, `lumina_health`.

## Configuration

Plugin config in `openclaw.json` under `plugins.entries["lumina-cognitive-os"].config`:

- `cognitiveCoreEnabled` (default true) turns the core off and keeps the rest of the extension.
- `autonomyLevel` (0 to 5, default 3) caps initiative. L3 notices and proposes but asks first.
- `bodyMode` is `none` (every physical intent is refused) or `simulated`.
- `grantedCapabilities` lists body capabilities a person allows: `robot.look`, `robot.gesture`,
  `robot.navigate`, `robot.grasp`, `robot.handover`.
- `preAuthorizedCapabilities` lists granted ones that may run without asking at L4 and above, and
  only when reversible and low risk. Grasping and handing over always ask.
- `ownerName` names the owner seeded into the people registry.

No agent tool writes this config.

## Dependency map

```text
shared   ◀── every layer
events   ──▶ cognition/attention, world/world-model (types)
world    ──▶ cognition/uncertainty, cognition/router, events, shared
social   ──▶ safety/authority, world, cognition/uncertainty, events, shared
privacy  ──▶ cognition/attention, shared
safety   ──▶ cognition/loop, cognition/autonomy-levels, embodiment/controller, shared
embodiment ─▶ safety/audit-log, world, cognition/{self,uncertainty,autonomy-levels}, brainstem
brainstem ─▶ shared
dashboard ─▶ cognition/cognitive-runtime, safety, privacy, embodiment (owner channel)
cognition/cognitive-runtime ──▶ everything above (composition root)
```

`cognition/` holds both leaf contracts (attention, uncertainty, autonomy levels, self model) and
the composition root, so folders import each other in both directions even though files do not.
Splitting the contracts out is a task in `TASKS.md`.
