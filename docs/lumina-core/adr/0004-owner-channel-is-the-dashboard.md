# ADR 0004: The owner's channel is the Control UI's Lumina tab

- Status: accepted, amended by ADR 0008 (the tab renders natively)
- Date: 2026-10-05

## Context

A person must be able to override the system at any time (§143), and the system must never be able
to hand itself back authority over its own stop mechanisms (§45). If the agent's tools could
resume, re-enable or confirm, a manipulated model could undo a person's decision.

## Decision

- Widening actions exist only in the Control UI's Lumina tab, over gateway methods that need an
  authenticated operator session (ADR 0008): resume, re-enable autonomy or a capability, switch a sensor
  back on, assign roles, grant recognition consent, forget a person, confirm a physical action,
  teleoperate and re-arm the emergency stop.
- The kill-switch tool can engage the emergency stop and report status. It has no re-arm.
- Every action taken there is written to the audit log as `owner:dashboard`.

## Consequences

- Saying "resume" to the agent does not resume; the agent points the person to the Lumina tab.
- Residual risk: an agent driving a browser that already holds an operator session could reach
  these methods. Confirmations no software can forge need a physical button or a separate device,
  which is a task.
