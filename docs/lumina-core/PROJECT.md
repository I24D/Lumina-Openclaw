# Project LUMINA: the cognitive core

LUMINA is a persistent, embodied, multimodal agent that lives first in software and later in a
body, keeping one identity and one memory across both. It is built inside LUMINA OpenClaw, not
beside it. The master specification calls the project "M3GAN REAL": the film M3GAN is only the
conceptual reference, the lessons of what went wrong, and the AI being built is LUMINA, one identity
(ADR 0010). This page is the first deliverable the master specification asks for (§165): what exists,
what is missing, the target, and the first tasks.

Section numbers (§) refer to the master specification, which is kept outside this repository. The
status words follow §164: IMPLEMENTED, PARTIAL, MOCK, INTERFACE ONLY, PLANNED, BLOCKED and NOT
IMPLEMENTED. Nothing here claims a capability the code does not have.

Related pages in this folder:

- `ARCHITECTURE.md`: layers, data flow, trust boundaries and the dependency map.
- `ROADMAP.md`: milestones v0.1 to v1.0.
- `TASKS.md`: the ordered engineering backlog, with an owner per task.
- `SECTION_MAP.md`: status of every section of the specification.
- `adr/`: architecture decision records.
- `LUMINA_STATUS.md` at the repository root: the live checkpoint every session updates (§163).

## 1. Executive summary

LUMINA already had most of the digital half: models behind a router with fallback, memory in
Supabase and a memory wiki, voice through Start Talk, screen vision, PC and browser control, skills,
and a transparency log. The cognitive core adds the half that makes it an agent with a situation and a body:

- a **cognitive core** (thalamic router, attention, cognitive loop, global workspace, self model);
- a **world model** with confidence that decays, history and relations;
- a **social layer** (people with roles and consent, presence, theory of mind, affect estimates);
- a **safety kernel** that is code, not prompts: invariants, an authority hierarchy, human
  overrides, a danger protocol and a hash-chained audit log;
- a **brainstem** (health probes, energy, safe state) that does not depend on a model;
- an **embodied layer** behind a safety supervisor, a hardware abstraction layer and a simulated
  desktop robot with its digital twin;
- **privacy states** a person controls, and a native **Lumina tab** in the Control UI that is the
  owner's channel.

All of it lives in the `lumina-cognitive-os` extension, persists in OpenClaw's SQLite plugin state,
and is covered by tests. Milestone **LUMINA CORE v0.1** is mostly met in software; there is no
physical hardware, so every body path runs against the simulator (MOCK) or stops at an interface.

## 2. Existing architecture

| Area                    | What exists                                                                          | Where                                                      |
| ----------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| Gateway and agents      | OpenClaw gateway, sessions, channels (Discord, Telegram, WhatsApp), cron, Control UI | `src/`, `ui/`                                              |
| Models                  | Provider plugins (Anthropic, GitHub Copilot, Google, Ollama, OpenAI) with fallbacks  | `extensions/<provider>`                                    |
| Shared memory           | Supabase tables and the memory wiki, with local embeddings                           | `extensions/lumina-supabase`, `memory-wiki`, `memory-core` |
| Prompt context          | Lumina identity and guidance injected on every turn                                  | `extensions/lumina-context-engine`                         |
| Voice                   | Start Talk on Gemini Live with barge-in                                              | `ui/src/ui/chat`                                           |
| PC and browser autonomy | UI Automation, OmniParser, smart click and type, Playwright, the `lumina_pc_do` loop | `extensions/lumina-cognitive-os/src/{vision,operator}`     |
| Skills                  | Loader, runner, evaluation, learning from a recording                                | `extensions/lumina-cognitive-os/src/{skills,recorder}`     |
| Governance and risk     | Risk engine, governance policy, transparency log, kill switch                        | `extensions/lumina-cognitive-os/src/{risk,governance}`     |

## 3. Reusable modules

Every new module of the core was built on these instead of beside them:

- OpenClaw's model routing and fallbacks are the model router (§3.4); nothing duplicates them.
- OpenClaw's SQLite plugin state (`api.runtime.state.openKeyedStore`) holds every durable core
  record through one `KeyedLog` helper (`src/shared/state-store.ts`).
- The awareness poller feeds the router, so battery, network and device changes become events.
- The screen perception sidecar feeds the router as untrusted `screen.*` events.
- The kill switch is the emergency stop for both the PC operator and the body.
- The transparency log shows kernel, brainstem and body decisions to people.
- The planner (`src/action/planner.ts`) gained hierarchical fields instead of a second planner.

## 4. Missing modules

Still missing or partial, with the reason. Details per section are in `SECTION_MAP.md`.

- **Hardware**: no body, motors, depth camera, touch or IMU exist (§24 to §31, §115 to §117).
  Interfaces and a simulator stand in; a ROS 2 bridge and a physics simulator are PLANNED.
- **Camera perception**: face detection and authorized recognition are NOT IMPLEMENTED. The
  consent model and the event contracts are ready.
- **Speaker identification and diarization**: NOT IMPLEMENTED (§8).
- **A reasoner that proposes actions from the loop**: the loop observes and proposes; it never
  executes on its own.
- **Teleoperation** (§134), **curiosity** (§92), **affordances** (§122), **dataset system**
  (§135) and **reinforcement learning** (§133): PLANNED.
- **Independent hardware watchdog** and a physical confirmation button: PLANNED.

## 5. Technical risks

| Risk                                                     | Mitigation in place                                                                      | Residual                                                                 |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| The model widens its own authority                       | Tools only narrow; widening exists only behind the owner channel; tampering → safe state | An agent driving a browser that holds an operator session could reach it |
| Prompt injection through web, mail, notifications or OCR | Untrusted sources can only produce proposals, never execution                            | Classification depends on each event carrying its true source            |
| Audit tampering                                          | Hash chain in SQLite, apart from editable memory; `verify()` and `verifyStored()`        | Tail deletion across a restart needs an external checkpoint              |
| Two processes writing one durable log                    | Only the gateway's live registration opens the stores; other loads are session-only      | A gateway reload that overlaps its old registry for a moment             |
| Tool list bloat and name collisions                      | One owner per tool name, enforced by a contract test across every `lumina-*` extension   | The extension still registers about 120 tools                            |
| Hardware arrives before the safety path is proven        | Simulation first; physical learning only through simulation, evaluation and validation   | Real-time control and hardware interlocks are not built                  |

## 6. Target architecture

Cognition, safety and physical control stay separate (§2, §160). Events flow from sensors and tools
through the thalamic router into the world model and the attention queue. The cognitive loop reads
the global workspace and can only propose. Every action passes the safety kernel; physical actions
also pass the safety supervisor and reach a body adapter as intents, never as motor commands. The
full picture is in `ARCHITECTURE.md`.

## 7. Repository structure

The core's code is one extension, organized by layer:

```text
extensions/lumina-cognitive-os/src/
  events/       event catalog: kinds, payload schemas, priors (the shared schemas)
  cognition/    router, attention, loop, workspace, self model, consolidation, runtime, wiring
  world/        world model, perception hook, world tools
  social/       people, presence, theory of mind, affect, social tools
  safety/       invariants, authority, overrides, danger protocol, audit log, kernel, tools
  privacy/      privacy states and their tool
  brainstem/    health probes, energy, safe state, health tool
  embodiment/   intents, supervisor, controller, behaviors, predict, HAL, simulated robot
  dashboard/    owner channel: commands, gateway methods, /health /ready /version
  shared/       ids (ULID), keyed state store, tool helpers
docs/lumina-core/     this documentation
LUMINA_STATUS.md live checkpoint
```

## 8. Implementation phases

Following §150, brain first and body last:

1. Infrastructure: schemas, event catalog, ids, durable state (done).
2. Cognitive core, world model, planner fields (done).
3. Safety kernel, privacy, brainstem, social layer, dashboard (done).
4. Activation in the live gateway and live verification (this cycle).
5. Perception: camera pipeline, authorized recognition, speaker identification (v0.2).
6. Autonomy: persistent tasks, workflows, reflection, delegation results (v0.3).
7. Simulation: a physics simulator and a ROS 2 bridge as body adapters (v0.4).
8. Hardware: a first physical prototype without legs (v0.5), then the humanoid (v1.0).

## 9. First 20 engineering tasks

Status as of 2026-10-05. The live backlog with owners is `TASKS.md`.

| #   | Task                                                                   | Status      |
| --- | ---------------------------------------------------------------------- | ----------- |
| 1   | Event catalog with typed, validated payloads and priors                | IMPLEMENTED |
| 2   | ULID entity ids and a keyed durable log over SQLite plugin state       | IMPLEMENTED |
| 3   | Thalamic router with an admission gate (privacy) and untrusted sources | IMPLEMENTED |
| 4   | World model on the keyed log: history, relations, forgetting, decay    | IMPLEMENTED |
| 5   | Safety invariants, authority hierarchy and conflict resolution         | IMPLEMENTED |
| 6   | Human overrides that only narrow, owner-only widening, tamper flag     | IMPLEMENTED |
| 7   | Hash-chained audit log with stored-chain verification                  | IMPLEMENTED |
| 8   | Danger protocol that reduces harm and never neutralizes                | IMPLEMENTED |
| 9   | Privacy states with sensor shutdown and session forgetting             | IMPLEMENTED |
| 10  | Brainstem probes, energy policy and a safe state                       | IMPLEMENTED |
| 11  | People with roles and consent, presence, theory of mind, affect        | IMPLEMENTED |
| 12  | Supervisor aware of people, pauses, disabled capabilities and battery  | IMPLEMENTED |
| 13  | Behaviors and the handover protocol over body intents                  | IMPLEMENTED |
| 14  | HAL interfaces, a digital twin description and a simulated robot       | MOCK        |
| 15  | Dashboard with /health, /ready, /version and the owner channel         | IMPLEMENTED |
| 16  | Context-engine guidance so the agent knows the core exists             | IMPLEMENTED |
| 17  | Activate the extension in the live gateway and verify it               | IN PROGRESS |
| 18  | Teleoperation through the supervisor with a requester identity         | PLANNED     |
| 19  | Move legacy JSONL stores (goals, lessons, episodic) to SQLite state    | PLANNED     |
| 20  | Camera pipeline with consented recognition feeding `person.detected`   | PLANNED     |

## 10. Files created or modified

Created: `src/events`, `src/safety` (beside the older risk and governance modules), `src/privacy`,
`src/brainstem`, `src/social`, `src/dashboard`, `src/shared/ids.ts`, `src/shared/state-store.ts`,
the behavior, prediction, HAL and simulator modules in `src/embodiment`, and this folder.

Modified: the cognitive runtime and plugin wiring, the router, loop, attention, world model,
planner, supervisor, controller, body tool, the kill-switch tool (it no longer re-arms), the plugin
entry and manifest, the tool contract test, and the `lumina-context-engine` prompt. The duplicated
Supabase table tools were removed from this extension; `lumina-supabase` owns them.
