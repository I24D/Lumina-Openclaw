# ADR 0009: Interaction modes are a restriction layer

- Status: accepted
- Date: 2026-10-06

## Context

The specification asks for a child interaction mode (§41), a companion mode (§96) and a maintenance
mode (§125). The first draft built each mode out of a person's overrides: entering child mode
disabled grasping in the override store, and leaving it re-enabled what the mode had disabled. Codex
reviewed that draft and held it back: a person who switched grasping off during the child's visit
would have it switched back on when the mode ended, because the override store cannot tell a
person's order from the mode's.

## Decision

- A mode is its own layer (`safety/interaction-mode.ts`). While it lasts it adds restrictions on top
  of a person's overrides: child mode switches off `robot.grasp` and `robot.handover`; maintenance
  mode pauses autonomy and switches off navigation, grasping and handover. Nothing is written into
  the override store, so leaving a mode lifts only what the mode imposed.
- The body's safety context and the loop's autonomy level read both layers. Maintenance explains its
  own pause, so a refusal never claims a person paused Lumina.
- Entering child or maintenance mode only narrows, so the agent may do it (`lumina_mode`). Leaving
  them and entering companion mode widen what Lumina does, so only the owner channel can
  (`m3gan.mode`, the Control UI's M3GAN tab, `operator.write`).
- The mode is durable (`m3gan.mode`). Until it has loaded, the strictest restrictions apply.
- Leaving child mode records an activity summary for the guardian, built from the audit.

## Consequences

- A person's orders and a mode never undo each other.
- The agent learns the mode through an initiative on every change and through the self model's
  limitations; the guidance for each mode is text, while what it forbids is enforced in code.
- The mode's guidance rides on every turn's system prompt, and in child mode a word screen
  (`safety/child-guard.ts`) sends an unsuitable reply back to the model once and replaces it on the
  way out to a channel. It is a word list, not a classifier: the guardian stays in the loop.
