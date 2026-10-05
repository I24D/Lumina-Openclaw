# ADR 0002: Safety is code, not prompts or weights

- Status: accepted
- Date: 2026-10-04

## Context

The fictional M3GAN failed because her safety lived in the same place as her goals and could be
reinterpreted (§22, §30). A language model can be persuaded, confused or replaced. The
specification asks for hard constraints, a correct hierarchy of authority (§23) and a kernel that
not even the owner can switch off for the invariants (§43).

## Decision

- `safety/invariants.ts` lists the invariants as data, each with the module that enforces it and
  the sections it comes from. No configuration key turns one off.
- Every check only narrows: the supervisor, autonomy levels, overrides and privacy states can turn
  "allow" into "confirm", "deny" or "stop", never the reverse.
- The model reaches the kernel only through tools, and tools can only narrow (pause, stop, disable,
  switch a sensor off, engage the emergency stop).
- Registering the agent as a person or as `primary_user`, or any attempt to widen its own
  authority, is refused, audited and puts the system in a safe state.
- The danger protocol reduces harm and has a fixed list of forbidden responses.

## Consequences

- Prompt changes cannot weaken safety; the context engine only explains the rules.
- Some legitimate actions need a person at the M3GAN tab. That cost is accepted.
- New capabilities must state which invariant covers them before they are wired.
