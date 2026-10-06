# ADR 0001: Build the cognitive core inside lumina-cognitive-os

- Status: accepted
- Date: 2026-10-04

## Context

The master specification asks to reuse LUMINA wherever reasonable (§1) and forbids turning the
project into disconnected scripts (§160). LUMINA OpenClaw already has an extension,
`lumina-cognitive-os`, with awareness, memory tiers, vision, PC control, skills, risk, governance,
transparency and a kill switch.

## Decision

The cognitive core is a set of layers inside `lumina-cognitive-os` (`cognition`, `world`, `social`,
`safety`, `privacy`, `brainstem`, `embodiment`, `dashboard`, `events`), assembled by one
composition root (`cognition/cognitive-runtime.ts`) and connected to the host in one place
(`cognition/plugin-wiring.ts`). Existing modules are extended, not copied: the planner gained
hierarchical fields, the awareness poller and the screen perception sidecar feed the router, and the
kill switch is the emergency stop.

## Consequences

- One extension to activate, configure and test; one manifest declares every tool.
- The extension is large. Layer folders and the composition root keep it navigable; splitting a
  layer into its own extension stays possible because layers talk through typed contracts.
- Codex and Claude Code edit the same tree, so `TASKS.md` and `LUMINA_STATUS.md` record who works
  on what.
