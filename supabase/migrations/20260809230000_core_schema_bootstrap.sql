-- RODIOS core schema bootstrap for Git-based Preview branches.
--
-- WHY THIS EXISTS:
-- The production database predates version-controlled Supabase migrations.
-- Git-based Preview branches therefore start without the existing RODIOS core tables.
-- This migration reconstructs ONLY the seven core tables audited read-only on 2026-08-09.
--
-- PRODUCTION SAFETY:
-- Every table/index uses IF NOT EXISTS. On the existing production database this is
-- intentionally a no-op for schema objects that already exist. No production rows
-- are inserted, updated, or deleted by this migration.

begin;

create table if not exists public.rodios_app_users (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz null
);

create table if not exists public.rodios_issues (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  issue_date text null,
  receipt text null,
  status text null,
  category text null,
  priority text null,
  title text null,
  location text null,
  phone text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz null
);

create table if not exists public.rodios_work_orders (
  id text primary key,
  issue_id text null,
  data jsonb not null default '{}'::jsonb,
  order_num text null,
  order_date text null,
  status text null,
  order_type text null,
  contractor_email text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz null
);

create table if not exists public.rodios_payments (
  id text primary key,
  work_order_id text null,
  data jsonb not null default '{}'::jsonb,
  payment_date text null,
  amount numeric null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz null
);

create table if not exists public.rodios_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.rodios_service_staff (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz null
);

create table if not exists public.rodios_sequences (
  kind text not null,
  year integer not null,
  next_value integer not null default 1,
  updated_at timestamptz not null default now(),
  primary key (kind, year)
);

-- Indexes captured by the read-only production audit.
create index if not exists idx_rodios_app_users_data_gin
  on public.rodios_app_users using gin (data);

create index if not exists idx_rodios_issues_category
  on public.rodios_issues (category);
create index if not exists idx_rodios_issues_data_gin
  on public.rodios_issues using gin (data);
create index if not exists idx_rodios_issues_date
  on public.rodios_issues (issue_date desc);
create index if not exists idx_rodios_issues_phone
  on public.rodios_issues (phone);
create index if not exists idx_rodios_issues_priority
  on public.rodios_issues (priority);
create index if not exists idx_rodios_issues_receipt
  on public.rodios_issues (receipt);
create index if not exists idx_rodios_issues_status
  on public.rodios_issues (status);
create index if not exists idx_rodios_issues_updated_at
  on public.rodios_issues (updated_at desc);

create index if not exists idx_rodios_work_orders_data_gin
  on public.rodios_work_orders using gin (data);
create index if not exists idx_rodios_work_orders_date
  on public.rodios_work_orders (order_date desc);
create index if not exists idx_rodios_work_orders_issue_id
  on public.rodios_work_orders (issue_id);
create index if not exists idx_rodios_work_orders_order_num
  on public.rodios_work_orders (order_num);
create index if not exists idx_rodios_work_orders_status
  on public.rodios_work_orders (status);
create index if not exists idx_rodios_work_orders_type
  on public.rodios_work_orders (order_type);
create index if not exists idx_rodios_work_orders_updated_at
  on public.rodios_work_orders (updated_at desc);

create index if not exists idx_rodios_payments_amount
  on public.rodios_payments (amount);
create index if not exists idx_rodios_payments_data_gin
  on public.rodios_payments using gin (data);
create index if not exists idx_rodios_payments_date
  on public.rodios_payments (payment_date desc);
create index if not exists idx_rodios_payments_updated_at
  on public.rodios_payments (updated_at desc);
create index if not exists idx_rodios_payments_work_order_id
  on public.rodios_payments (work_order_id);

create index if not exists idx_rodios_service_staff_data_gin
  on public.rodios_service_staff using gin (data);

create index if not exists idx_rodios_settings_value_gin
  on public.rodios_settings using gin (value);

-- Explicit browser-role grants required for RLS tests in a freshly created Preview.
-- Hardening migration that follows supplies the row-level restrictions.
grant select, insert, update, delete on table
  public.rodios_app_users,
  public.rodios_issues,
  public.rodios_work_orders,
  public.rodios_payments,
  public.rodios_settings,
  public.rodios_service_staff
  to authenticated;

commit;
