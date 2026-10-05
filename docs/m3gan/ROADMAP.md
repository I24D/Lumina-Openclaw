# M3GAN REAL roadmap

Milestones from §150 to §157 of the master specification, brain first and body last. Each item
carries its status as of 2026-10-05 (§164 vocabulary). The success test (§157) is that one identity
moves from PC to avatar to desktop robot to mobile base to humanoid without losing memory,
identity, relationships, skills, tasks, personality or continuity.

## M3GAN CORE v0.1 (§151)

| Capability                      | Status      | Evidence or gap                                                                                |
| ------------------------------- | ----------- | ---------------------------------------------------------------------------------------------- |
| Keep an identity                | IMPLEMENTED | Context engine, Supabase identity, self model                                                  |
| Converse                        | IMPLEMENTED | OpenClaw sessions and channels, Start Talk                                                     |
| Use several models              | IMPLEMENTED | OpenClaw providers with fallbacks                                                              |
| Keep memory                     | IMPLEMENTED | Supabase, memory wiki, working and episodic memory, SQLite plugin state                        |
| Remember people                 | PARTIAL     | People registry with roles and consent; no face or voice recognition yet                       |
| Manage tasks                    | PARTIAL     | Goals, workboard, Supabase tasks; no uniform delegation result yet                             |
| Use tools                       | IMPLEMENTED | About 120 Lumina tools plus OpenClaw's own                                                     |
| Observe the screen              | IMPLEMENTED | UI Automation, OmniParser, the perception sidecar feeding the router                           |
| Observe through a camera        | PARTIAL     | Event contracts ready (`person.detected`, `world.observed`); no camera pipeline                |
| Listen                          | IMPLEMENTED | Wake word, speech-to-text, Start Talk                                                          |
| Speak                           | IMPLEMENTED | Start Talk voice                                                                               |
| Keep a world state              | IMPLEMENTED | World model with decay, history and relations, durable                                         |
| Run a planner                   | IMPLEMENTED | Hierarchical plan validation and a step-by-step walk with ordered rollback (`lumina_plan_run`) |
| Show a dashboard                | IMPLEMENTED | M3GAN tab in the Control UI                                                                    |
| Produce logs                    | IMPLEMENTED | Audit log, transparency log, gateway logs                                                      |
| Recover context after a restart | IMPLEMENTED | Safety, world, people, privacy and beliefs hydrate from SQLite state                           |

Remaining to close v0.1: the camera pipeline into the core and face or voice recognition with consent.

## M3GAN PRESENCE v0.2 (§152)

PLANNED: optimized continuous vision, authorized recognition (consent already modeled), speaker
identification, tracking, social memory on top of the people registry, the avatar driven by the
workspace, multimodal conversation. Wake word and attention already exist.

## M3GAN AUTONOMY v0.3 (§153)

PARTIAL: persistent goals and the planner's hierarchical fields exist. PLANNED: persistent tasks
with a uniform delegation result, workflows, long-running tasks under the brainstem, reflection
over the audit, learning that proposes and never self-applies, multi-agent delegation.

## M3GAN EMBODIED SIM v0.4 (§154)

PARTIAL: body intents, the safety supervisor, behaviors, `predict()`, the HAL and a simulated
desktop robot with its digital twin. PLANNED: a ROS 2 bridge, MuJoCo, Gazebo or Isaac Sim as body
adapters, a simulated camera and arms, navigation and manipulation in simulation.

## M3GAN PHYSICAL v0.5 (§155)

PLANNED. First hardware, without legs: perceive, remember, plan, navigate, interact, manipulate
simple objects and communicate. Needs hardware interlocks, an independent watchdog and a physical
confirmation button first.

## M3GAN HUMANOID v1.0 (§156)

PLANNED. Whole-body control, arms, hands, head, face, locomotion, interaction, charging and
long-duration autonomy on a suitable humanoid platform.

## Rules that hold at every milestone

- Physical behavior is learned only through simulation, evaluation and validation (§25, §133).
- The model never sends motor commands; real-time control lives below the HAL (§21, §117).
- Every new service ships health checks, logs, configuration, tests and documentation (§160).
- Nothing is marked IMPLEMENTED until it runs; mocks say MOCK (§164).
