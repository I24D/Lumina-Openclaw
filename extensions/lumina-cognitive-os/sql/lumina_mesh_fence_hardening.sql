-- lumina_mesh_fence_hardening.sql — close the unfenced task-closing paths.
--
-- STATUS: PROPOSED. NOT APPLIED. This file changes functions in the shared
-- Lumina_IA project (zcleztlzatnnoishtpfk), which is a red action under the
-- order of 2026-10-31: it needs Dal's explicit approval and the repository's
-- database review checkpoint (docs/reference/database-schemas/storage-changes.md).
-- Apply through the Supabase MCP connector's apply_migration, which is how this
-- project runs DDL. Until then the TypeScript adapter in
-- src/mesh/task-recovery.ts refuses to call the unfenced paths at all, which
-- mitigates the defect without touching production.
--
-- ## The defect, concretely
--
-- `lumina_tasks.fence_token` is a real monotonic fencing token: the trigger
-- `trg_lumina_tasks_fence` -> `lumina_bump_fence()` increments it whenever
-- `claimed_by` changes, and `lumina_finish_task_fenced` refuses a stale holder
-- with FENCING_REJECTED. That part works.
--
-- But four sibling functions close or advance a task WITHOUT a fence token:
--
--   lumina_finish_task(p_task_id, p_agent_key, ...)
--   lumina_fail_task(p_task_id, p_agent_key, ...)
--   lumina_start_task(p_task_id, p_agent_key)
--   lumina_heartbeat_task(p_task_id, p_agent_key)
--
-- Each one admits the caller on `status in ('claimed','running') AND
-- claimed_by = p_agent_key`. The owner is the *agent key*, which every attempt
-- by that agent shares. Lumina runs one agent key per agent, so the predicate
-- cannot tell two attempts apart:
--
--   1. openclaw-gateway claims task T        -> fence_token = 1
--   2. the gateway hangs; the lease expires
--   3. lumina_requeue_expired_tasks() clears claimed_by -> fence_token = 2
--   4. the same agent claims T again          -> fence_token = 3
--   5. the ORIGINAL worker wakes up and calls lumina_finish_task(T, 'openclaw-gateway', 'completed')
--
-- At step 5 the predicate holds, so the stale worker marks T completed over the
-- live attempt. `lumina_finish_task_fenced` would have rejected it. This is the
-- "un titular obsoleto debe recibir rechazo aun si el trabajo se recupera"
-- requirement of the order, and today it is only half true.
--
-- ## What this migration does
--
-- Adds a REQUIRED p_fence_token to all four, with the same two-stage holder
-- check `lumina_finish_task_fenced` already uses: reject before the write, and
-- repeat the predicate in the UPDATE so a concurrent bump between the SELECT
-- and the UPDATE is caught as well.
--
-- Backwards compatibility: the old 5- and 6-argument signatures are DROPPED, not
-- kept as overloads. An unfenced path left reachable is the defect. Nothing in
-- this repository calls them (verified: zero references to lumina_finish_task,
-- lumina_fail_task, lumina_start_task or lumina_heartbeat_task across src/,
-- extensions/, ui/ and scripts/), so the only caller to migrate is the Python
-- library at ~/.openclaw/workspace/lumina-cognitive-bus/lumina_bus.py.
--
-- ROLLBACK: restore the previous definitions from the project's migration
-- history (list_migrations) and re-create the dropped signatures. Capture
-- `pg_get_functiondef` for all four before applying.

begin;

-- 1. lumina_start_task: a stale holder must not move a live attempt to running.
drop function if exists public.lumina_start_task(uuid, text);

create or replace function public.lumina_start_task(
  p_task_id uuid,
  p_agent_key text,
  p_fence_token integer
) returns public.lumina_tasks
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.lumina_tasks;
begin
  select * into v_task from public.lumina_tasks where id = p_task_id for update;
  if not found then
    raise exception 'UNKNOWN_TASK: %', p_task_id;
  end if;
  if v_task.claimed_by is distinct from p_agent_key then
    raise exception 'NOT_OWNER: task % is held by %, not %',
      p_task_id, coalesce(v_task.claimed_by, '<nobody>'), p_agent_key;
  end if;
  if v_task.fence_token <> p_fence_token then
    raise exception 'FENCING_REJECTED: token % is stale, current fence token is %',
      p_fence_token, v_task.fence_token;
  end if;

  update public.lumina_tasks
     set status = 'running',
         updated_at = now()
   where id = p_task_id
     and fence_token = p_fence_token
     and claimed_by = p_agent_key
  returning * into v_task;

  if not found then
    raise exception 'FENCING_REJECTED_AT_UPDATE: task % changed hands during start', p_task_id;
  end if;
  return v_task;
end;
$$;

-- 2. lumina_heartbeat_task: renewing a lease is a write, so it needs the fence.
drop function if exists public.lumina_heartbeat_task(uuid, text);

create or replace function public.lumina_heartbeat_task(
  p_task_id uuid,
  p_agent_key text,
  p_fence_token integer,
  p_lease_seconds integer default 300
) returns public.lumina_tasks
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.lumina_tasks;
  v_lease integer := least(greatest(coalesce(p_lease_seconds, 300), 60), 3600);
begin
  select * into v_task from public.lumina_tasks where id = p_task_id for update;
  if not found then
    raise exception 'UNKNOWN_TASK: %', p_task_id;
  end if;
  if v_task.claimed_by is distinct from p_agent_key then
    raise exception 'NOT_OWNER: task % is held by %, not %',
      p_task_id, coalesce(v_task.claimed_by, '<nobody>'), p_agent_key;
  end if;
  if v_task.fence_token <> p_fence_token then
    raise exception 'FENCING_REJECTED: token % is stale, current fence token is %',
      p_fence_token, v_task.fence_token;
  end if;

  update public.lumina_tasks
     set lease_until = now() + make_interval(secs => v_lease),
         updated_at = now()
   where id = p_task_id
     and fence_token = p_fence_token
     and claimed_by = p_agent_key
  returning * into v_task;

  if not found then
    raise exception 'FENCING_REJECTED_AT_UPDATE: task % changed hands during heartbeat', p_task_id;
  end if;
  return v_task;
end;
$$;

-- 3. lumina_finish_task: the path that caused the defect. It now delegates to
--    the fenced implementation, so there is ONE closing rule, not two.
drop function if exists public.lumina_finish_task(uuid, text, text, jsonb, jsonb);

create or replace function public.lumina_finish_task(
  p_task_id uuid,
  p_agent text,
  p_fence_token integer,
  p_status text default 'completed',
  p_result jsonb default '{}'::jsonb,
  p_evidence jsonb default '{}'::jsonb
) returns public.lumina_tasks
language sql
security definer
set search_path = ''
as $$
  select public.lumina_finish_task_fenced(
    p_task_id, p_agent, p_fence_token, p_status, p_result, p_evidence
  );
$$;

-- 4. lumina_fail_task: same rule, and it keeps its own retry decision.
drop function if exists public.lumina_fail_task(uuid, text, text, jsonb, jsonb, boolean);

create or replace function public.lumina_fail_task(
  p_task_id uuid,
  p_agent_key text,
  p_fence_token integer,
  p_error text,
  p_result jsonb default '{}'::jsonb,
  p_evidence jsonb default '{}'::jsonb,
  p_retryable boolean default true
) returns public.lumina_tasks
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.lumina_tasks;
begin
  select * into v_task from public.lumina_tasks where id = p_task_id for update;
  if not found then
    raise exception 'UNKNOWN_TASK: %', p_task_id;
  end if;
  if v_task.claimed_by is distinct from p_agent_key then
    raise exception 'NOT_OWNER: task % is held by %, not %',
      p_task_id, coalesce(v_task.claimed_by, '<nobody>'), p_agent_key;
  end if;
  if v_task.fence_token <> p_fence_token then
    raise exception 'FENCING_REJECTED: token % is stale, current fence token is %',
      p_fence_token, v_task.fence_token;
  end if;

  update public.lumina_tasks
     set status = case when p_retryable then 'retry' else 'failed' end,
         -- A retry releases the claim so the lease and the fence advance; a
         -- terminal failure keeps the holder on the row for the audit trail.
         claimed_by = case when p_retryable then null else v_task.claimed_by end,
         lease_until = case when p_retryable then null else v_task.lease_until end,
         last_error = p_error,
         result = p_result,
         evidence = v_task.evidence || p_evidence,
         updated_at = now()
   where id = p_task_id
     and fence_token = p_fence_token
     and claimed_by = p_agent_key
  returning * into v_task;

  if not found then
    raise exception 'FENCING_REJECTED_AT_UPDATE: task % changed hands during failure', p_task_id;
  end if;
  return v_task;
end;
$$;

commit;

comment on function public.lumina_finish_task(uuid, text, integer, text, jsonb, jsonb) is
  'Closes a task under its fencing token. Delegates to lumina_finish_task_fenced so there is one closing rule.';
comment on function public.lumina_fail_task(uuid, text, integer, text, jsonb, jsonb, boolean) is
  'Fails a task under its fencing token. A retryable failure releases the claim, which advances the fence.';
comment on function public.lumina_start_task(uuid, text, integer) is
  'Moves a claimed task to running under its fencing token.';
comment on function public.lumina_heartbeat_task(uuid, text, integer, integer) is
  'Renews a task lease under its fencing token.';
