-- lumina_mesh_finish_idempotent.sql — make a repeated fenced close a no-op.
--
-- STATUS: PROPOSED. NOT APPLIED. This replaces a function in the shared
-- Lumina_IA project (zcleztlzatnnoishtpfk), which is a red action under Dal's
-- order: it needs his explicit approval. The core LUMINA has reviewed it and
-- recommends it ("1B: sí"); the full hardening in
-- lumina_mesh_fence_hardening.sql ("1A") is deliberately NOT in this file.
--
-- ## Why this one on its own
--
-- 1A removes the four unfenced closing paths, which breaks every caller that
-- does not pass a token — the Python bus library
-- (~/.openclaw/workspace/lumina-cognitive-bus/lumina_bus.py) is the other live
-- caller and has to be updated in the same window. That is a coordinated
-- change and deserves its own.
--
-- This file changes no signature, breaks no caller, and closes the defect that
-- fires in ordinary operation. Mesh delivery is at-least-once by contract, so a
-- lost acknowledgement makes a second close a normal event, not an attack.
--
-- ## The defect, from the live definition
--
-- Captured with pg_get_functiondef on 2026-11-01, there is exactly one
-- lumina_finish_task_fenced, signature (uuid, text, integer, text, jsonb,
-- jsonb). Its UPDATE filters on `id AND fence_token AND claimed_by` and has no
-- status predicate. Closing does not change `fence_token` — the trigger
-- trg_lumina_tasks_fence bumps it when `claimed_by` changes — and a settled
-- task keeps its `claimed_by`. So the same holder calling twice with the same
-- valid token passes every guard the second time, and:
--
--   * `result` and `evidence` are overwritten by the repeat's payload;
--   * `status` is replaced, so a task already 'completed' can be flipped to
--     'rejected' after the fact;
--   * `completed_at` and `updated_at` are restamped.
--
-- None of it shows in the audit trail, because lumina_log_task_event only
-- writes when `status` actually changes: a same-status overwrite is silent.
--
-- ## What this changes, and what it deliberately does not
--
-- Added: one guard, before the UPDATE, for a task already in a terminal state.
-- The same outcome returns ok with TASK_ALREADY_<STATUS>, so an honest retry
-- succeeds and stays a no-op. A different outcome is refused with
-- ALREADY_SETTLED rather than silently rewriting history.
--
-- Terminal means the four statuses the original body stamps `completed_at`
-- for. 'input_required' and 'auth_required' are waiting states and stay
-- re-closable, which is what they are for.
--
-- NOT changed, on purpose: the signature, the argument defaults, the language,
-- `SET search_path TO 'public'`, the return shape, every existing error string,
-- and the privilege model. In particular this does NOT add SECURITY DEFINER.
-- The live function does not have it, the earlier draft of the full hardening
-- did, and adding it here would change who the body runs as — a privilege
-- change has no business riding along in a fix for idempotency.
--
-- ## Before applying, and how to undo it
--
-- Before: run sql/m2-fencing.mjs, which replays the live definitions into an
-- embedded PostgreSQL and exercises both defects and both fixes. Run it on the
-- day of the change, not on the day it was written, so the proof is about what
-- is actually deployed. Then re-capture pg_get_functiondef and confirm it still
-- matches what the comments above describe.
--
-- After: confirm exactly one function of this name remains. `create or replace`
-- with a different argument list creates an OVERLOAD rather than replacing, and
-- `drop function if exists` is a silent no-op when the argument list does not
-- match — so the count is the only honest check.
--
--   select p.oid::regprocedure::text
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'lumina_finish_task_fenced';
--
-- Rollback: re-run the ROLLBACK block at the end of this file. It is the
-- definition captured from production on 2026-11-01, verbatim, so undoing this
-- restores exactly what was there — including the defect.

begin;

create or replace function public.lumina_finish_task_fenced(
  p_task_id uuid,
  p_agent text,
  p_fence_token integer,
  p_status text,
  p_result jsonb default null::jsonb,
  p_evidence jsonb default null::jsonb
) returns table(ok boolean, message text)
language plpgsql
set search_path to 'public'
as $function$
declare
    v_token  int;
    v_owner  text;
    v_status text;
begin
    if p_status not in ('completed','failed','cancelled','rejected','input_required','auth_required') then
        return query select false, 'INVALID_STATUS';
        return;
    end if;

    -- Reads `status` as well as the holder, which the original did not need.
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

    -- THE FIX. Everything above is the original, unchanged.
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

comment on function public.lumina_finish_task_fenced(uuid, text, integer, text, jsonb, jsonb) is
  'Closes a task under its fencing token, idempotently: a repeat of the same outcome is a no-op, and a different outcome on a settled task is refused.';

commit;

-- ============================================================================
-- ROLLBACK — the definition captured from production on 2026-11-01, verbatim.
-- Running this restores the previous behaviour, defect included.
-- ============================================================================
--
-- CREATE OR REPLACE FUNCTION public.lumina_finish_task_fenced(p_task_id uuid, p_agent text, p_fence_token integer, p_status text, p_result jsonb DEFAULT NULL::jsonb, p_evidence jsonb DEFAULT NULL::jsonb)
--  RETURNS TABLE(ok boolean, message text)
--  LANGUAGE plpgsql
--  SET search_path TO 'public'
-- AS $function$
-- DECLARE
--     v_token  int;
--     v_owner  text;
-- BEGIN
--     IF p_status NOT IN ('completed','failed','cancelled','rejected','input_required','auth_required') THEN
--         RETURN QUERY SELECT false, 'INVALID_STATUS';
--         RETURN;
--     END IF;
--
--     SELECT fence_token, claimed_by INTO v_token, v_owner
--       FROM public.lumina_tasks WHERE id = p_task_id FOR UPDATE;
--
--     IF v_owner IS NULL THEN
--         RETURN QUERY SELECT false, 'TASK_NOT_FOUND_OR_UNCLAIMED';
--         RETURN;
--     END IF;
--
--     IF v_token <> p_fence_token THEN
--         RETURN QUERY SELECT false,
--             'FENCING_REJECTED: token ' || p_fence_token::text ||
--             ' is stale, current fence token is ' || v_token::text;
--         RETURN;
--     END IF;
--
--     IF v_owner <> p_agent THEN
--         RETURN QUERY SELECT false, 'NOT_OWNER: task belongs to ' || v_owner;
--         RETURN;
--     END IF;
--
--     UPDATE public.lumina_tasks
--        SET status = p_status,
--            result = coalesce(p_result, result),
--            evidence = coalesce(p_evidence, evidence),
--            completed_at = CASE WHEN p_status IN ('completed','failed','cancelled','rejected')
--                                 THEN now() ELSE completed_at END,
--            updated_at = now()
--      WHERE id = p_task_id AND fence_token = p_fence_token AND claimed_by = p_agent;
--
--     IF NOT FOUND THEN
--         RETURN QUERY SELECT false, 'FENCING_REJECTED_AT_UPDATE';
--         RETURN;
--     END IF;
--
--     RETURN QUERY SELECT true, 'TASK_' || upper(p_status);
-- END;
-- $function$
