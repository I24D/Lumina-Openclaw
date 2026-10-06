# ADR 0005: The model emits intents, never motor commands

- Status: accepted
- Date: 2026-10-04

## Context

The specification's first rule for a real embodied agent is that the AI does not control the body directly
(§21). Real-time control, collision avoidance and hardware interlocks must not depend on a model's
latency or judgment (§117, §119).

## Decision

- Cognition can only emit `BodyIntent`s (`look_at`, `gesture`, `navigate_to`, `grasp`, `handover`,
  `stop`...). The embodied controller sends each intent through the safety supervisor, which
  allows, modifies (slower limits), asks for confirmation, denies or stops.
- Trajectories, joint targets and motor commands live behind `BodyAdapter` and the hardware
  abstraction layer (`embodiment/hal.ts`), out of the model's reach.
- Development is simulation first: a simulated desktop robot with its digital twin is the only body
  today. Physical behavior is learned only through simulation, evaluation and validation.

## Consequences

- A ROS 2 bridge or a physics simulator plugs in as another `BodyAdapter` with the same contract.
- Grasping and handing objects to people always ask, at every autonomy level.
- Nothing physical runs until hardware and interlocks exist; the code says MOCK or INTERFACE ONLY.
