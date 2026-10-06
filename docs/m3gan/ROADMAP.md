# M3GAN REAL roadmap

Milestones from §150 to §157 of the master specification, brain first and body last. Each item
carries its status as of 2026-10-06 (§164 vocabulary). The success test (§157) is that one identity
moves from PC to avatar to desktop robot to mobile base to humanoid without losing memory,
identity, relationships, skills, tasks, personality or continuity.

## M3GAN CORE v0.1 (§151)

| Capability                      | Status      | Evidence or gap                                                                                |
| ------------------------------- | ----------- | ---------------------------------------------------------------------------------------------- |
| Keep an identity                | IMPLEMENTED | Context engine, Supabase identity, self model                                                  |
| Converse                        | IMPLEMENTED | OpenClaw sessions and channels, Start Talk                                                     |
| Use several models              | IMPLEMENTED | OpenClaw providers with fallbacks                                                              |
| Keep memory                     | IMPLEMENTED | Supabase, memory wiki, working and episodic memory, SQLite plugin state                        |
| Remember people                 | IMPLEMENTED | People registry with roles and consent; face and voice recognition only with consent           |
| Manage tasks                    | IMPLEMENTED | Goals, workboard, Supabase tasks, a uniform delegation result and plan walks                   |
| Use tools                       | IMPLEMENTED | About 120 Lumina tools plus OpenClaw's own                                                     |
| Observe the screen              | IMPLEMENTED | UI Automation, OmniParser, the perception sidecar feeding the router                           |
| Observe through a camera        | IMPLEMENTED | Webcam sidecar: faces with consented recognition, and objects (YOLOX) into the world model     |
| Listen                          | IMPLEMENTED | Wake word, speech-to-text, Start Talk                                                          |
| Speak                           | IMPLEMENTED | Start Talk voice                                                                               |
| Keep a world state              | IMPLEMENTED | World model with decay, history and relations, durable                                         |
| Run a planner                   | IMPLEMENTED | Hierarchical plan validation and a step-by-step walk with ordered rollback (`lumina_plan_run`) |
| Show a dashboard                | IMPLEMENTED | M3GAN tab in the Control UI                                                                    |
| Produce logs                    | IMPLEMENTED | Audit log, transparency log, gateway logs                                                      |
| Recover context after a restart | IMPLEMENTED | Safety, world, people, privacy and beliefs hydrate from SQLite state                           |

Every v0.1 capability is in place; what is simulated says MOCK in the section map.

## M3GAN PRESENCE v0.2 (§152)

PARTIAL: authorized face and voice recognition with consent, speaker identification, presence,
the mascot driven by the workspace, interaction modes (child, companion, maintenance), curiosity
about unknown things and teaching with spaced practice are implemented. PLANNED: object tracking,
optimized continuous vision and multimodal conversation beyond Start Talk.

## M3GAN AUTONOMY v0.3 (§153)

PARTIAL: persistent goals, plan walks with rollback, a uniform delegation result, a situational
reasoner that takes initiative within the autonomy level, and reflection that proposes lessons a
person accepts are implemented. PLANNED: long-running workflows under the brainstem.

## M3GAN EMBODIED SIM v0.4 (§154)

PARTIAL: body intents, the safety supervisor with an affordance model, behaviors, `predict()`,
the HAL, the symbolic robot, a MuJoCo body (speed limits, collisions, reach) and a ROS 2 adapter
for Gazebo or Isaac through rosbridge are implemented, with evaluation scenarios. PLANNED: a
simulated camera and arm in MuJoCo, and reinforcement learning in simulation only (task 25).

## M3GAN PHYSICAL v0.5 (§155)

PLANNED. First hardware, without legs: perceive, remember, plan, navigate, interact, manipulate
simple objects and communicate. Needs hardware interlocks and an independent watchdog first; the
physical confirmation exists on the real keyboard and moves to a button on the robot.

## M3GAN HUMANOID v1.0 (§156)

PLANNED. Whole-body control, arms, hands, head, face, locomotion, interaction, charging and
long-duration autonomy on a suitable humanoid platform.

## Rules that hold at every milestone

- Physical behavior is learned only through simulation, evaluation and validation (§25, §133).
- The model never sends motor commands; real-time control lives below the HAL (§21, §117).
- Every new service ships health checks, logs, configuration, tests and documentation (§160).
- Nothing is marked IMPLEMENTED until it runs; mocks say MOCK (§164).
