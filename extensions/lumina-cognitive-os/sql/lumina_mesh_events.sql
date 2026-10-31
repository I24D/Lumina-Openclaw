-- lumina_mesh_events.sql — the two optional upgrades the mesh would like on
-- `lumina_events`, kept separate because neither is required for v1.
--
-- STATUS: PROPOSED. NOT APPLIED. Both statements change the shared Lumina_IA
-- project (zcleztlzatnnoishtpfk): a red action under the order of 2026-10-31,
-- needing Dal's explicit approval and the repository's database review
-- checkpoint. Apply through the Supabase MCP connector's apply_migration.
--
-- The mesh works today without either of these. v1 deliberately requires NO
-- DDL: the LUMINA-MESH/1 envelope is nested under the reserved `context.mesh`
-- key, which fits the existing `context jsonb NOT NULL DEFAULT '{}'` column and
-- collides with none of the 31 keys that column holds in production. These two
-- statements remove a known cost, not a blocker.
--
-- ============================================================================
-- 1. Database-level deduplication of mesh deliveries
-- ============================================================================
--
-- Today `lumina_events` has no useful uniqueness: its primary key is a random
-- uuid, so the table cannot refuse a duplicate. Measured on 2026-10-31: 84 rows
-- carry a jobId but there are only 30 distinct (origin, event_type, jobId)
-- combinations, and 10 jobIds appear in more than one row.
--
-- The mesh does not depend on this. Duplicate suppression lives in
-- src/mesh/inbox.ts, which keeps a processed-effect ledger and applies one
-- effect per idempotency_key. That is the correct place for it, because the
-- effect is what must happen once; a duplicate *row* is merely noise.
--
-- What the index buys is a cheaper, earlier stop: the writer learns at INSERT
-- time that the delivery is already recorded, instead of writing a second row
-- the reader then has to collapse.
--
-- `concurrently` keeps the table writable while the index builds, which matters
-- because the live gateway's fire-and-forget emitter writes to this table and
-- must never block. A CONCURRENTLY statement cannot run inside a transaction
-- block, so this is deliberately not wrapped in begin/commit.
--
-- If the build fails it leaves an INVALID index behind: drop it and retry.
--   select indexrelid::regclass, indisvalid from pg_index
--    where indexrelid = 'lumina_events_mesh_delivery_key'::regclass;

create unique index concurrently if not exists lumina_events_mesh_delivery_key
  on public.lumina_events ((context -> 'mesh' ->> 'idempotency_key'),
                           (context -> 'mesh' ->> 'recipient'))
  where context -> 'mesh' ->> 'idempotency_key' is not null;

comment on index public.lumina_events_mesh_delivery_key is
  'One row per (mesh effect, recipient). Partial, so rows the fire-and-forget emitter writes without context.mesh are unaffected.';

-- ============================================================================
-- 2. Realtime on lumina_events
-- ============================================================================
--
-- Measured on 2026-10-31: the `supabase_realtime` publication carries exactly
-- two tables, `lumina_tasks` and `lumina_task_events`. `lumina_events` is NOT
-- in it, and `puballtables` is false. So no agent can be pushed a bus event
-- today; every consumer polls.
--
-- The mesh is built for that and stays correct without this change: the
-- dispatcher reconciles on every pass, and `dispatcher.test.ts` proves delivery
-- with no notification at all. A notification can only make delivery *sooner*,
-- never possible. Adding the table to the publication would turn the accelerator
-- on; nothing in the mesh would change shape.
--
-- Cost to weigh before approving: every INSERT on `lumina_events` then fans out
-- to Realtime subscribers. The gateway's emitter writes here on every delivered
-- message, so this raises steady-state replication traffic on the busiest
-- Lumina table. Worth it only once something is actually listening.

alter publication supabase_realtime add table public.lumina_events;

-- ROLLBACK
--   drop index concurrently if exists public.lumina_events_mesh_delivery_key;
--   alter publication supabase_realtime drop table public.lumina_events;
