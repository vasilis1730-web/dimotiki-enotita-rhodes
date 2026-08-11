-- RODIOS Gate G: server-side citizen attachment abuse control
-- STAGING FIRST. This migration is designed to be idempotent.

create table if not exists public.rodios_citizen_upload_quota (
  identity_hash text not null,
  window_start timestamptz not null,
  upload_count integer not null default 0,
  bytes_total bigint not null default 0,
  updated_at timestamptz not null default now(),
  constraint rodios_citizen_upload_quota_pkey primary key (identity_hash, window_start),
  constraint rodios_citizen_upload_quota_identity_hash_chk check (identity_hash ~ '^[a-f0-9]{64}$'),
  constraint rodios_citizen_upload_quota_count_chk check (upload_count >= 0),
  constraint rodios_citizen_upload_quota_bytes_chk check (bytes_total >= 0)
);

alter table public.rodios_citizen_upload_quota enable row level security;

-- The table is an internal counter. Browser roles must never access it directly.
revoke all on table public.rodios_citizen_upload_quota from public, anon, authenticated;
grant select, insert, update, delete on table public.rodios_citizen_upload_quota to service_role;

create or replace function public.rodios_consume_citizen_upload_quota(
  p_identity_hash text,
  p_bytes bigint,
  p_max_count integer default 20,
  p_max_bytes bigint default 209715200 -- 200 MiB per rolling clock-hour bucket
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window timestamptz := date_trunc('hour', clock_timestamp());
  v_count integer;
  v_bytes bigint;
begin
  if p_identity_hash is null or p_identity_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid identity hash' using errcode = '22023';
  end if;
  if p_bytes is null or p_bytes <= 0 or p_bytes > 52428800 then
    raise exception 'invalid upload size' using errcode = '22023';
  end if;
  if p_max_count < 1 or p_max_count > 100 then
    raise exception 'invalid count limit' using errcode = '22023';
  end if;
  if p_max_bytes < 1048576 or p_max_bytes > 1073741824 then
    raise exception 'invalid byte limit' using errcode = '22023';
  end if;

  -- Keep only recent counters for this identity; bounded cleanup avoids global table scans.
  delete from public.rodios_citizen_upload_quota
   where identity_hash = p_identity_hash
     and window_start < v_window - interval '24 hours';

  insert into public.rodios_citizen_upload_quota(identity_hash, window_start, upload_count, bytes_total, updated_at)
  values (p_identity_hash, v_window, 1, p_bytes, clock_timestamp())
  on conflict (identity_hash, window_start) do update
     set upload_count = public.rodios_citizen_upload_quota.upload_count + 1,
         bytes_total = public.rodios_citizen_upload_quota.bytes_total + excluded.bytes_total,
         updated_at = clock_timestamp()
   where public.rodios_citizen_upload_quota.upload_count < p_max_count
     and public.rodios_citizen_upload_quota.bytes_total + excluded.bytes_total <= p_max_bytes
  returning upload_count, bytes_total into v_count, v_bytes;

  if not found then
    select q.upload_count, q.bytes_total
      into v_count, v_bytes
      from public.rodios_citizen_upload_quota q
     where q.identity_hash = p_identity_hash
       and q.window_start = v_window;

    return jsonb_build_object(
      'allowed', false,
      'count', coalesce(v_count, 0),
      'bytes', coalesce(v_bytes, 0),
      'maxCount', p_max_count,
      'maxBytes', p_max_bytes,
      'windowStart', v_window
    );
  end if;

  return jsonb_build_object(
    'allowed', true,
    'count', v_count,
    'bytes', v_bytes,
    'maxCount', p_max_count,
    'maxBytes', p_max_bytes,
    'windowStart', v_window
  );
end;
$$;

revoke all on function public.rodios_consume_citizen_upload_quota(text,bigint,integer,bigint) from public, anon, authenticated;
grant execute on function public.rodios_consume_citizen_upload_quota(text,bigint,integer,bigint) to service_role;

comment on table public.rodios_citizen_upload_quota is
  'Internal hourly citizen attachment quota counters. RLS enabled; no browser-role access.';
comment on function public.rodios_consume_citizen_upload_quota(text,bigint,integer,bigint) is
  'Atomically consumes verified-citizen upload quota. Service-role only.';

-- Migration assertions: fail deployment if the internal counter becomes browser-accessible.
do $$
begin
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname='rodios_citizen_upload_quota' and c.relrowsecurity
  ) then
    raise exception 'Gate G assertion failed: citizen upload quota table must have RLS enabled';
  end if;

  if has_table_privilege('anon', 'public.rodios_citizen_upload_quota', 'SELECT')
     or has_table_privilege('anon', 'public.rodios_citizen_upload_quota', 'INSERT')
     or has_table_privilege('anon', 'public.rodios_citizen_upload_quota', 'UPDATE')
     or has_table_privilege('authenticated', 'public.rodios_citizen_upload_quota', 'SELECT')
     or has_table_privilege('authenticated', 'public.rodios_citizen_upload_quota', 'INSERT')
     or has_table_privilege('authenticated', 'public.rodios_citizen_upload_quota', 'UPDATE') then
    raise exception 'Gate G assertion failed: browser roles can access citizen upload quota table';
  end if;

  if has_function_privilege('anon', 'public.rodios_consume_citizen_upload_quota(text,bigint,integer,bigint)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.rodios_consume_citizen_upload_quota(text,bigint,integer,bigint)', 'EXECUTE') then
    raise exception 'Gate G assertion failed: browser roles can execute upload quota function';
  end if;
end
$$;
