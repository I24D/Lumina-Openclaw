-- schema.sql — the live Lumina_IA task-queue objects, replayed verbatim.
--
-- Pulled from the production project (zcleztlzatnnoishtpfk) on 2026-10-31 with
-- pg_get_functiondef and pg_attribute, so the behaviour under test is the real
-- behaviour and not a paraphrase of it. Nothing here runs against production.

create table public.lumina_agents (
  agent_key text not null primary key,
  display_name text not null,
  role text not null,
  provider text,
  execution_mode text not null default 'manual'::text,
  capabilities text[] not null default '{}'::text[],
  active boolean not null default true,
  poll_interval_seconds integer,
  metadata jsonb not null default '{}'::jsonb,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.lumina_tasks (
  id uuid not null default gen_random_uuid() primary key,
  created_by text not null,
  assigned_to text,
  intent text not null,
  payload jsonb not null default '{}'::jsonb,
  priority smallint not null default 50,
  status text not null default 'pending'::text,
  idempotency_key text,
  parent_task_id uuid,
  origin_memory_id uuid,
  decision_ref text,
  claimed_by text,
  claimed_at timestamptz,
  lease_until timestamptz,
  attempt_count integer not null default 0,
  max_attempts integer not null default 3,
  not_before timestamptz not null default now(),
  result jsonb,
  evidence jsonb not null default '[]'::jsonb,
  error text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  recovery_count integer not null default 0,
  fence_token integer not null default 0,
  validation_status text not null default 'unvalidated'::text
);

create table public.lumina_task_events (
  id bigint generated always as identity primary key,
  task_id uuid not null,
  event_type text not null,
  actor text,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- The monotonic fencing token: bumped whenever the holder changes.
CREATE OR REPLACE FUNCTION public.lumina_bump_fence()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    IF NEW.claimed_by IS DISTINCT FROM OLD.claimed_by THEN
        NEW.fence_token := OLD.fence_token + 1;
    END IF;
    RETURN NEW;
END;
$function$;

create trigger trg_lumina_tasks_fence
  before update on public.lumina_tasks
  for each row execute function public.lumina_bump_fence();

CREATE OR REPLACE FUNCTION public.lumina_log_task_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_actor text;
begin
  v_actor := coalesce(new.claimed_by, new.created_by, 'system');
  if tg_op = 'INSERT' then
    insert into public.lumina_task_events(task_id,event_type,actor,data)
    values(new.id,'created',new.created_by,jsonb_build_object(
      'status',new.status,'assigned_to',new.assigned_to,'priority',new.priority
    ));
  elsif old.status is distinct from new.status then
    insert into public.lumina_task_events(task_id,event_type,actor,data)
    values(new.id,'status_changed',v_actor,jsonb_build_object(
      'from',old.status,'to',new.status,'error',new.error
    ));
  end if;
  return new;
end;
$function$;

create trigger lumina_tasks_event_log
  after insert or update on public.lumina_tasks
  for each row execute function public.lumina_log_task_event();

CREATE OR REPLACE FUNCTION public.lumina_requeue_expired_tasks()
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_count integer;
begin
  update public.lumina_tasks
  set
    status = case when attempt_count < max_attempts then 'retry' else 'failed' end,
    error = case
      when attempt_count < max_attempts then coalesce(error,'lease expired; requeued')
      else coalesce(error,'lease expired; max attempts reached')
    end,
    claimed_by = null,
    claimed_at = null,
    lease_until = null,
    completed_at = case when attempt_count >= max_attempts then now() else completed_at end
  where status in ('claimed','running')
    and lease_until is not null
    and lease_until < now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

-- Stubbed: the real one rescues infrastructure failures by error pattern and is
-- not part of what these tests exercise. Kept so lumina_claim_task's PERFORM
-- resolves exactly as it does in production.
CREATE OR REPLACE FUNCTION public.lumina_recover_transient_failures()
 RETURNS integer
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$ select 0; $function$;

CREATE OR REPLACE FUNCTION public.lumina_claim_task(p_agent_key text, p_lease_seconds integer DEFAULT 900)
 RETURNS SETOF lumina_tasks
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if not exists (
    select 1 from public.lumina_agents
    where agent_key=p_agent_key and active=true
  ) then
    raise exception 'unknown or inactive agent: %', p_agent_key;
  end if;

  perform public.lumina_requeue_expired_tasks();
  perform public.lumina_recover_transient_failures();

  return query
  with candidate as (
    select id
    from public.lumina_tasks
    where assigned_to=p_agent_key
      and status in ('pending','retry')
      and not_before <= now()
      and attempt_count < max_attempts
    order by priority desc, created_at asc
    for update skip locked
    limit 1
  )
  update public.lumina_tasks t
  set status='claimed',
      claimed_by=p_agent_key,
      claimed_at=now(),
      lease_until=now() + make_interval(secs => greatest(60, least(p_lease_seconds, 3600))),
      attempt_count=t.attempt_count+1
  from candidate c
  where t.id=c.id
  returning t.*;
end;
$function$;

CREATE OR REPLACE FUNCTION public.lumina_fence_ok(p_task_id uuid, p_fence_token integer)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
    SELECT EXISTS (
        SELECT 1 FROM public.lumina_tasks
         WHERE id = p_task_id
           AND fence_token = p_fence_token
           AND claimed_by IS NOT NULL
    );
$function$;

CREATE OR REPLACE FUNCTION public.lumina_finish_task_fenced(p_task_id uuid, p_agent text, p_fence_token integer, p_status text, p_result jsonb DEFAULT NULL::jsonb, p_evidence jsonb DEFAULT NULL::jsonb)
 RETURNS TABLE(ok boolean, message text)
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
    v_token  int;
    v_owner  text;
BEGIN
    IF p_status NOT IN ('completed','failed','cancelled','rejected','input_required','auth_required') THEN
        RETURN QUERY SELECT false, 'INVALID_STATUS';
        RETURN;
    END IF;

    SELECT fence_token, claimed_by INTO v_token, v_owner
      FROM public.lumina_tasks WHERE id = p_task_id FOR UPDATE;

    IF v_owner IS NULL THEN
        RETURN QUERY SELECT false, 'TASK_NOT_FOUND_OR_UNCLAIMED';
        RETURN;
    END IF;

    IF v_token <> p_fence_token THEN
        RETURN QUERY SELECT false,
            'FENCING_REJECTED: token ' || p_fence_token::text ||
            ' is stale, current fence token is ' || v_token::text;
        RETURN;
    END IF;

    IF v_owner <> p_agent THEN
        RETURN QUERY SELECT false, 'NOT_OWNER: task belongs to ' || v_owner;
        RETURN;
    END IF;

    UPDATE public.lumina_tasks
       SET status = p_status,
           result = coalesce(p_result, result),
           evidence = coalesce(p_evidence, evidence),
           completed_at = CASE WHEN p_status IN ('completed','failed','cancelled','rejected')
                                THEN now() ELSE completed_at END,
           updated_at = now()
     WHERE id = p_task_id AND fence_token = p_fence_token AND claimed_by = p_agent;

    IF NOT FOUND THEN
        RETURN QUERY SELECT false, 'FENCING_REJECTED_AT_UPDATE';
        RETURN;
    END IF;

    RETURN QUERY SELECT true, 'TASK_' || upper(p_status);
END;
$function$;

-- The four UNFENCED closers. These are the defect under test.
CREATE OR REPLACE FUNCTION public.lumina_finish_task(p_task_id uuid, p_agent_key text, p_result jsonb DEFAULT '{}'::jsonb, p_evidence jsonb DEFAULT '[]'::jsonb)
 RETURNS lumina_tasks
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_task public.lumina_tasks;
begin
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
  returning * into v_task;
  if not found then
    raise exception 'task not owned by agent';
  end if;
  return v_task;
end;
$function$;

CREATE OR REPLACE FUNCTION public.lumina_fail_task(p_task_id uuid, p_agent_key text, p_error text, p_result jsonb DEFAULT NULL::jsonb, p_evidence jsonb DEFAULT '[]'::jsonb, p_retry boolean DEFAULT false)
 RETURNS lumina_tasks
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_task public.lumina_tasks;
begin
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
  returning * into v_task;
  if not found then
    raise exception 'task not owned by agent';
  end if;
  return v_task;
end;
$function$;

CREATE OR REPLACE FUNCTION public.lumina_start_task(p_task_id uuid, p_agent_key text, p_lease_seconds integer DEFAULT 900)
 RETURNS lumina_tasks
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_task public.lumina_tasks;
begin
  update public.lumina_tasks
  set status='running',
      lease_until=now() + make_interval(secs => greatest(60, least(p_lease_seconds, 3600)))
  where id=p_task_id
    and status='claimed'
    and claimed_by=p_agent_key
  returning * into v_task;
  if not found then
    raise exception 'task not claimed by agent';
  end if;
  return v_task;
end;
$function$;

CREATE OR REPLACE FUNCTION public.lumina_heartbeat_task(p_task_id uuid, p_agent_key text, p_lease_seconds integer DEFAULT 900)
 RETURNS lumina_tasks
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_task public.lumina_tasks;
begin
  update public.lumina_tasks
  set lease_until = now() + make_interval(secs => greatest(60, least(p_lease_seconds, 3600)))
  where id = p_task_id
    and status in ('claimed','running')
    and claimed_by = p_agent_key
  returning * into v_task;

  if not found then
    raise exception 'task not owned by agent';
  end if;

  insert into public.lumina_task_events(task_id,event_type,actor,data)
  values(
    p_task_id,
    'heartbeat',
    p_agent_key,
    jsonb_build_object('lease_until',v_task.lease_until)
  );

  return v_task;
end;
$function$;
