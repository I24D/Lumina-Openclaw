# ADR 0010: LUMINA is the identity; M3GAN is only the reference

- Status: accepted
- Date: 2026-10-06

## Context

The master specification is titled "Proyecto M3GAN REAL", and the first builds of the cognitive
core took the name from it: a Control UI tab called M3GAN, `m3gan.*` gateway methods, `docs/m3gan/`,
`M3GAN_STATUS.md`, an `[M3GAN]` prefix on the core's messages to the agent. On 2026-10-05 Dal
corrected this: the film is only the conceptual reference, the example of what to get right, and
the AI being built is LUMINA, one entity and not another agent. Everything built runs inside LUMINA.

## Decision

- Every name a person or an agent sees says Lumina: the Control UI tab is "Lumina" (`core` inside
  the plugin), the gateway methods are `lumina.core.*`, the health routes live under
  `/plugins/lumina-cognitive-os/core`, the core speaks to the agent as `[Lumina core]`, the docs
  live in `docs/lumina-core/` and the checkpoint is `LUMINA_STATUS.md`.
- Code names follow: `LUMINA_CORE_VERSION`, `coreEvent`, `coreState`, `core-eval.ts`,
  `lumina-core-*.ts` in the Control UI.
- The durable stores keep their `m3gan.` namespaces. Renaming them would orphan the stored state,
  the audit chain included, for a name nobody sees.
- The film stays where it is the subject: the lessons of why the fictional M3GAN failed (§1 to §36).

## Consequences

- Scripts or bookmarks that called `m3gan.*` methods or the old health route must use the new ones.
- Commits made before this decision keep their messages; history is not rewritten.
