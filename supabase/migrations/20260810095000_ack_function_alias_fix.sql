-- Gate G: disambiguate PL/pgSQL output parameters from acknowledgment table columns.
begin;

create or replace function public.complete_work_order_ack(p_token text)
returns table(success boolean,order_num text,work_order_id text,acknowledged_at timestamptz)
language plpgsql security definer set search_path='' as $$
declare v_row public.work_order_acknowledgments%rowtype;
begin
  if p_token is null or length(p_token)<32 or length(p_token)>128 or p_token!~'^[A-Za-z0-9_-]+$' then
    return query select false,null::text,null::text,null::timestamptz; return;
  end if;
  update public.work_order_acknowledgments as a
  set acknowledged_at=now(),acknowledged_by_ip=null,manual_ack=false,manual_ack_by='contractor'
  where a.ack_token=p_token and a.acknowledged_at is null and a.expires_at>now()
  returning a.* into v_row;
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
  update public.work_order_acknowledgments as a
  set acknowledged_at=now(),acknowledged_by_ip=left(coalesce(p_ip,''),128),manual_ack=false,manual_ack_by=null
  where a.ack_token=p_token and a.acknowledged_at is null and a.expires_at>now()
  returning a.* into v_row;
  if not found then return query select false,'invalid_or_expired'::text,null::text,null::text,null::timestamptz; return; end if;
  return query select true,'acknowledged'::text,v_row.order_num,v_row.work_order_id,v_row.acknowledged_at;
end $$;
revoke all on function public.acknowledge_work_order(text,text) from public,anon,authenticated;
grant execute on function public.acknowledge_work_order(text,text) to service_role;

commit;
