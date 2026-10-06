# ADR 0003: Durable state lives in OpenClaw's SQLite plugin state

- Status: accepted
- Date: 2026-10-05

## Context

The core must recover its context after a restart (§151) and treat database failure as expected
(§105). The repository requires new durable runtime state to use SQLite rather than ad hoc JSON
files. The safety audit must be kept apart from memory the agent can edit (§24, §48).

## Decision

- Every durable core record goes through `KeyedLog` (`shared/state-store.ts`) over
  `api.runtime.state.openKeyedStore`, one namespace per concern: `m3gan.audit`,
  `m3gan.overrides`, `m3gan.world`, `m3gan.privacy`, `m3gan.people`, `m3gan.beliefs`.
- A log hydrates before its first write, serializes appends, and never writes if hydration failed.
- While loading, the safe default applies: overrides read as paused, sensors read as off.
- Only the gateway's live registration (`registrationMode === "full"`) opens the stores. Discovery
  and CLI loads use session-only stores, so two processes never append to the same audit chain.

## Consequences

- State survives restarts and model swaps, and is independent of any provider.
- Goals, lessons and episodic memory still use older JSONL files; moving them is a task.
- Standalone CLI agent runs see session-only core state. That is deliberate.
- Tail deletion of the audit across a restart needs an external checkpoint, which is a task.
