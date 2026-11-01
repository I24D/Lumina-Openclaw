/**
 * m2-fencing.mjs — TEST M2 against a real PostgreSQL, in isolation.
 *
 * Runs the production `lumina_*` task-queue functions (replayed verbatim into
 * schema.sql from pg_get_functiondef) on an embedded PostgreSQL 17 (PGlite).
 * Nothing here touches the shared Lumina_IA project.
 *
 * What it proves, in order:
 *
 *   1. the fencing token really is monotonic, and a lease-expiry cycle bumps it
 *      twice (requeue clears the holder, the re-claim sets it again)
 *   2. THE DEFECT: a zombie worker holding a stale token CAN close a live
 *      attempt through the unfenced `lumina_finish_task`
 *   3. the same zombie is refused by `lumina_finish_task_fenced`
 *   4. after the proposed migration, the unfenced path refuses it too
 *   5. the migration leaves no unfenced overload behind
 *   6. the live holder can still finish, exactly once
 *   7. `lumina_enqueue_task` is idempotent per (created_by, idempotency_key)
 *
 * Honest limit: PGlite is a single in-process backend, so the two workers are
 * two logical holders driven in a deterministic interleaving rather than two OS
 * processes racing. That is on purpose: the defect is an ordering bug, and
 * forcing the order proves it every run instead of hoping a race lands.
 * `FOR UPDATE SKIP LOCKED` contention itself is upstream PostgreSQL behaviour
 * and is not what these tests claim to verify.
 */
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const AGENT = "openclaw-gateway";
let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}`);
    console.log(`        expected ${JSON.stringify(expected)}`);
    console.log(`        actual   ${JSON.stringify(actual)}`);
  }
}

function checkMatch(label, actual, pattern) {
  const ok = typeof actual === "string" && pattern.test(actual);
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}`);
    console.log(`        expected to match ${pattern}`);
    console.log(`        actual            ${JSON.stringify(actual)}`);
  }
}

const db = new PGlite();
await db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
console.log("schema loaded into embedded PostgreSQL");
const version = await db.query("select version()");
console.log(`server: ${version.rows[0].version.split(",")[0]}`);
console.log("");

await db.exec(`
  insert into public.lumina_agents(agent_key, display_name, role)
  values ('${AGENT}', 'OpenClaw gateway', 'executor');
`);

/** Enqueues one task assigned to the single agent key, as Lumina really does. */
async function seedTask(intent, idempotencyKey = null) {
  const res = await db.query(
    `insert into public.lumina_tasks(created_by, assigned_to, intent, idempotency_key, max_attempts)
     values ($1, $2, $3, $4, 9) returning id, fence_token, status`,
    ["chatgpt-lumina", AGENT, intent, idempotencyKey],
  );
  return res.rows[0];
}

async function claim() {
  const res = await db.query(`select * from public.lumina_claim_task($1, $2)`, [AGENT, 60]);
  return res.rows[0];
}

/** Moves a lease into the past: the same state a hung gateway leaves behind. */
async function expireLease(taskId) {
  await db.query(
    `update public.lumina_tasks set lease_until = now() - interval '1 hour' where id = $1`,
    [taskId],
  );
}

async function taskRow(taskId) {
  const res = await db.query(
    `select status, claimed_by, fence_token, attempt_count, result, completed_at
       from public.lumina_tasks where id = $1`,
    [taskId],
  );
  return res.rows[0];
}

// ---------------------------------------------------------------------------
console.log("1. the fencing token is monotonic across a lease-expiry cycle");
// ---------------------------------------------------------------------------
const t1 = await seedTask("prove the fence is monotonic");
check("a fresh task starts at fence 0", t1.fence_token, 0);

const firstClaim = await claim();
check("the first claim is granted", firstClaim.status, "claimed");
check("claiming the task bumps the fence to 1", firstClaim.fence_token, 1);
check("the attempt counter moved", firstClaim.attempt_count, 1);
const staleToken = firstClaim.fence_token;

await expireLease(t1.id);
const secondClaim = await claim();
check("the same agent re-claims after the lease expired", secondClaim.status, "claimed");
// requeue clears claimed_by (+1) and the re-claim sets it again (+1).
check("one expiry cycle bumps the fence twice", secondClaim.fence_token, 3);
check("the attempt counter moved again", secondClaim.attempt_count, 2);
const liveToken = secondClaim.fence_token;
console.log(
  `  (zombie holds fence ${staleToken}, the live attempt holds fence ${liveToken}, same agent key)`,
);
console.log("");

// ---------------------------------------------------------------------------
console.log("2. THE DEFECT: the unfenced closer lets the zombie overwrite");
// ---------------------------------------------------------------------------
let defectReproduced = false;
try {
  await db.query(`select * from public.lumina_finish_task($1, $2, $3, $4)`, [
    t1.id,
    AGENT,
    JSON.stringify({ written_by: "zombie-attempt-1" }),
    JSON.stringify([]),
  ]);
  defectReproduced = true;
} catch (error) {
  console.log(`  (unfenced call raised: ${error.message})`);
}
check("lumina_finish_task accepted a stale holder", defectReproduced, true);
const afterZombie = await taskRow(t1.id);
check("the live attempt was closed by the zombie", afterZombie.status, "completed");
check(
  "and the zombie's payload is now the task result",
  afterZombie.result?.written_by,
  "zombie-attempt-1",
);
console.log("  => defect confirmed on real PostgreSQL, not inferred");
console.log("");

// ---------------------------------------------------------------------------
console.log("3. the fenced closer refuses the same zombie");
// ---------------------------------------------------------------------------
const t2 = await seedTask("prove the fenced closer refuses a stale holder");
const t2First = await claim();
await expireLease(t2.id);
const t2Live = await claim();

const fenced = await db.query(
  `select * from public.lumina_finish_task_fenced($1, $2, $3, $4, $5, $6)`,
  [t2.id, AGENT, t2First.fence_token, "completed", null, null],
);
check("the fenced closer refused it", fenced.rows[0].ok, false);
checkMatch(
  "and named both tokens",
  fenced.rows[0].message,
  new RegExp(
    `^FENCING_REJECTED: token ${t2First.fence_token} is stale, current fence token is ${t2Live.fence_token}$`,
  ),
);
const t2AfterRefusal = await taskRow(t2.id);
check("the task is untouched by the refusal", t2AfterRefusal.status, "claimed");
check("no result was written", t2AfterRefusal.result, null);
console.log("");

// ---------------------------------------------------------------------------
console.log("4. the live holder finishes, exactly once");
// ---------------------------------------------------------------------------
const live = await db.query(
  `select * from public.lumina_finish_task_fenced($1, $2, $3, $4, $5, $6)`,
  [t2.id, AGENT, t2Live.fence_token, "completed", JSON.stringify({ written_by: "live" }), null],
);
check("the live holder is admitted", live.rows[0].ok, true);
check("with the status echoed back", live.rows[0].message, "TASK_COMPLETED");
const t2Done = await taskRow(t2.id);
check("the result is the live holder's", t2Done.result?.written_by, "live");

// SECOND DEFECT. A completed task keeps its claimed_by and its token, and the
// fenced closer's UPDATE has no status predicate, so a repeat overwrites the
// result. At-least-once delivery makes that repeat an ordinary event.
const again = await db.query(
  `select * from public.lumina_finish_task_fenced($1, $2, $3, $4, $5, $6)`,
  [t2.id, AGENT, t2Live.fence_token, "completed", JSON.stringify({ written_by: "double" }), null],
);
check("a repeated close is accepted", again.rows[0].ok, true);
const t2Final = await taskRow(t2.id);
check("DEFECT: the repeat overwrote the settled result", t2Final.result?.written_by, "double");
const completions = await db.query(
  `select count(*)::int as n from public.lumina_task_events
    where task_id = $1 and event_type = 'status_changed' and data->>'to' = 'completed'`,
  [t2.id],
);
check("and the audit trail still shows one completion", completions.rows[0].n, 1);
console.log("  => the overwrite is invisible in the event log: status did not change");

// Worse: a settled task can be flipped to another outcome after the fact.
const flipped = await db.query(
  `select * from public.lumina_finish_task_fenced($1, $2, $3, $4, $5, $6)`,
  [t2.id, AGENT, t2Live.fence_token, "rejected", null, null],
);
check("DEFECT: a settled task can be flipped to another outcome", flipped.rows[0].ok, true);
check("the task is now rejected, not completed", (await taskRow(t2.id)).status, "rejected");
console.log("");

// ---------------------------------------------------------------------------
console.log("5. after the proposed migration the unfenced path refuses too");
// ---------------------------------------------------------------------------
await db.exec(readFileSync(new URL("./hardening.sql", import.meta.url), "utf8"));
console.log("  migration applied");

const overloads = await db.query(
  `select p.proname, count(*)::int as n
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('lumina_finish_task','lumina_fail_task','lumina_start_task','lumina_heartbeat_task')
    group by p.proname order by p.proname`,
);
check(
  "no unfenced overload survived the migration",
  overloads.rows.map((r) => `${r.proname}:${r.n}`),
  ["lumina_fail_task:1", "lumina_finish_task:1", "lumina_heartbeat_task:1", "lumina_start_task:1"],
);

const t3 = await seedTask("prove the migration closes the hole");
const t3First = await claim();
await expireLease(t3.id);
const t3Live = await claim();

let refusedAfterMigration = "";
try {
  await db.query(`select * from public.lumina_finish_task($1, $2, $3, $4, $5)`, [
    t3.id,
    AGENT,
    t3First.fence_token,
    JSON.stringify({ written_by: "zombie-after-migration" }),
    JSON.stringify([]),
  ]);
} catch (error) {
  refusedAfterMigration = error.message;
}
checkMatch(
  "the hardened lumina_finish_task refuses the stale holder",
  refusedAfterMigration,
  /FENCING_REJECTED: token \d+ is stale, current fence token is \d+/u,
);
const t3After = await taskRow(t3.id);
check("the live attempt survived", t3After.status, "claimed");
check("no zombie payload landed", t3After.result, null);

let heartbeatRefused = "";
try {
  await db.query(`select * from public.lumina_heartbeat_task($1, $2, $3, $4)`, [
    t3.id,
    AGENT,
    t3First.fence_token,
    300,
  ]);
} catch (error) {
  heartbeatRefused = error.message;
}
checkMatch(
  "the hardened heartbeat refuses the stale holder",
  heartbeatRefused,
  /FENCING_REJECTED/u,
);

const t3Ok = await db.query(`select * from public.lumina_finish_task($1, $2, $3, $4, $5)`, [
  t3.id,
  AGENT,
  t3Live.fence_token,
  JSON.stringify({ written_by: "live-after-migration" }),
  JSON.stringify([]),
]);
check("the live holder still finishes", t3Ok.rows[0].status, "completed");
check("with its own payload", t3Ok.rows[0].result?.written_by, "live-after-migration");
console.log("");

// ---------------------------------------------------------------------------
console.log("5b. and the fenced closer is now idempotent");
// ---------------------------------------------------------------------------
const t4 = await seedTask("prove the fenced closer became idempotent");
const t4Claim = await claim();
const t4Done = await db.query(
  `select * from public.lumina_finish_task_fenced($1, $2, $3, $4, $5, $6)`,
  [t4.id, AGENT, t4Claim.fence_token, "completed", JSON.stringify({ written_by: "live" }), null],
);
check("the first close lands", t4Done.rows[0].ok, true);

const t4Repeat = await db.query(
  `select * from public.lumina_finish_task_fenced($1, $2, $3, $4, $5, $6)`,
  [t4.id, AGENT, t4Claim.fence_token, "completed", JSON.stringify({ written_by: "double" }), null],
);
check("a repeat of the same outcome is admitted", t4Repeat.rows[0].ok, true);
check("and reports it was already settled", t4Repeat.rows[0].message, "TASK_ALREADY_COMPLETED");
check("the settled result is NOT overwritten", (await taskRow(t4.id)).result?.written_by, "live");

const t4Flip = await db.query(
  `select * from public.lumina_finish_task_fenced($1, $2, $3, $4, $5, $6)`,
  [t4.id, AGENT, t4Claim.fence_token, "rejected", null, null],
);
check("a different outcome on a settled task is refused", t4Flip.rows[0].ok, false);
checkMatch(
  "and says what it refused",
  t4Flip.rows[0].message,
  /^ALREADY_SETTLED: task is completed, refusing rejected$/u,
);
check("the status is unchanged", (await taskRow(t4.id)).status, "completed");
console.log("");

// ---------------------------------------------------------------------------
console.log("6. one effect per idempotency key, at the database level");
// ---------------------------------------------------------------------------
await db.exec(`
  CREATE OR REPLACE FUNCTION public.lumina_enqueue_task(p_created_by text, p_assigned_to text, p_intent text, p_payload jsonb DEFAULT '{}'::jsonb, p_priority smallint DEFAULT 50, p_idempotency_key text DEFAULT NULL::text, p_parent_task_id uuid DEFAULT NULL::uuid, p_origin_memory_id uuid DEFAULT NULL::uuid, p_decision_ref text DEFAULT NULL::text, p_max_attempts integer DEFAULT 3)
   RETURNS lumina_tasks
   LANGUAGE plpgsql
   SET search_path TO 'public'
  AS $function$
  declare
    v_task public.lumina_tasks;
  begin
    if p_idempotency_key is not null then
      select * into v_task
      from public.lumina_tasks
      where created_by=p_created_by and idempotency_key=p_idempotency_key
      limit 1;
      if found then
        return v_task;
      end if;
    end if;

    insert into public.lumina_tasks(
      created_by, assigned_to, intent, payload, priority, idempotency_key,
      parent_task_id, origin_memory_id, decision_ref, max_attempts
    )
    values(
      p_created_by, p_assigned_to, p_intent, coalesce(p_payload,'{}'::jsonb),
      p_priority, p_idempotency_key, p_parent_task_id, p_origin_memory_id,
      p_decision_ref, p_max_attempts
    )
    returning * into v_task;
    return v_task;
  end;
  $function$;
`);

const enq1 = await db.query(
  `select id from public.lumina_enqueue_task($1, $2, $3, $4, 50::smallint, $5)`,
  ["chatgpt-lumina", AGENT, "deliver the mesh report", JSON.stringify({}), "imk_once"],
);
const enq2 = await db.query(
  `select id from public.lumina_enqueue_task($1, $2, $3, $4, 50::smallint, $5)`,
  ["chatgpt-lumina", AGENT, "deliver the mesh report (retry)", JSON.stringify({}), "imk_once"],
);
check("a repeated enqueue returns the same task", enq2.rows[0].id, enq1.rows[0].id);
const enqCount = await db.query(
  `select count(*)::int as n from public.lumina_tasks where idempotency_key = 'imk_once'`,
);
check("and created exactly one row", enqCount.rows[0].n, 1);
console.log("");

// ---------------------------------------------------------------------------
console.log(`RESULT: ${passed} passed, ${failed} failed`);
await db.close();
process.exit(failed === 0 ? 0 : 1);
