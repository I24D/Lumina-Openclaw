-- External checkpoints of Lumina's local safety audit chain (M3GAN spec sections 24 and 48).
-- Apply once to Lumina's Supabase project (through the Supabase MCP connector's apply_migration,
-- which is how this project runs DDL). Append-only: a trigger rejects updates and deletes, so a
-- local tamperer cannot rewrite the record of where the chain was.
create table if not exists public.m3gan_audit_checkpoints (
  id bigint generated always as identity primary key,
  host text not null,
  seq integer not null check (seq >= 0),
  head_hash text not null check (head_hash ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz not null default now()
);

create index if not exists m3gan_audit_checkpoints_host_seq
  on public.m3gan_audit_checkpoints (host, seq desc);

create or replace function public.m3gan_audit_checkpoints_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'm3gan_audit_checkpoints is append-only';
end;
$$;

drop trigger if exists m3gan_audit_checkpoints_no_rewrite on public.m3gan_audit_checkpoints;
create trigger m3gan_audit_checkpoints_no_rewrite
  before update or delete on public.m3gan_audit_checkpoints
  for each row execute function public.m3gan_audit_checkpoints_append_only();

alter table public.m3gan_audit_checkpoints enable row level security;

comment on table public.m3gan_audit_checkpoints is
  'Append-only head hashes of the M3GAN safety audit chain, kept outside the gateway so tail deletion is detectable.';
