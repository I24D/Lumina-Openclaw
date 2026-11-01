# LUMINA Cognitive Mesh v1

Durable messaging, task recovery and an authority boundary for the three Lumina
agents: the ChatGPT/Lumina core, OpenClaw on the PC, and Muse in the cloud.

Built 2026-10-31 under Dal's authorization, from
`LUMINA_OPENCLAW_MESH_ORDEN_CLAUDE_2026-10-31.md`. Code in `src/mesh/`, proposed
DDL in `sql/`.

## What was already there

The inventory that opened this work found far more deployed than the order
assumed. None of it was duplicated.

| Piece                     | Where                                                      | State                                  |
| ------------------------- | ---------------------------------------------------------- | -------------------------------------- |
| `lumina_events` bus table | Supabase `Lumina_IA` (`zcleztlzatnnoishtpfk`)              | 13 columns, 165 rows, live             |
| 30 `lumina_*` RPCs        | same project                                               | deployed and verified 2026-10-26       |
| Monotonic fencing         | `lumina_tasks.fence_token` + `trg_lumina_tasks_fence`      | works                                  |
| Fenced task close         | `lumina_finish_task_fenced`                                | works, rejects stale holders           |
| Operation idempotency     | `lumina_claim_operation` / `lumina_complete_operation`     | works                                  |
| Atomic claim              | `lumina_claim_task` (`FOR UPDATE SKIP LOCKED`)             | works                                  |
| Transient-failure rescue  | `lumina_recover_transient_failures`                        | infrastructure errors only, by pattern |
| Independent review        | `lumina_submit_review`                                     | refuses self-approval                  |
| Bus library               | `~/.openclaw/workspace/lumina-cognitive-bus/lumina_bus.py` | Python, stdlib only, outside this repo |
| Gateway event emitter     | `src/lumina/cognitive-bus.ts`                              | fire-and-forget, live, 3 call sites    |

**The real gap was not the database. It was that no TypeScript consumed any of
it.** A grep for all eleven bus RPCs across `src/`, `extensions/`, `ui/` and
`scripts/` returned zero matches. The only Supabase access from the core was the
event emitter's single `POST /rest/v1/lumina_events`.

So this work is an adapter layer over primitives that already existed, plus the
three things that genuinely did not exist: a typed envelope, a durable outbox
with per-recipient acks, and an authority boundary.

## Four facts that changed the design

1. **`priority` is 1-6, not 1-4.** The order said 1-4. The column's own
   constraint is `priority >= 1 AND priority <= 6`, the bus README documents six
   levels (5 emergency, 6 a decision for Dal), and production already holds six
   `priority: 5` rows written by the Python library (`contradiction.detected`,
   `safety.red_zone`). Validating 1-4 would have rejected live safety traffic.
   The column wins; `MeshPriority` is 1-6.
2. **`lumina_events` is not in the Realtime publication.** Only `lumina_tasks`
   and `lumina_task_events` are. There is no push for bus events today, so
   polling is the floor, not an optimization. `dispatcher.test.ts` proves
   delivery with no notification at all.
3. **The envelope fits `context` with no DDL.** `context jsonb NOT NULL DEFAULT
   '{}'` holds 31 distinct keys in production and none of them collide with the
   envelope's field names. v1 nests the whole envelope under one reserved key,
   `context.mesh`, so no old reader breaks and no migration is needed.
4. **`a2a_task_audit` does not exist.** The order asks to audit it. There is no
   such table, view or function in the project (68 tables checked) and no
   reference in this repository. The real audit trail is `lumina_task_events`
   (248 rows, fed by the `lumina_tasks_event_log` trigger). `extensions/a2a` is
   upstream's Agent2Agent channel plugin, unrelated.

## The modules

```text
src/mesh/
  envelope.ts          the LUMINA-MESH/1 contract: types, validation, hashing, idempotency keys
  outbox.ts            durable per-effect records with per-recipient delivery state
  inbox.ts             one effect per idempotency_key, and the parking lot for interrupted ones
  dispatcher.ts        one pass: reconcile, claim, send, settle
  authority.ts         zones, origin authentication, grants, replay defense
  iccv.ts              the scorecard, with its denominators in plain sight
  supabase-transport.ts  projects the envelope into lumina_events and reads it back
  task-recovery.ts     a TypeScript adapter over the existing fenced task RPCs
  shared-memory.ts     dedup, supersession and the review stage over shared_memory
  event-digest.ts      a human summary built from event metadata, never from chat
  chatgpt-adapter.ts   the routes to the core that exist, and what they cannot do

sql/
  lumina_mesh_fence_hardening.sql  the proposed fix for both fencing defects
  lumina_mesh_events.sql           two optional upgrades, neither required
  m2-fencing.mjs                   TEST M2 on a real PostgreSQL
  m2-schema.sql                    the live function definitions, replayed verbatim
```

Built on OpenClaw **2026.10.9**, merged from upstream `main` on 2026-10-31
(`df63d26bd46`). That merge brought 3987 commits over 20658 files with six
conflicts; the Cognitive Bus emitter's call site in
`src/gateway/server-cron-notifications.ts` was one of them, and both sides were
kept.

### Delivery semantics

**At least once, with a logically idempotent effect.** Never exactly-once, and
no module claims it.

- The outbox keys a record by `idempotency_key`, not `message_id`, so a sender
  retrying the same intent after a crash collapses onto the record already
  there. Sender-side duplication is structural, not advisory.
- A record holds the envelope _and_ every recipient's delivery state in one
  stored value, so a record and its outbound state are written atomically by
  construction. There is no window where an event exists without its delivery
  row.
- A recipient can still observe a delivery twice: the write succeeded and the
  ack was lost. `inbox.ts` is what makes the second observation harmless.
- `processed` and `verified` are separate states. A recipient saying "I applied
  this" is delivery; an independent party saying "the effect is really there" is
  verifiability. `markVerified` refuses a verifier equal to the recipient.

### The crash window, named rather than coded around

Applying an effect and recording that it was applied cannot be one atomic step
when the effect lands outside the database. The inbox records an attempt before
running the effect and completes it after, and a recovery that finds an
unfinished attempt asks what kind of effect it was:

- `idempotent` — redoing it is harmless. The inbox re-runs it.
- `external` — redoing it may double a real action. The inbox refuses and parks
  the record as `needs-manual`, which is what the order requires of
  non-idempotent external effects. The stored kind wins: a later caller cannot
  downgrade an interrupted external effect to idempotent.

### Fencing, and the defect it exposed

`AGENTS.md` asks for cheap mechanisms and puts fencing tokens on the list of
things that need "a concrete failure simpler code cannot handle". Here is that
failure, found in production:

Four functions close or advance a task with no fence token —
`lumina_finish_task`, `lumina_fail_task`, `lumina_start_task`,
`lumina_heartbeat_task`. Each admits the caller on `status in
('claimed','running') AND claimed_by = p_agent_key`. The owner is the _agent
key_, which every attempt by that agent shares, and Lumina runs one key per
agent. So:

1. `openclaw-gateway` claims task T → `fence_token = 1`
2. the gateway hangs; the lease expires
3. `lumina_requeue_expired_tasks()` clears `claimed_by` → `fence_token = 2`
4. the same agent claims T again → `fence_token = 3`
5. the original worker wakes and calls `lumina_finish_task(T, 'openclaw-gateway',
   'completed')` — the predicate holds, and it marks T completed over the live
   attempt

`lumina_finish_task_fenced` would have rejected it. Two mitigations:

- **Now, in code:** `task-recovery.ts` closes a task only through
  `lumina_finish_task_fenced`, and never calls `lumina_finish_task`,
  `lumina_fail_task` or `lumina_start_task` at all. It does call
  `lumina_heartbeat_task`, because there is no fenced variant to call: it
  compensates by comparing the fence token on the row the RPC returns and
  reporting `fence-superseded`, so a stale worker learns it was replaced on its
  next heartbeat. The renewal itself still lands unfenced, which extends the
  _live_ holder's lease — wasteful, not incorrect. This needs no approval and
  ships today.
- **Proposed, blocked:** `sql/lumina_mesh_fence_hardening.sql` adds a required
  `p_fence_token` to all four and drops the old signatures. That is DDL on the
  shared project, so it waits for Dal.

The outbox applies the same discipline locally: a claim carries a monotonic
token, and the holder check runs immediately before the write that would take
effect. A dispatcher whose claim was superseded is refused _even though its
transport call may have succeeded_ — and that refusal is recorded, not hidden,
because it is exactly the at-least-once seam.

### The authority boundary

`authorize` takes an envelope's metadata and records held out of band. It does
not take the payload and cannot reach it: `payload_ref` is a reference this
module never dereferences. So no sentence inside a message can change a
decision, because the decision function never reads it. That is a type-level
property, not a promise (ADR 0002: safety is code; ADR 0006: untrusted content
never executes).

Two rules carry most of the weight:

- **Dal is not a party on the bus.** Dal's authority enters only as a
  `MeshAuthorization` record created out of band. An envelope claiming `origin:
  "dal"` — or `owner`, `user`, `human`, `principal`, `admin`, `root`, `system` —
  is always a forgery and always refused.
- **An origin is a claim until a channel vouches for it.** Authentication
  compares the envelope's `origin` against the identity the receiving channel
  independently established. A mismatch is a forgery. A channel that cannot name
  its peer is `unverified`, and an unverified origin may act only in the green
  zone.

Zones: `green` reversible and low risk, proceeds; `yellow` reversible but
operationally visible, proceeds and must be announced; `red` money,
credentials, deletion, irreversibility, personal data or a sensitive decision,
never on an agent's own authority. A red grant must additionally be issued by a
party in `authorities` — an agent cannot widen its own reach by writing itself a
permission slip.

Priority is an absolute per-party ceiling that no grant lifts. It labels how
loudly a message asks for attention, and priority 6 means "a decision for Dal",
so no agent stamps it.

A refusal has no side effect: a single-use grant is spent only on the admitted
path, and the replay guard remembers only admitted messages.

### The scorecard

`iccv.ts` weighs five components — D delivered 25%, E executed 25%, V verified
20%, R recovered 15%, T transactionally intact 15%.

**A component with no denominator is N/A, never 100%.** The score is weighted
over the measured components only and is always reported next to `coverage`: the
share of total weight those components represent. A score of 1.0 at coverage
0.25 says "the quarter we could measure looks clean", which is a different claim
from "everything is fine". With nothing observed, the score is `null` — not zero,
not one.

Backlog, dead letters, unacked messages, lease conflicts and parked effects are
gauges, reported beside the index and never folded into it.

`assessSuperadditiveClaim` is the single gate on LUMINA-001
(`A = C_tripartita - sum(C_i)`). It returns `"unvalidated"` and has no code path
that returns an advantage figure. Running the mesh does not validate the
hypothesis; a dedicated experiment with three individual baselines, equivalent
resources and blind review would.

## The second defect: a close is not idempotent

Found by running the real functions, not by reading them.
`lumina_finish_task_fenced` guards the _holder_ but not the _state_. Its UPDATE
filters on `id AND fence_token AND claimed_by`, with no status predicate, and a
completed task keeps both its `claimed_by` and its token. So:

- calling it twice with the same valid token overwrites `result` and `evidence`
  the second time, and
- a settled task can be flipped from `completed` to `rejected` after the fact.

Neither shows up in the audit trail, because `lumina_log_task_event` only writes
when `status` actually changes, so a same-status overwrite is silent.

This matters precisely because mesh delivery is at-least-once by contract. A
lost ack makes a second close an ordinary event, not an attack. The proposed fix
makes a repeat of the same outcome a no-op reporting `TASK_ALREADY_COMPLETED`,
and refuses a different outcome on a settled task with `ALREADY_SETTLED`.

## Proof on a real PostgreSQL

`sql/m2-fencing.mjs` runs the production `lumina_*` functions — replayed
verbatim from `pg_get_functiondef` into `sql/m2-schema.sql` — on an embedded
PostgreSQL, and asserts 38 things. Nothing touches the shared project.

It reproduces both defects and proves both fixes: the zombie closes a live
attempt through the unfenced path and its payload becomes the result; the fenced
path refuses the same zombie and names both tokens; after the migration the
unfenced path refuses it too, the hardened heartbeat refuses it, the live holder
still finishes, a repeat is a no-op, and a flip is refused.

It also asserts that **exactly one function exists per name** after the
migration. That check exists because the first draft of the migration guessed
the signatures: the real ones are `lumina_finish_task(uuid,text,jsonb,jsonb)`,
`lumina_start_task(uuid,text,integer)` and
`lumina_heartbeat_task(uuid,text,integer)`. `drop function if exists` does
nothing on a signature mismatch and `create or replace` with a different
argument list makes an _overload_, so that draft would have reported success
while leaving the unfenced functions callable.

Run it from a throwaway install, since adding a dependency to this fork needs
approval:

```sh
mkdir pg-harness && cd pg-harness
npm init -y && npm pkg set type=module
npm install @electric-sql/pglite
cp <repo>/extensions/lumina-cognitive-os/sql/m2-fencing.mjs .
cp <repo>/extensions/lumina-cognitive-os/sql/m2-schema.sql schema.sql
cp <repo>/extensions/lumina-cognitive-os/sql/lumina_mesh_fence_hardening.sql hardening.sql
node m2-fencing.mjs
```

Honest limit: PGlite is a single in-process backend, so the two workers are two
logical holders driven in a forced interleaving rather than two OS processes
racing. That is deliberate — the defect is an ordering bug, so forcing the order
proves it every run instead of hoping a race lands — but `FOR UPDATE SKIP
LOCKED` contention itself is upstream PostgreSQL behaviour and is not what this
verifies. The embedded server is PostgreSQL 18.6; production is 17.6.

## Shared memory: two axes, one table

`shared_memory` already had every column Phase E needs, and nothing in
TypeScript used any of them. `shared-memory.ts` is the missing owner.

The review stage the order asks for — proposed, contrasted, approved — lives in
`metadata`, **not** in `status`. The live `status` column has its own domain
(205 `active`, 96 `superseded`, 24 `archived`) and it drives what every reader
treats as current, so writing new words into it would silently change what other
agents see on a shared table. Lifecycle and epistemic stage stay apart, both on
existing columns, with no migration.

A hypothesis is never stored as a fact: `isEstablished` refuses anything
`proposed` however confident, and reaching `contrasted` requires naming the
independent source that agreed.

`auditSharedMemory` reports and does not repair, because these rows were written
by several agents over weeks. It finds what the live table actually has: 106 rows
carry `superseded_by` while only 96 say `superseded`; two active content hashes
are duplicated; `conflict_with` has never been used; and actor names collide on
case (`chatgpt-lumina` 56 rows against `ChatGPT-Lumina` 23), so anything grouped
by raw actor is already wrong.

The ten are **graded, not lumped together**, and that distinction was earned the
hard way. An `active` row with a pointer is served to any reader filtering on
status, which is a real misread. An `archived` one is already excluded, so it is
only bookkeeping drift. Measured on 2026-11-01, before touching anything: all
ten are `archived`, every one of them an `actor: test-suite` fixture with a
`test-mvp-*` topic, and **no row is both pointered and active**. So there was
nothing to repair, and an earlier draft of this document claiming a status filter
"still treats them as current" was simply wrong about these rows. The audit now
reports `superseded-while-active` for the harmful case and
`superseded-status-drift` for the benign one, so nobody is sent to fix data that
reads correctly.

## Reaching the ChatGPT core, honestly

`chatgpt-adapter.ts` describes the three routes that exist and drives the one
that can carry a message out. Every route's `backgroundListener` field is the
literal type `false`, so no code built on it can claim the ChatGPT session
listens to the bus unattended — a type-level guarantee, not a comment.

Nothing is enabled by default, no route needs a new credential, and none costs
money. The transport refuses non-retryably while unconfigured and says what is
missing, so an unwired mesh does not silently drop messages to the core. A
message the relay could not confirm the server kept is retried rather than
recorded as delivered.

## Relationship to the live gateway

The production gateway runs from `dist/` of this checkout (PID 31432,
`dist/index.js gateway --port 18789`, started 2026-10-27). Nothing here touches
it:

- No module in `src/mesh/` is imported by any gateway code path. The three core
  call sites of `src/lumina/cognitive-bus.ts` are untouched, and the emitter
  stays fire-and-forget: it must never block or fail because Supabase is
  unreachable.
- Tests and typecheck never write `dist/`. `tsconfig.json` sets `noEmit: true`,
  which leaves its `outDir` inert, and the Vitest runners contain no reference to
  `dist` at all.
- `pnpm test:extension` and `pnpm test` route through a plan that can trigger a
  pretest build for certain e2e files. Use the runner directly instead:

```sh
# one file, no build, no dist
node scripts/run-vitest.mjs run --config test/vitest/vitest.extensions.config.ts \
  extensions/lumina-cognitive-os/src/mesh/outbox.test.ts

# the whole mesh
node scripts/run-vitest.mjs run --config test/vitest/vitest.extensions.config.ts \
  extensions/lumina-cognitive-os/src/mesh/

# typecheck (production code; tests are covered by the extensions test tsconfig)
node scripts/run-tsgo.mjs -p tsconfig.extensions.json --incremental \
  --tsBuildInfoFile .artifacts/tsgo-cache/extensions.tsbuildinfo
```

`MeshOutbox` and `MeshInbox` take a `StateStorePort`, which is the host's SQLite
plugin state in production (ADR 0003) and an in-memory map in tests. Note the
constraint in `docs/reference/database-schemas/worker-access.md`: runtime
database access belongs in worker threads, never on the Gateway main thread.
Phase 1 runs the mesh independently, so this is not yet an issue; wiring it into
the gateway must go through a worker.

## What is blocked, and why

Each of these needs Dal. None of them blocks the rest.

| Blocked                                             | Why                                                                 | Proposal                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Fence hardening, and the idempotent close           | DDL on the shared project                                           | `sql/lumina_mesh_fence_hardening.sql`, with rollback, proven by `sql/m2-fencing.mjs` |
| Unique index for DB-level delivery dedup            | DDL on the shared project                                           | `sql/lumina_mesh_events.sql` §1 — optional; `inbox.ts` already guarantees one effect |
| Realtime on `lumina_events`                         | DDL, and it raises replication traffic on the busiest table         | `sql/lumina_mesh_events.sql` §2 — optional; polling is correct without it            |
| `lumina_audit_checkpoints`                          | pre-existing task 23, same reason                                   | `sql/lumina_audit_checkpoints.sql`                                                   |
| A ChatGPT adapter that writes the bus automatically | needs either paid API access or a credential Dal has not authorized | the three existing paths are documented below; none of them is a background listener |

## Rollback

Two independent things to undo, and neither touches a schema.

**The mesh itself** is new files under `extensions/lumina-cognitive-os/`:
`src/mesh/`, the four files in `sql/`, and this document. Deleting them removes
it completely, because nothing imports them from a gateway code path.

**The upstream 2026.10.9 merge** has a tag cut at the commit before it:

```sh
# inspect what the merge brought
git diff pre-upstream-10.9-2026-10-31..HEAD --stat

# abandon the merge entirely, keeping the mesh work that preceded it
git switch lumina/cognitive-core
git reset --hard pre-upstream-10.9-2026-10-31
pnpm install            # the lockfile goes back with it
```

`pre-upstream-10.9-2026-10-31` points at `0b90dfeaf63`, which is the mesh
without the merge. The merge commit `df63d26bd46` has that as its first parent,
so `git revert -m 1 df63d26bd46` is the alternative that keeps the history.

Neither path touches the running gateway on its own: `dist/` is gitignored, so
no git operation reaches the artifacts the live process serves. Restoring the
_running_ build after a rollback needs a deliberate `pnpm build` and a restart,
which is a separate, authorized step.

## Honest limits

- The `supabase-transport` tests use an injected `fetch`. No test in this
  repository writes to the real Supabase project, so the projection is proven
  against the schema as inventoried, not against a live insert.
- `task-recovery` is likewise proven against recorded PostgREST shapes. The
  fencing _rejection_ it parses is the real message format from
  `lumina_finish_task_fenced`. The database side of that story is now proven
  separately on a real PostgreSQL in `sql/m2-fencing.mjs`; what is still absent
  is two OS processes racing, for the reason given there.
- The mesh is not wired into the gateway. That is the order's Phase 1 design, not
  an oversight, and it means none of this runs in production until someone
  deliberately registers it.
- `LUMINA_STATUS.md` was 25 days stale when this work began; it was brought
  current on 2026-10-31 and now records the mesh, the upstream merge and both
  open defects.
- The shared-memory audit reports live inconsistencies and deliberately repairs
  none of them. The actor case collisions and the two duplicate hashes are a data
  decision for Dal, not something this code should rewrite on a hunch. The ten
  pointered rows turned out to need no repair at all: they are archived
  test-suite fixtures, and archived already excludes them.
- `event-digest` and `chatgpt-adapter` are unit-proven and unwired: nothing
  schedules a digest or hands the adapter a real relay yet.
