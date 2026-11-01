-- lumina_mesh_fence_hardening.sql — close the unfenced task-closing paths.
--
-- STATUS: PROPOSED. NOT APPLIED. This replaces functions in the shared
-- Lumina_IA project (zcleztlzatnnoishtpfk), which is a red action under Dal's
-- order of 2026-10-31: it needs explicit approval and the repository's database
-- review checkpoint (docs/reference/database-schemas/storage-changes.md).
-- Apply through the Supabase MCP connector's apply_migration.
--
-- PROVEN, NOT ASSUMED. Both the defect and this fix are exercised against a
-- real PostgreSQL 17 in `sql/m2-fencing.mjs`, which replays the live function
-- definitions into an embedded server. Run it before approving this file.
--
-- ## The defect, concretely
--
-- `lumina_tasks.fence_token` is a real monotonic fencing token: the trigger
-- `trg_lumina_tasks_fence` -> `lumina_bump_fence()` increments it whenever
-- `claimed_by` changes, and `lumina_finish_task_fenced` refuses a stale holder
-- with FENCING_REJECTED. That part works.
--
-- Four sibling functions close or advance a task with NO fence token. Each
-- admits the caller on `status in ('claimed','running') AND claimed_by =
-- p_agent_key`. The owner is the *agent key*, which every attempt by that agent
-- shares, and Lumina runs one key per agent, so the predicate cannot tell two
-- attempts apart:
--
--   1. openclaw-gateway claims task T        -> fence_token 0 -> 1
--   2. the gateway hangs; the lease expires
--   3. lumina_requeue_expired_tasks() clears claimed_by -> fence_token 2
--   4. the same agent claims T again          -> fence_token 3
--   5. the ORIGINAL worker wakes up, still holding 1, and calls
--      lumina_finish_task(T, 'openclaw-gateway', ...)
--
-- At step 5 the predicate holds, so the stale worker marks T completed over the
-- live attempt and overwrites `result` with its own payload. Measured in the
-- harness: the zombie's payload becomes the task result.
--
-- ## Signatures matter here
--
-- The real signatures, read from pg_get_functiondef on 2026-10-31, are:
--
--   lumina_finish_task(uuid, text, jsonb, jsonb)
--   lumina_fail_task(uuid, text, text, jsonb, jsonb, boolean)
--   lumina_start_task(uuid, text, integer)
--   lumina_heartbeat_task(uuid, text, integer)
--
-- `drop function if exists` silently does nothing when the argument list does
-- not match, and `create or replace` with a different argument list creates an
-- OVERLOAD rather than replacing anything. A migration that gets a signature
-- wrong therefore reports success while leaving the unfenced function callable.
-- The harness asserts exactly one function per name after this runs.
--
-- ## Compatibility
--
-- Breaking by design: the unfenced argument lists are dropped, not kept as
-- overloads, because an unfenced path left reachable *is* the defect.
--
-- Callers to migrate:
--   * This repository: none. `src/mesh/task-recovery.ts` closes tasks only
--     through `lumina_finish_task_fenced`, and never calls `lumina_finish_task`,
--     `lumina_fail_task` or `lumina_start_task`. Its `heartbeat` does call
--     `lumina_heartbeat_task` and must gain the token argument with this change.
--   * The Python bus library at
--     ~/.openclaw/workspace/lumina-cognitive-bus/lumina_bus.py, which is the
--     only other caller. Its finish/fail/start/heartbeat helpers need the token
--     threaded through from the claim.
--
-- Apply this and the TypeScript change together, or apply this first and accept
-- that an un-updated caller fails loudly with "function does not exist" rather
-- than silently overwriting a live attempt. Loud is the safer failure.
--
-- ROLLBACK: capture `pg_get_functiondef` for all four before applying, then
-- restore those definitions and drop the fenced argument lists created here.
-- The rollback block at the end of this file does that for a clean revert.

begin;

-- 1. lumina_start_task: a stale holder must not move a live attempt to running.
drop function if exists public.lumina_start_task(uuid, text, integer);

create function public.lumina_start_task(
  p_task_id uuid,
  p_agent_key text,
  p_fence_token integer,
  p_lease_seconds integer default 900
) returns public.lumina_tasks
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_task public.lumina_tasks;
  v_token int;
  v_owner text;
begin
  select fence_token, claimed_by into v_token, v_owner
    from public.lumina_tasks where id = p_task_id for update;
  if v_owner is null then
    raise exception 'TASK_NOT_FOUND_OR_UNCLAIMED: %', p_task_id;
  end if;
  if v_token <> p_fence_token then
    raise exception 'FENCING_REJECTED: token % is stale, current fence token is %',
      p_fence_token, v_token;
  end if;
  if v_owner <> p_agent_key then
    raise exception 'NOT_OWNER: task belongs to %', v_owner;
  end if;

  update public.lumina_tasks
  set status='running',
      lease_until=now() + make_interval(secs => greatest(60, least(p_lease_seconds, 3600)))
  where id=p_task_id
    and status='claimed'
    and claimed_by=p_agent_key
    and fence_token=p_fence_token
  returning * into v_task;
  if not found then
    raise exception 'FENCING_REJECTED_AT_UPDATE: task % changed hands during start', p_task_id;
  end if;
  return v_task;
end;
$function$;

-- 2. lumina_heartbeat_task: renewing a lease is a write, so it needs the fence.
drop function if exists public.lumina_heartbeat_task(uuid, text, integer);

create function public.lumina_heartbeat_task(
  p_task_id uuid,
  p_agent_key text,
  p_fence_token integer,
  p_lease_seconds integer default 900
) returns public.lumina_tasks
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_task public.lumina_tasks;
  v_token int;
  v_owner text;
begin
  select fence_token, claimed_by into v_token, v_owner
    from public.lumina_tasks where id = p_task_id for update;
  if v_owner is null then
    raise exception 'TASK_NOT_FOUND_OR_UNCLAIMED: %', p_task_id;
  end if;
  if v_token <> p_fence_token then
    raise exception 'FENCING_REJECTED: token % is stale, current fence token is %',
      p_fence_token, v_token;
  end if;
  if v_owner <> p_agent_key then
    raise exception 'NOT_OWNER: task belongs to %', v_owner;
  end if;

  update public.lumina_tasks
  set lease_until = now() + make_interval(secs => greatest(60, least(p_lease_seconds, 3600)))
  where id = p_task_id
    and status in ('claimed','running')
    and claimed_by = p_agent_key
    and fence_token = p_fence_token
  returning * into v_task;
  if not found then
    raise exception 'FENCING_REJECTED_AT_UPDATE: task % changed hands during heartbeat', p_task_id;
  end if;

  insert into public.lumina_task_events(task_id,event_type,actor,data)
  values(
    p_task_id,
    'heartbeat',
    p_agent_key,
    jsonb_build_object('lease_until',v_task.lease_until,'fence_token',p_fence_token)
  );

  return v_task;
end;
$function$;

-- 3. lumina_finish_task: the path that caused the defect.
drop function if exists public.lumina_finish_task(uuid, text, jsonb, jsonb);

create function public.lumina_finish_task(
  p_task_id uuid,
  p_agent_key text,
  p_fence_token integer,
  p_result jsonb default '{}'::jsonb,
  p_evidence jsonb default '[]'::jsonb
) returns public.lumina_tasks
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_task public.lumina_tasks;
  v_token int;
  v_owner text;
begin
  select fence_token, claimed_by into v_token, v_owner
    from public.lumina_tasks where id = p_task_id for update;
  if v_owner is null then
    raise exception 'TASK_NOT_FOUND_OR_UNCLAIMED: %', p_task_id;
  end if;
  if v_token <> p_fence_token then
    raise exception 'FENCING_REJECTED: token % is stale, current fence token is %',
      p_fence_token, v_token;
  end if;
  if v_owner <> p_agent_key then
    raise exception 'NOT_OWNER: task belongs to %', v_owner;
  end if;

  update public.lumina_tasks
  set status='completed',
      result=coalesce(p_result,'{}'::jsonb),
      evidence=coalesce(p_evidence,'[]'::jsonb),
      error=null,
      completed_at=now(),
      lease_until=null
  where id=p_task_id
    and status in ('claimed','running')
    and claimed_by=p_agent_key
    and fence_token=p_fence_token
  returning * into v_task;
  if not found then
    raise exception 'FENCING_REJECTED_AT_UPDATE: task % changed hands during finish', p_task_id;
  end if;
  return v_task;
end;
$function$;

-- 4. lumina_fail_task: same rule, and it keeps its own retry decision.
drop function if exists public.lumina_fail_task(uuid, text, text, jsonb, jsonb, boolean);

create function public.lumina_fail_task(
  p_task_id uuid,
  p_agent_key text,
  p_fence_token integer,
  p_error text,
  p_result jsonb default null::jsonb,
  p_evidence jsonb default '[]'::jsonb,
  p_retry boolean default false
) returns public.lumina_tasks
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_task public.lumina_tasks;
  v_token int;
  v_owner text;
begin
  select fence_token, claimed_by into v_token, v_owner
    from public.lumina_tasks where id = p_task_id for update;
  if v_owner is null then
    raise exception 'TASK_NOT_FOUND_OR_UNCLAIMED: %', p_task_id;
  end if;
  if v_token <> p_fence_token then
    raise exception 'FENCING_REJECTED: token % is stale, current fence token is %',
      p_fence_token, v_token;
  end if;
  if v_owner <> p_agent_key then
    raise exception 'NOT_OWNER: task belongs to %', v_owner;
  end if;

  update public.lumina_tasks
  set status = case
      when p_retry and attempt_count < max_attempts then 'retry'
      else 'failed'
    end,
    result=p_result,
    evidence=coalesce(p_evidence,'[]'::jsonb),
    error=p_error,
    completed_at=case
      when p_retry and attempt_count < max_attempts then null
      else now()
    end,
    claimed_by=case
      when p_retry and attempt_count < max_attempts then null
      else claimed_by
    end,
    claimed_at=case
      when p_retry and attempt_count < max_attempts then null
      else claimed_at
    end,
    lease_until=null
  where id=p_task_id
    and status in ('claimed','running')
    and claimed_by=p_agent_key
    and fence_token=p_fence_token
  returning * into v_task;
  if not found then
    raise exception 'FENCING_REJECTED_AT_UPDATE: task % changed hands during failure', p_task_id;
  end if;
  return v_task;
end;
$function$;

-- 5. lumina_finish_task_fenced: make a repeated close idempotent.
--
-- SECOND DEFECT, also measured in the harness. The fenced closer guards the
-- holder but not the *state*: its UPDATE filters on `id AND fence_token AND
-- claimed_by` with no status predicate, and a completed task keeps its
-- `claimed_by` and its token. So calling it twice with the same valid token
-- overwrites `result` and `evidence` the second time, and a caller may even
-- flip a settled task from 'completed' to 'rejected' after the fact.
--
-- The audit trail does not reveal it: `lumina_log_task_event` only logs when
-- `status` actually changes, so a same-status overwrite is silent.
--
-- This matters because mesh delivery is at-least-once by contract: a lost ack
-- makes a second close a normal event, not an attack. A repeat must be a no-op.
--
-- Terminal statuses are the four that stamp `completed_at` in the original
-- body. 'input_required' and 'auth_required' are waiting states, so they stay
-- re-closable.
create or replace function public.lumina_finish_task_fenced(
  p_task_id uuid,
  p_agent text,
  p_fence_token integer,
  p_status text,
  p_result jsonb default null::jsonb,
  p_evidence jsonb default null::jsonb
) returns table(ok boolean, message text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_token int;
  v_owner text;
  v_status text;
begin
  if p_status not in ('completed','failed','cancelled','rejected','input_required','auth_required') then
    return query select false, 'INVALID_STATUS';
    return;
  end if;

  select fence_token, claimed_by, status into v_token, v_owner, v_status
    from public.lumina_tasks where id = p_task_id for update;

  if v_owner is null then
    return query select false, 'TASK_NOT_FOUND_OR_UNCLAIMED';
    return;
  end if;

  if v_token <> p_fence_token then
    return query select false,
      'FENCING_REJECTED: token ' || p_fence_token::text ||
      ' is stale, current fence token is ' || v_token::text;
    return;
  end if;

  if v_owner <> p_agent then
    return query select false, 'NOT_OWNER: task belongs to ' || v_owner;
    return;
  end if;

  -- Already settled: a repeat of the same outcome is a no-op, and a different
  -- outcome is refused rather than silently rewriting history.
  if v_status in ('completed','failed','cancelled','rejected') then
    if v_status = p_status then
      return query select true, 'TASK_ALREADY_' || upper(v_status);
    else
      return query select false,
        'ALREADY_SETTLED: task is ' || v_status || ', refusing ' || p_status;
    end if;
    return;
  end if;

  update public.lumina_tasks
     set status = p_status,
         result = coalesce(p_result, result),
         evidence = coalesce(p_evidence, evidence),
         completed_at = case when p_status in ('completed','failed','cancelled','rejected')
                              then now() else completed_at end,
         updated_at = now()
   where id = p_task_id and fence_token = p_fence_token and claimed_by = p_agent;

  if not found then
    return query select false, 'FENCING_REJECTED_AT_UPDATE';
    return;
  end if;

  return query select true, 'TASK_' || upper(p_status);
end;
$function$;

commit;

comment on function public.lumina_finish_task_fenced(uuid, text, integer, text, jsonb, jsonb) is
  'Closes a task under its fencing token, idempotently: a repeat of the same outcome is a no-op and a different outcome on a settled task is refused.';
comment on function public.lumina_finish_task(uuid, text, integer, jsonb, jsonb) is
  'Closes a task under its fencing token. A stale holder is refused even when the work was recovered.';
comment on function public.lumina_fail_task(uuid, text, integer, text, jsonb, jsonb, boolean) is
  'Fails a task under its fencing token. A retryable failure releases the claim, which advances the fence.';
comment on function public.lumina_start_task(uuid, text, integer, integer) is
  'Moves a claimed task to running under its fencing token.';
comment on function public.lumina_heartbeat_task(uuid, text, integer, integer) is
  'Renews a task lease under its fencing token, and records the token on the heartbeat event.';

-- ROLLBACK (run only to revert this migration)
--   begin;
--   drop function if exists public.lumina_start_task(uuid, text, integer, integer);
--   drop function if exists public.lumina_heartbeat_task(uuid, text, integer, integer);
--   drop function if exists public.lumina_finish_task(uuid, text, integer, jsonb, jsonb);
--   drop function if exists public.lumina_fail_task(uuid, text, integer, text, jsonb, jsonb, boolean);
--   -- then re-create the four captured pg_get_functiondef bodies verbatim
--   commit;
