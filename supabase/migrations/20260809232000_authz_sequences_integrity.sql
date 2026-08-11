-- RODIOS production hardening - STAGING ONLY until fully validated
-- Scope: SEC-01 / SEQ-01 / DB-01 foundations
-- Date: 2026-08-09
--
-- IMPORTANT:
--   1. Apply first to an isolated Supabase staging/preview branch.
--   2. Do NOT run directly on production before the staging test matrix passes.
--   3. This migration does NOT change Storage bucket visibility yet.
--
-- Expected current production facts from read-only audit:
--   - 4 active rodios_app_users profiles, all matched to Supabase Auth accounts.
--   - issue:2026 max used = 85 while rodios_sequences.next_value = 1.
--   - 0 work orders, 0 payments.

begin;

-- ---------------------------------------------------------------------------
-- 1. Bind application profiles to immutable Supabase Auth UUIDs.
-- ---------------------------------------------------------------------------
alter table public.rodios_app_users
  add column if not exists auth_user_id uuid;

update public.rodios_app_users p
set auth_user_id = u.id
from auth.users u
where p.auth_user_id is null
  and p.deleted_at is null
  and nullif(trim(p.data->>'email'), '') is not null
  and lower(trim(p.data->>'email')) = lower(trim(u.email));

-- Abort rather than silently locking out an existing active profile.
do $$
begin
  if exists (
    select 1
    from public.rodios_app_users
    where deleted_at is null
      and auth_user_id is null
  ) then
    raise exception 'RODIOS hardening aborted: at least one active app profile has no matching auth.users UUID';
  end if;
end
$$;

create unique index if not exists uq_rodios_app_users_auth_user_id_active
  on public.rodios_app_users(auth_user_id)
  where auth_user_id is not null and deleted_at is null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'rodios_app_users_auth_user_id_fkey'
      and conrelid = 'public.rodios_app_users'::regclass
  ) then
    alter table public.rodios_app_users
      add constraint rodios_app_users_auth_user_id_fkey
      foreign key (auth_user_id)
      references auth.users(id)
      on delete set null;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. Server-side authorization helpers.
--    SECURITY DEFINER avoids recursive RLS when policies protect app_users.
--    Search path and schema references are fixed deliberately.
-- ---------------------------------------------------------------------------
create or replace function public.rodios_current_role()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when p.id = 'admin' or lower(coalesce(p.data->>'tier','')) = 'admin' then 'admin'
    when lower(coalesce(p.data->>'tier','')) = 'manager' then 'manager'
    else 'user'
  end
  from public.rodios_app_users p
  where p.auth_user_id = auth.uid()
    and p.deleted_at is null
  limit 1
$$;

create or replace function public.rodios_is_active_user()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.rodios_current_role() is not null
$$;

create or replace function public.rodios_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.rodios_current_role() = 'admin'
$$;

revoke all on function public.rodios_current_role() from public, anon;
revoke all on function public.rodios_is_active_user() from public, anon;
revoke all on function public.rodios_is_admin() from public, anon;
grant execute on function public.rodios_current_role() to authenticated, service_role;
grant execute on function public.rodios_is_active_user() to authenticated, service_role;
grant execute on function public.rodios_is_admin() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Replace permissive operational RLS with active-profile authorization.
-- ---------------------------------------------------------------------------
alter table public.rodios_app_users enable row level security;
alter table public.rodios_issues enable row level security;
alter table public.rodios_work_orders enable row level security;
alter table public.rodios_payments enable row level security;
alter table public.rodios_service_staff enable row level security;
alter table public.rodios_settings enable row level security;

-- app users
drop policy if exists appusers_delete_admin on public.rodios_app_users;
drop policy if exists appusers_insert_admin on public.rodios_app_users;
drop policy if exists appusers_select on public.rodios_app_users;
drop policy if exists appusers_update_admin on public.rodios_app_users;
create policy appusers_select_active on public.rodios_app_users
  for select to authenticated
  using (public.rodios_is_active_user());
create policy appusers_insert_admin_v2 on public.rodios_app_users
  for insert to authenticated
  with check (public.rodios_is_admin());
create policy appusers_update_admin_v2 on public.rodios_app_users
  for update to authenticated
  using (public.rodios_is_admin())
  with check (public.rodios_is_admin());
create policy appusers_delete_admin_v2 on public.rodios_app_users
  for delete to authenticated
  using (public.rodios_is_admin());

-- issues
drop policy if exists issues_delete_admin on public.rodios_issues;
drop policy if exists issues_insert on public.rodios_issues;
drop policy if exists issues_select on public.rodios_issues;
drop policy if exists issues_update on public.rodios_issues;
create policy issues_select_active on public.rodios_issues
  for select to authenticated using (public.rodios_is_active_user());
create policy issues_insert_active on public.rodios_issues
  for insert to authenticated with check (public.rodios_is_active_user());
create policy issues_update_active on public.rodios_issues
  for update to authenticated
  using (public.rodios_is_active_user())
  with check (public.rodios_is_active_user());
create policy issues_delete_admin_v2 on public.rodios_issues
  for delete to authenticated using (public.rodios_is_admin());

-- work orders
drop policy if exists workorders_delete_admin on public.rodios_work_orders;
drop policy if exists workorders_insert on public.rodios_work_orders;
drop policy if exists workorders_select on public.rodios_work_orders;
drop policy if exists workorders_update on public.rodios_work_orders;
create policy workorders_select_active on public.rodios_work_orders
  for select to authenticated using (public.rodios_is_active_user());
create policy workorders_insert_active on public.rodios_work_orders
  for insert to authenticated with check (public.rodios_is_active_user());
create policy workorders_update_active on public.rodios_work_orders
  for update to authenticated
  using (public.rodios_is_active_user())
  with check (public.rodios_is_active_user());
create policy workorders_delete_admin_v2 on public.rodios_work_orders
  for delete to authenticated using (public.rodios_is_admin());

-- payments
drop policy if exists payments_delete_admin on public.rodios_payments;
drop policy if exists payments_insert on public.rodios_payments;
drop policy if exists payments_select on public.rodios_payments;
drop policy if exists payments_update on public.rodios_payments;
create policy payments_select_active on public.rodios_payments
  for select to authenticated using (public.rodios_is_active_user());
create policy payments_insert_active on public.rodios_payments
  for insert to authenticated with check (public.rodios_is_active_user());
create policy payments_update_active on public.rodios_payments
  for update to authenticated
  using (public.rodios_is_active_user())
  with check (public.rodios_is_active_user());
create policy payments_delete_admin_v2 on public.rodios_payments
  for delete to authenticated using (public.rodios_is_admin());

-- service staff
drop policy if exists svcstaff_delete_admin on public.rodios_service_staff;
drop policy if exists svcstaff_insert on public.rodios_service_staff;
drop policy if exists svcstaff_select on public.rodios_service_staff;
drop policy if exists svcstaff_update on public.rodios_service_staff;
create policy svcstaff_select_active on public.rodios_service_staff
  for select to authenticated using (public.rodios_is_active_user());
create policy svcstaff_insert_active on public.rodios_service_staff
  for insert to authenticated with check (public.rodios_is_active_user());
create policy svcstaff_update_active on public.rodios_service_staff
  for update to authenticated
  using (public.rodios_is_active_user())
  with check (public.rodios_is_active_user());
create policy svcstaff_delete_admin_v2 on public.rodios_service_staff
  for delete to authenticated using (public.rodios_is_admin());

-- settings: administrator only for writes, active users may read.
drop policy if exists settings_delete_admin on public.rodios_settings;
drop policy if exists settings_insert_admin on public.rodios_settings;
drop policy if exists settings_select on public.rodios_settings;
drop policy if exists settings_update_admin on public.rodios_settings;
create policy settings_select_active on public.rodios_settings
  for select to authenticated using (public.rodios_is_active_user());
create policy settings_insert_admin_v2 on public.rodios_settings
  for insert to authenticated with check (public.rodios_is_admin());
create policy settings_update_admin_v2 on public.rodios_settings
  for update to authenticated
  using (public.rodios_is_admin())
  with check (public.rodios_is_admin());
create policy settings_delete_admin_v2 on public.rodios_settings
  for delete to authenticated using (public.rodios_is_admin());

-- rodios_attachments table may exist even though it was not part of the seven-table
-- core audit output. Harden its existing policies when present.
do $$
begin
  if to_regclass('public.rodios_attachments') is not null then
    execute 'drop policy if exists attachments_delete_admin on public.rodios_attachments';
    execute 'drop policy if exists attachments_insert on public.rodios_attachments';
    execute 'drop policy if exists attachments_select on public.rodios_attachments';
    execute 'drop policy if exists attachments_update on public.rodios_attachments';
    execute 'create policy attachments_select_active on public.rodios_attachments for select to authenticated using (public.rodios_is_active_user())';
    execute 'create policy attachments_insert_active on public.rodios_attachments for insert to authenticated with check (public.rodios_is_active_user())';
    execute 'create policy attachments_update_active on public.rodios_attachments for update to authenticated using (public.rodios_is_active_user()) with check (public.rodios_is_active_user())';
    execute 'create policy attachments_delete_admin_v2 on public.rodios_attachments for delete to authenticated using (public.rodios_is_admin())';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 4. Atomic sequence: reseed from existing canonical numbers BEFORE use.
-- ---------------------------------------------------------------------------
insert into public.rodios_sequences(kind, year, next_value)
select
  'issue',
  split_part(s.num, '-', 2)::int,
  max(split_part(s.num, '-', 3)::int) + 1
from (
  select data->>'issueNum' as num
  from public.rodios_issues
  where deleted_at is null
    and data->>'issueNum' ~ '^ΑΙΤ-[0-9]{4}-[0-9]+$'
) s
group by split_part(s.num, '-', 2)::int
on conflict (kind, year) do update
set next_value = greatest(public.rodios_sequences.next_value, excluded.next_value),
    updated_at = now();

insert into public.rodios_sequences(kind, year, next_value)
select
  'order',
  split_part(s.num, '-', 2)::int,
  max(split_part(s.num, '-', 3)::int) + 1
from (
  select data->>'orderNum' as num
  from public.rodios_work_orders
  where deleted_at is null
    and data->>'orderNum' ~ '^ΕΕ-[0-9]{4}-[0-9]+$'
) s
group by split_part(s.num, '-', 2)::int
on conflict (kind, year) do update
set next_value = greatest(public.rodios_sequences.next_value, excluded.next_value),
    updated_at = now();

-- Database-level duplicate protection for canonical numbers.
create unique index if not exists uq_rodios_issues_issue_num_active
  on public.rodios_issues ((data->>'issueNum'))
  where deleted_at is null
    and data->>'issueNum' ~ '^ΑΙΤ-[0-9]{4}-[0-9]+$';

create unique index if not exists uq_rodios_work_orders_order_num_active
  on public.rodios_work_orders ((data->>'orderNum'))
  where deleted_at is null
    and data->>'orderNum' ~ '^ΕΕ-[0-9]{4}-[0-9]+$';

-- Sequences are RPC-only, never directly writable by browser roles.
alter table public.rodios_sequences enable row level security;
revoke all on table public.rodios_sequences from anon, authenticated;

-- Basic sequence-domain integrity.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'rodios_sequences_kind_check'
      and conrelid = 'public.rodios_sequences'::regclass
  ) then
    alter table public.rodios_sequences
      add constraint rodios_sequences_kind_check
      check (kind in ('issue','order'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'rodios_sequences_next_value_check'
      and conrelid = 'public.rodios_sequences'::regclass
  ) then
    alter table public.rodios_sequences
      add constraint rodios_sequences_next_value_check
      check (next_value >= 1);
  end if;
end
$$;

create or replace function public.rodios_next_sequence(p_kind text, p_year integer)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_next integer;
  v_role text;
begin
  if p_kind not in ('issue','order') then
    raise exception 'Invalid sequence kind' using errcode = '22023';
  end if;

  if p_year < 2020 or p_year > extract(year from current_date)::int + 1 then
    raise exception 'Invalid sequence year' using errcode = '22023';
  end if;

  v_role := auth.role();
  if coalesce(v_role,'') <> 'service_role' and not public.rodios_is_active_user() then
    raise exception 'RODIOS active application user required' using errcode = '42501';
  end if;

  insert into public.rodios_sequences(kind, year, next_value)
  values (p_kind, p_year, 2)
  on conflict (kind, year)
  do update set
    next_value = public.rodios_sequences.next_value + 1,
    updated_at = now()
  returning public.rodios_sequences.next_value - 1 into v_next;

  return v_next;
end;
$$;

revoke all on function public.rodios_next_sequence(text, integer) from public, anon;
grant execute on function public.rodios_next_sequence(text, integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Relational integrity foundations. Safe now because audit found zero rows
--    in work_orders and payments; still written idempotently for future use.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'rodios_work_orders_issue_id_fkey'
      and conrelid = 'public.rodios_work_orders'::regclass
  ) then
    alter table public.rodios_work_orders
      add constraint rodios_work_orders_issue_id_fkey
      foreign key (issue_id)
      references public.rodios_issues(id)
      on update cascade
      on delete restrict;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'rodios_payments_work_order_id_fkey'
      and conrelid = 'public.rodios_payments'::regclass
  ) then
    alter table public.rodios_payments
      add constraint rodios_payments_work_order_id_fkey
      foreign key (work_order_id)
      references public.rodios_work_orders(id)
      on update cascade
      on delete restrict;
  end if;
end
$$;

commit;

-- POST-MIGRATION READ-ONLY CHECKS (results only)
select id, auth_user_id, data->>'email' as email, data->>'tier' as tier
from public.rodios_app_users
where deleted_at is null
order by id;

select kind, year, next_value, updated_at
from public.rodios_sequences
order by year desc, kind;
