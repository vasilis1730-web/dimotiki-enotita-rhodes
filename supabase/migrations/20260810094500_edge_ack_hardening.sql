-- RODIOS Gate G hardening — STAGING FIRST
-- Edge-function rate limiting + public ACK capability hardening.
begin;

create table if not exists public.rodios_edge_rate_limits (
  scope text not null,
  actor_key text not null,
  window_start timestamptz not null,
  request_count integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (scope, actor_key, window_start),
  constraint rodios_edge_rate_limits_count_check check (request_count >= 0)
);
alter table public.rodios_edge_rate_limits enable row level security;
revoke all on table public.rodios_edge_rate_limits from public, anon, authenticated;

create or replace function public.rodios_consume_edge_quota(p_scope text,p_actor_key text,p_limit integer)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_window timestamptz:=date_trunc('hour',now()); v_count integer;
begin
  if p_scope is null or length(trim(p_scope))<1 or length(p_scope)>120 then raise exception 'invalid rate-limit scope' using errcode='22023'; end if;
  if p_actor_key is null or length(trim(p_actor_key))<1 or length(p_actor_key)>256 then raise exception 'invalid rate-limit actor' using errcode='22023'; end if;
  if p_limit<1 or p_limit>10000 then raise exception 'invalid rate-limit limit' using errcode='22023'; end if;
  insert into public.rodios_edge_rate_limits(scope,actor_key,window_start,request_count,updated_at)
  values(trim(p_scope),trim(p_actor_key),v_window,1,now())
  on conflict(scope,actor_key,window_start) do update set request_count=public.rodios_edge_rate_limits.request_count+1,updated_at=now()
  returning request_count into v_count;
  if random()<0.02 then delete from public.rodios_edge_rate_limits where window_start<now()-interval '48 hours'; end if;
  return v_count<=p_limit;
end $$;
revoke all on function public.rodios_consume_edge_quota(text,text,integer) from public,anon,authenticated;
grant execute on function public.rodios_consume_edge_quota(text,text,integer) to service_role;

create table if not exists public.work_order_acknowledgments (
  id uuid primary key default gen_random_uuid(),
  work_order_id text not null,
  order_num text not null,
  ack_token text not null unique,
  acknowledged_at timestamptz,
  acknowledged_by_ip text,
  manual_ack boolean default false,
  manual_ack_by text,
  notification_sent boolean default false,
  created_at timestamptz default now(),
  expires_at timestamptz
);
alter table public.work_order_acknowledgments add column if not exists expires_at timestamptz;
alter table public.work_order_acknowledgments alter column expires_at set default (now()+interval '30 days');
update public.work_order_acknowledgments
set expires_at=case when acknowledged_at is not null then coalesce(created_at,acknowledged_at,now())+interval '30 days'
 else greatest(coalesce(created_at,now())+interval '30 days',now()+interval '7 days') end
where expires_at is null;
alter table public.work_order_acknowledgments alter column expires_at set not null;
create index if not exists idx_ack_work_order_id on public.work_order_acknowledgments(work_order_id);
create index if not exists idx_ack_expires_at on public.work_order_acknowledgments(expires_at);
alter table public.work_order_acknowledgments enable row level security;

drop policy if exists "Authenticated users can insert acknowledgments" on public.work_order_acknowledgments;
drop policy if exists "Authenticated users can read all acknowledgments" on public.work_order_acknowledgments;
drop policy if exists ack_update_auth on public.work_order_acknowledgments;
drop policy if exists ack_select_active on public.work_order_acknowledgments;
drop policy if exists ack_insert_active on public.work_order_acknowledgments;
drop policy if exists ack_update_active on public.work_order_acknowledgments;
create policy ack_select_active on public.work_order_acknowledgments for select to authenticated using(public.rodios_is_active_user());
create policy ack_insert_active on public.work_order_acknowledgments for insert to authenticated with check(public.rodios_is_active_user());
create policy ack_update_active on public.work_order_acknowledgments for update to authenticated using(public.rodios_is_active_user()) with check(public.rodios_is_active_user());
revoke all on table public.work_order_acknowledgments from anon;
revoke all on table public.work_order_acknowledgments from authenticated;
grant select,insert,update on table public.work_order_acknowledgments to authenticated;

create or replace function public.generate_ack_token()
returns text language sql volatile security definer set search_path='' as $$
  select translate(encode(gen_random_bytes(24),'base64'),E'+/=\n\r','-_')
$$;
revoke all on function public.generate_ack_token() from public,anon,authenticated;
grant execute on function public.generate_ack_token() to service_role;

create or replace function public.complete_work_order_ack(p_token text)
returns table(success boolean,order_num text,work_order_id text,acknowledged_at timestamptz)
language plpgsql security definer set search_path='' as $$
declare v_row public.work_order_acknowledgments%rowtype;
begin
  if p_token is null or length(p_token)<32 or length(p_token)>128 or p_token!~'^[A-Za-z0-9_-]+$' then
    return query select false,null::text,null::text,null::timestamptz; return;
  end if;
  update public.work_order_acknowledgments
  set acknowledged_at=now(),acknowledged_by_ip=null,manual_ack=false,manual_ack_by='contractor'
  where ack_token=p_token and acknowledged_at is null and expires_at>now()
  returning * into v_row;
  if not found then return query select false,null::text,null::text,null::timestamptz; return; end if;
  return query select true,v_row.order_num,v_row.work_order_id,v_row.acknowledged_at;
end $$;
revoke all on function public.complete_work_order_ack(text) from public;
grant execute on function public.complete_work_order_ack(text) to anon,authenticated,service_role;

create or replace function public.acknowledge_work_order(p_token text,p_ip text)
returns table(success boolean,message text,order_num text,work_order_id text,acknowledged_at timestamptz)
language plpgsql security definer set search_path='' as $$
declare v_row public.work_order_acknowledgments%rowtype;
begin
  if p_token is null or length(p_token)<32 or length(p_token)>128 or p_token!~'^[A-Za-z0-9_-]+$' then
    return query select false,'invalid_or_expired'::text,null::text,null::text,null::timestamptz; return;
  end if;
  update public.work_order_acknowledgments
  set acknowledged_at=now(),acknowledged_by_ip=left(coalesce(p_ip,''),128),manual_ack=false,manual_ack_by=null
  where ack_token=p_token and acknowledged_at is null and expires_at>now()
  returning * into v_row;
  if not found then return query select false,'invalid_or_expired'::text,null::text,null::text,null::timestamptz; return; end if;
  return query select true,'acknowledged'::text,v_row.order_num,v_row.work_order_id,v_row.acknowledged_at;
end $$;
revoke all on function public.acknowledge_work_order(text,text) from public,anon,authenticated;
grant execute on function public.acknowledge_work_order(text,text) to service_role;

commit;

select 'ack_unexpired_unacknowledged' as check_name,count(*)::bigint as value from public.work_order_acknowledgments where acknowledged_at is null and expires_at>now()
union all select 'ack_missing_expiry',count(*)::bigint from public.work_order_acknowledgments where expires_at is null;
