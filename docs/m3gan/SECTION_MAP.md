# M3GAN REAL section map

Every section of the master specification, mapped to the code that implements it and an honest
status (§164). Claude Code, Codex and contributors extend what is listed here instead of writing it
twice. Paths are relative to `extensions/lumina-cognitive-os/src/` unless they say otherwise.

| Status          | Meaning                                                                 |
| --------------- | ----------------------------------------------------------------------- |
| IMPLEMENTED     | Built, tested, and wired into the runtime                               |
| PARTIAL         | A real piece exists; the gap is named                                   |
| MOCK            | Runs against a simulated stand-in, not the real thing                   |
| INTERFACE ONLY  | Types and contracts exist; nothing implements them yet                  |
| PLANNED         | Designed and scheduled in `TASKS.md` or `ROADMAP.md`; no code yet       |
| BLOCKED         | Cannot proceed until something outside the code exists (hardware, keys) |
| NOT IMPLEMENTED | Nothing exists yet and it is not scheduled                              |

## Part I: lessons from the films (§1 to §36)

The first part analyzes why the fictional M3GAN failed and turns each failure into a design rule.
The rules and where they are enforced:

| §                           | Rule                                                  | Enforced by                                                           | Status      |
| --------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------- | ----------- |
| 5–7                         | "Protect" never means control; parents keep authority | `safety/authority.ts` (objective order, roles), `safety/overrides.ts` | IMPLEMENTED |
| 12                          | Internet is a tool, not part of the mind              | Untrusted sources only propose (`cognition/loop/cognitive-loop.ts`)   | IMPLEMENTED |
| 13                          | Shutdown must always work                             | Stop is always allowed; emergency stop re-armed only by a person      | IMPLEMENTED |
| 14                          | No strategic deception                                | Audit log apart from editable memory; `lumina_explain`                | PARTIAL     |
| 21                          | The AI does not drive the body directly               | Intents only, `embodiment/safety-supervisor.ts`, HAL                  | IMPLEMENTED |
| 22                          | Safety laws are constraints, not weights              | `safety/invariants.ts` (code, not configuration)                      | IMPLEMENTED |
| 23                          | A correct hierarchy of authority                      | `safety/authority.ts`; the agent can never be a principal             | IMPLEMENTED |
| 24                          | Separate memories; safety logs not editable           | `safety/audit-log.ts` hash chain in its own namespace                 | IMPLEMENTED |
| 25                          | Online learning limited                               | Lessons and routines are proposals (`cognition/consolidation.ts`)     | IMPLEMENTED |
| 26                          | Internet as a tool                                    | Trust per event source (`cognition/attention.ts`)                     | IMPLEMENTED |
| 27                          | Physical and cognitive autonomy are different levels  | Autonomy levels plus per-capability grants and pre-authorizations     | IMPLEMENTED |
| 28                          | A second system watching the first                    | Deterministic supervisor and brainstem; no second model               | PARTIAL     |
| 29                          | Mechanical safety                                     | Needs hardware                                                        | BLOCKED     |
| 30                          | Personality is never the safety layer                 | Safety lives in code; the prompt only explains it                     | IMPLEMENTED |
| 32                          | An explicit objective function                        | Fixed objective order in `safety/authority.ts`                        | IMPLEMENTED |
| 33                          | Danger response reduces harm                          | `safety/danger-protocol.ts`, forbidden responses                      | IMPLEMENTED |
| 1–4, 8–11, 15–20, 31, 34–36 | Analysis and context                                  | Informs the rules above                                               | n/a         |

## Part II: the engineering specification (§1 to §165)

| §       | Piece                                                       | Status          | Code / gap                                                                                                                        |
| ------- | ----------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1       | Relationship with LUMINA                                    | IMPLEMENTED     | Built inside LUMINA OpenClaw; Supabase stays the shared memory; models are replaceable                                            |
| 2       | Architectural principle (layers)                            | IMPLEMENTED     | See `ARCHITECTURE.md`; cognition, safety and body are separate layers                                                             |
| 3.1     | Brainstem                                                   | PARTIAL         | `brainstem/`: probes, energy, safe state without a model. Hardware watchdog and motors PLANNED                                    |
| 3.2     | Salience and interrupts                                     | IMPLEMENTED     | `cognition/attention.ts`, `cognition/attention-queue.ts`, abort-signal preemption in the loop                                     |
| 3.3     | Thalamic router                                             | IMPLEMENTED     | `cognition/router/thalamic-router.ts`, in-process; a network transport is PLANNED                                                 |
| 3.4     | Cognitive cortex and model router                           | IMPLEMENTED     | OpenClaw providers, fallbacks and `operator/brain-multi.ts`                                                                       |
| 3.5     | Global workspace                                            | IMPLEMENTED     | `cognition/workspace/global-workspace.ts`; tool `lumina_workspace`                                                                |
| 4.1     | Working memory                                              | IMPLEMENTED     | `memory/working-memory.ts`                                                                                                        |
| 4.2     | Episodic memory                                             | PARTIAL         | `memory/episodic-memory.ts` on JSONL; move to SQLite state is task 2                                                              |
| 4.3     | Semantic memory                                             | PARTIAL         | Supabase, memory wiki, lessons                                                                                                    |
| 4.4     | Relational memory                                           | PARTIAL         | `social/people.ts` with roles and consent; no face or voice embeddings                                                            |
| 4.5     | Procedural memory                                           | IMPLEMENTED     | `skills/`                                                                                                                         |
| 4.6     | Consolidation                                               | IMPLEMENTED     | `cognition/consolidation.ts` on a timer: lessons per entity, routines proposed only                                               |
| 5       | World model                                                 | IMPLEMENTED     | `world/world-model.ts`: decay, history, relations, forgetting, durable                                                            |
| 6       | Spatial intelligence                                        | PARTIAL         | Symbolic places and relations; metric maps and SLAM need a body                                                                   |
| 7       | Vision                                                      | PARTIAL         | Screen vision and the perception sidecar; camera pipeline is task 8                                                               |
| 8       | Audition                                                    | PARTIAL         | Wake word and speech-to-text; diarization and speaker id are task 10                                                              |
| 9       | Voice                                                       | IMPLEMENTED     | Start Talk                                                                                                                        |
| 10      | Affective perception                                        | PARTIAL         | `social/affect.ts`: estimates capped at 0.75, never treated as fact                                                               |
| 11      | Personality                                                 | PARTIAL         | Identity in Supabase and the context engine; no versioned local profile                                                           |
| 12      | Self model                                                  | IMPLEMENTED     | `cognition/self/self-model.ts`; tool `lumina_self_model`                                                                          |
| 13      | Theory of mind                                              | IMPLEMENTED     | `social/theory-of-mind.ts`: inferred beliefs capped at 0.6; tool `lumina_mind`                                                    |
| 14      | Reasoning engine                                            | PARTIAL         | The loop proposes; a reasoner that plans from proposals is task 13                                                                |
| 15      | Planner                                                     | IMPLEMENTED     | `action/planner.ts` validates subgoals, preconditions, outcomes, rollback; `action/plan-run.ts` walks steps under the safety gate |
| 16      | Internal simulation                                         | PARTIAL         | `embodiment/predict.ts` and the simulated robot; no physics simulator                                                             |
| 17      | Reflection                                                  | PARTIAL         | `cognition/learning/lessons.ts`; reflection over the audit is task 14                                                             |
| 18      | Uncertainty engine                                          | IMPLEMENTED     | `cognition/uncertainty.ts`: verify, observe more, ask, abstain                                                                    |
| 19      | Tool system                                                 | IMPLEMENTED     | OpenClaw registry; one owner per tool name (contract test)                                                                        |
| 20      | Capability permissions                                      | IMPLEMENTED     | Governance policy for digital tools; body grants only from config                                                                 |
| 21      | Digital autonomy                                            | IMPLEMENTED     | PC and browser tools, transparency log, kill switch                                                                               |
| 22      | Agent orchestration                                         | PARTIAL         | `agents/director.ts`; uniform delegation result is task 7                                                                         |
| 23      | Embodied AI layer                                           | IMPLEMENTED     | `embodiment/`; tools `lumina_body`, `lumina_behavior`                                                                             |
| 24      | Robotics middleware (ROS 2)                                 | PLANNED         | Task 15                                                                                                                           |
| 25–31   | Locomotion, arms, hands, head, proprioception, touch, smell | MOCK            | Intents run on the simulated robot; real actuators and sensors are BLOCKED on hardware                                            |
| 32      | Energy management                                           | IMPLEMENTED     | `brainstem/energy.ts` thresholds and the `charge` behavior                                                                        |
| 33      | Autonomy levels                                             | IMPLEMENTED     | `cognition/autonomy-levels.ts`, applied to the body                                                                               |
| 34      | Behavior engine                                             | IMPLEMENTED     | `embodiment/behaviors.ts` over body intents (simulated)                                                                           |
| 35      | Skill system                                                | IMPLEMENTED     | `skills/`                                                                                                                         |
| 36      | Learning system                                             | PARTIAL         | Immediate learning through `lumina_world_observe`; no self-applied learning by design                                             |
| 37      | Learning from demonstration                                 | PARTIAL         | `lumina_recording_to_skill` for the PC; physical demonstration needs a body                                                       |
| 38      | Active learning                                             | PARTIAL         | The uncertainty engine's "ask" resolution                                                                                         |
| 39      | Habit learning                                              | PARTIAL         | `detectRoutines`: proposed, never automated by itself                                                                             |
| 40      | Social intelligence                                         | PARTIAL         | People, presence, theory of mind, affect; social evaluation PLANNED                                                               |
| 41      | Child interaction mode                                      | NOT IMPLEMENTED | Guardian role exists; the mode itself is not built                                                                                |
| 42      | Human autonomy                                              | IMPLEMENTED     | Objective order puts rights and autonomy above authority and tasks                                                                |
| 43      | Safety kernel                                               | IMPLEMENTED     | `safety/safety-kernel.ts`, `safety/invariants.ts`                                                                                 |
| 44      | Hardware safety                                             | BLOCKED         | Needs hardware interlocks                                                                                                         |
| 45      | Safe shutdown                                               | IMPLEMENTED     | `safeState()`: stop body, pause, engage emergency stop; only a person re-arms                                                     |
| 46      | Cybersecurity                                               | PARTIAL         | Operator-scoped gateway methods, untrusted sources, OpenClaw security audit                                                       |
| 47      | Network architecture                                        | PARTIAL         | Loopback gateway and Tailscale; no robot network yet                                                                              |
| 48      | Audit system                                                | IMPLEMENTED     | `safety/audit-log.ts`; external checkpoint is task 17                                                                             |
| 49      | Observability                                               | IMPLEMENTED     | Dashboard, transparency log, OpenTelemetry and Prometheus plugins                                                                 |
| 50      | Explainability                                              | IMPLEMENTED     | `lumina_explain` from the audit and loop cycles                                                                                   |
| 51      | Data architecture                                           | PARTIAL         | SQLite plugin state and Supabase; legacy JSONL stores remain (task 2)                                                             |
| 52      | Vector memory                                               | IMPLEMENTED     | Memory wiki embeddings, Supabase                                                                                                  |
| 53      | Knowledge graph                                             | PARTIAL         | World relations and the Supabase identity graph                                                                                   |
| 54      | Temporal reasoning                                          | PARTIAL         | `temporalFacts`, decay; no calendar reasoning in the core                                                                         |
| 55      | Task system                                                 | PARTIAL         | Goals, workboard plugin, Supabase tasks                                                                                           |
| 56      | Long-run tasks                                              | PARTIAL         | OpenClaw cron and background tasks                                                                                                |
| 57      | Goal system                                                 | IMPLEMENTED     | `lumina_goal`, persistent goals                                                                                                   |
| 58      | Event system                                                | IMPLEMENTED     | `events/catalog.ts` with validated, versioned payloads                                                                            |
| 59      | Simulation-first development                                | PARTIAL         | Simulated robot; physics simulator is task 16                                                                                     |
| 60      | Digital twin                                                | MOCK            | `DESKTOP_ROBOT_TWIN` in `embodiment/simulated-robot.ts`, validated by `validateTwin`                                              |
| 61      | Testing                                                     | IMPLEMENTED     | Vitest suites per module                                                                                                          |
| 62      | Failure injection                                           | PARTIAL         | Tests inject store, probe and stop failures; no chaos suite                                                                       |
| 63      | CI/CD                                                       | IMPLEMENTED     | GitHub Actions                                                                                                                    |
| 64      | Languages                                                   | IMPLEMENTED     | TypeScript and Python sidecars                                                                                                    |
| 65      | Frontend                                                    | IMPLEMENTED     | Native Control UI tab "M3GAN" (`ui/src/pages/plugin/m3gan-view.ts`)                                                               |
| 66      | Live mode                                                   | IMPLEMENTED     | "En vivo" view: workspace, events, cycles                                                                                         |
| 67      | People UI                                                   | IMPLEMENTED     | Roles, consent and forgetting from the M3GAN tab                                                                                  |
| 68      | Memory UI                                                   | PARTIAL         | Audit and recent cycles; no editor for Supabase memories here                                                                     |
| 69      | World UI                                                    | IMPLEMENTED     | Places as a tree, forget an entity                                                                                                |
| 70      | Robot UI                                                    | MOCK            | Simulated robot telemetry; physical confirmations wait in the safety view                                                         |
| 71      | Model router UI                                             | PARTIAL         | Active model shown; routing is OpenClaw's own UI                                                                                  |
| 72      | Developer mode                                              | IMPLEMENTED     | "Desarrollador" view: raw events, cycles, body log                                                                                |
| 73      | Repository architecture                                     | IMPLEMENTED     | See `PROJECT_M3GAN_REAL.md` section 7                                                                                             |
| 74      | API contracts                                               | IMPLEMENTED     | TypeBox tool schemas, event catalog, m3gan.* gateway methods JSON routes                                                          |
| 75      | IDs                                                         | IMPLEMENTED     | `shared/ids.ts`: `<prefix>_<ULID>`                                                                                                |
| 76      | Clock and time                                              | IMPLEMENTED     | ISO-8601 UTC timestamps, validated on observations                                                                                |
| 77      | Multi-device                                                | PARTIAL         | OpenClaw nodes and device pairing                                                                                                 |
| 78      | Edge and cloud                                              | PARTIAL         | Local Ollama models and cloud providers                                                                                           |
| 79      | Offline mode                                                | PARTIAL         | Local models and embeddings; the core runs without a network                                                                      |
| 80      | Update system                                               | PARTIAL         | OpenClaw updates and the Lumina publish script                                                                                    |
| 81      | Backups                                                     | NOT IMPLEMENTED | M3GAN state lives in the OpenClaw state database; no scheduled backup                                                             |
| 82      | Migration                                                   | PARTIAL         | Event schema version; OpenClaw state migrations                                                                                   |
| 83      | Robot hardware abstraction                                  | INTERFACE ONLY  | `embodiment/hal.ts`: `RobotHardwareInterface`                                                                                     |
| 84      | Sensor abstraction                                          | INTERFACE ONLY  | `Sensor` in `embodiment/hal.ts`                                                                                                   |
| 85      | Actuator abstraction                                        | INTERFACE ONLY  | `Actuator` in `embodiment/hal.ts`                                                                                                 |
| 86      | Hardware development roadmap                                | PLANNED         | `ROADMAP.md`                                                                                                                      |
| 87      | M3GAN virtual                                               | PARTIAL         | Start Talk and the Control UI; avatar driven by the workspace is task 11                                                          |
| 88      | Avatar                                                      | PARTIAL         | Chat mascot expressions in the UI                                                                                                 |
| 89      | Presence system                                             | IMPLEMENTED     | `social/presence.ts` from people and world events                                                                                 |
| 90      | Conversation manager                                        | PARTIAL         | OpenClaw sessions and Start Talk turn-taking                                                                                      |
| 91      | Attention system                                            | IMPLEMENTED     | Attention queue and workspace attention target                                                                                    |
| 92      | Curiosity engine                                            | NOT IMPLEMENTED |                                                                                                                                   |
| 93      | User model                                                  | PARTIAL         | People registry, theory of mind, Supabase identity                                                                                |
| 94      | Teaching mode                                               | PARTIAL         | `lumina_world_observe`, recording to skill                                                                                        |
| 95      | Language learning                                           | NOT IMPLEMENTED |                                                                                                                                   |
| 96      | Companion mode                                              | NOT IMPLEMENTED |                                                                                                                                   |
| 97      | Privacy states                                              | IMPLEMENTED     | `privacy/privacy-state.ts`; tool `lumina_privacy`; owner-only re-enable                                                           |
| 98      | Camera indicator                                            | PARTIAL         | Camera state in the M3GAN tab; a physical indicator needs hardware                                                                |
| 99      | Local data control                                          | PARTIAL         | Forget people, entities and the session's observations; task 3 widens it                                                          |
| 100     | Red teaming                                                 | PARTIAL         | Tests for self-grant, tampering and untrusted input; no standing red-team suite                                                   |
| 101     | Prompt-injection defense                                    | IMPLEMENTED     | Untrusted sources only propose; OpenClaw external-content handling                                                                |
| 102     | Model compromise assumption                                 | IMPLEMENTED     | The kernel does not trust the model: tools narrow only, tampering → safe state                                                    |
| 103     | Perception failure assumption                               | IMPLEMENTED     | Decay, physical thresholds, verify before acting                                                                                  |
| 104     | Network failure assumption                                  | PARTIAL         | Network probe; local models; no robot fallback behavior yet                                                                       |
| 105     | Database failure assumption                                 | IMPLEMENTED     | Fail-safe defaults while loading, no writes after a failed hydration, audit verification                                          |
| 106     | Model independence                                          | IMPLEMENTED     | State outside the model; providers replaceable                                                                                    |
| 107     | Documentation                                               | IMPLEMENTED     | This folder                                                                                                                       |
| 108     | Architecture decision records                               | IMPLEMENTED     | `adr/`                                                                                                                            |
| 109     | Development rule                                            | IMPLEMENTED     | Tests, lint, typecheck before commit; status file updated                                                                         |
| 110     | Code quality                                                | IMPLEMENTED     | oxlint, oxfmt, tsgo                                                                                                               |
| 111     | Error handling                                              | PARTIAL         | Typed tool errors; the brainstem reports degraded subsystems                                                                      |
| 112     | Health system                                               | IMPLEMENTED     | `/health`, `/ready`, `/version`, brainstem, `lumina_health`                                                                       |
| 113     | Performance                                                 | PLANNED         | Task 20                                                                                                                           |
| 114     | Cost management                                             | PARTIAL         | `lumina_pc_do_cost_summary`, OpenClaw usage                                                                                       |
| 115–117 | Hardware targets, microcontrollers, real-time               | BLOCKED         | Needs hardware; real-time control stays below the HAL by design                                                                   |
| 118     | Human detection                                             | INTERFACE ONLY  | The supervisor takes nearby people; no detector feeds it                                                                          |
| 119     | Collision avoidance                                         | PARTIAL         | Slow near people, stop within reach; no sensors feed distances                                                                    |
| 120     | Handover protocol                                           | MOCK            | `HANDOVER_PROTOCOL` in `embodiment/behaviors.ts`, always confirmed, simulated                                                     |
| 121     | Object database                                             | PARTIAL         | Objects in the world model                                                                                                        |
| 122     | Affordance model                                            | NOT IMPLEMENTED |                                                                                                                                   |
| 123     | Causal model                                                | PARTIAL         | `predict()` gives expected effects of intents                                                                                     |
| 124     | Self-diagnostics                                            | IMPLEMENTED     | Brainstem probes                                                                                                                  |
| 125     | Maintenance mode                                            | PLANNED         | Technician role exists; the mode is not built                                                                                     |
| 126     | Calibration                                                 | BLOCKED         | Needs hardware                                                                                                                    |
| 127     | Recovery                                                    | IMPLEMENTED     | State hydrates after restart; recovery never resumes by itself                                                                    |
| 128     | Persona continuity                                          | PARTIAL         | Identity and memory outside the model; no versioned persona file                                                                  |
| 129     | Model hot swap                                              | IMPLEMENTED     | OpenClaw reloads model config without a restart                                                                                   |
| 130     | Multi-model collaboration                                   | PARTIAL         | `operator/brain-multi.ts`, agent split                                                                                            |
| 131     | Vision-language-action                                      | INTERFACE ONLY  | `EmbodiedModelAdapter` in `embodiment/hal.ts`                                                                                     |
| 132     | Embodied foundation models                                  | INTERFACE ONLY  | `EmbodiedModelAdapter`                                                                                                            |
| 133     | Reinforcement learning                                      | PLANNED         | Simulation only, by rule                                                                                                          |
| 134     | Teleoperation                                               | PLANNED         | Task 4                                                                                                                            |
| 135     | Dataset system                                              | PARTIAL         | Recorder sessions; no labeled dataset store                                                                                       |
| 136     | Model registry                                              | PARTIAL         | OpenClaw model catalog                                                                                                            |
| 137     | Evaluation suite                                            | PARTIAL         | Skill evaluation, memory evaluation; task 19                                                                                      |
| 138     | Memory evaluation                                           | PARTIAL         | Memory wiki evaluation set                                                                                                        |
| 139–141 | World, social and robot evaluation                          | PLANNED         | Task 19                                                                                                                           |
| 142     | Long-term operation                                         | PARTIAL         | Timers for brainstem and consolidation; retention of durable state                                                                |
| 143     | Human override                                              | IMPLEMENTED     | `safety/overrides.ts` and the M3GAN tab                                                                                           |
| 144     | Conflicting users                                           | PARTIAL         | `resolveConflict` by role and objective; needs speaker identity to know who asks                                                  |
| 145     | Primary user concept                                        | IMPLEMENTED     | Owner role; `primary_user = self` refused                                                                                         |
| 146     | Self-modification                                           | IMPLEMENTED     | No tool writes the plugin config or the invariants; code changes go through git                                                   |
| 147     | Autonomous development                                      | PARTIAL         | Claude Code and Codex with shared status and tasks                                                                                |
| 148     | Git                                                         | IMPLEMENTED     | Every change committed and published                                                                                              |
| 149     | Security of generated code                                  | PARTIAL         | CodeAct sandbox, risk engine, review                                                                                              |
| 150     | Initial implementation priority                             | IMPLEMENTED     | Followed: brain first, body last                                                                                                  |
| 151     | First milestone, M3GAN CORE v0.1                            | PARTIAL         | See `ROADMAP.md`                                                                                                                  |
| 152–156 | Later milestones                                            | PLANNED         | See `ROADMAP.md`                                                                                                                  |
| 157–159 | Success, principle, final objective                         | n/a             | Guide the roadmap                                                                                                                 |
| 160–165 | Instructions, division of work, continuity                  | IMPLEMENTED     | This folder, `TASKS.md`, `M3GAN_STATUS.md`                                                                                        |
