# ADR 0011: The mesh delivers at least once, beside the gateway

- Status: accepted
- Date: 2026-10-31

## Context

The three Lumina agents — the ChatGPT/Lumina core, OpenClaw on the PC, Muse in
the cloud — had no reliable way to hand work to each other. The gateway
publishes lifecycle events to `lumina_events` through
`src/lumina/cognitive-bus.ts`, but that emitter is fire-and-forget by design: a
bounded 3 s insert, never awaited, every failure swallowed, so an unreachable
Supabase leaves the gateway exactly as it was. It cannot promise delivery, and
it must not start trying.

The inventory of 2026-10-31 found that the Supabase side was already built:
thirty `lumina_*` functions, a monotonic `fence_token` with a trigger,
`lumina_finish_task_fenced` rejecting stale holders, atomic claims with `FOR
UPDATE SKIP LOCKED`, and operation-level idempotency. What did not exist was any
TypeScript that called them — zero references across `src/`, `extensions/`,
`ui/` and `scripts/`. The gap was the adapter, not the database.

Two further facts constrained the design. `lumina_events` is not in the
`supabase_realtime` publication, so there is no push for bus events. And its
primary key is a random uuid with no useful uniqueness, so the database cannot
refuse a duplicate row.

## Decision

- The reliable layer lives in `extensions/lumina-cognitive-os/src/mesh/`, is
  independent of the gateway, and is not imported by any gateway code path. The
  existing emitter stays fire-and-forget and unchanged.
- Delivery is **at least once with a logically idempotent effect**. Exactly-once
  end to end is not offered and is never claimed.
- The outbox keys a record by the envelope's `idempotency_key`, so a sender's
  retry collapses onto the record already there, and stores the envelope with
  every recipient's delivery state in one value, so the two are written
  atomically by construction.
- Duplicate suppression is the receiver's job. `inbox.ts` keeps a
  processed-effect ledger and applies one effect per key. An interrupted
  `external` effect is parked for a person rather than retried.
- Polling is the floor. Reconciliation runs on every dispatcher pass; a
  notification can only make delivery sooner, never possible.
- Reuse beats reimplementation. Task recovery is an adapter over the existing
  fenced RPCs, and it calls `lumina_finish_task_fenced` exclusively, never the
  four sibling functions that close a task without a fence token.
- v1 requires no DDL. The envelope nests under the reserved `context.mesh` key
  of the existing `context jsonb` column. Every schema change is proposed as a
  file in `sql/` and waits for Dal.

## Consequences

- A recipient can observe a delivery twice. That is the contract, and the inbox
  is what makes it safe; code that assumes a single observation is wrong.
- A dispatcher whose claim was superseded is refused at the point of effect even
  when its transport call succeeded. The refusal is recorded as evidence, not
  swallowed, because it is the visible seam of at-least-once.
- An interrupted external effect halts until a person resolves it. Throughput is
  traded for not doubling a real-world action.
- Nothing runs in production until someone deliberately registers the mesh.
  Wiring it into the gateway must route database access through a worker, per
  `docs/reference/database-schemas/worker-access.md`.
- The four unfenced task RPCs remain exploitable by a stale same-agent worker
  until `sql/lumina_mesh_fence_hardening.sql` is applied. The adapter's refusal
  to call them mitigates it for new TypeScript callers only; the Python library
  still uses them.
