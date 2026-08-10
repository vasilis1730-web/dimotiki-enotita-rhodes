-- RODIOS Gate G behavioral assertions.
-- Safe migration-time tests: inserts synthetic rows, asserts behavior, then removes them.
begin;

do $$
declare
  v_token_ok text := public.generate_ack_token();
  v_token_expired text := public.generate_ack_token();
  v_work_ok text := '__gate_g_ack_ok_' || gen_random_uuid()::text;
  v_work_exp text := '__gate_g_ack_exp_' || gen_random_uuid()::text;
  v_order_ok text := '__GATE-G-ACK-OK__';
  v_order_exp text := '__GATE-G-ACK-EXP__';
  v_success boolean;
  v_order text;
  v_work text;
  v_ack_at timestamptz;
begin
  insert into public.work_order_acknowledgments(work_order_id,order_num,ack_token,created_at,expires_at)
  values
    (v_work_ok,v_order_ok,v_token_ok,now(),now()+interval '10 minutes'),
    (v_work_exp,v_order_exp,v_token_expired,now()-interval '1 hour',now()-interval '1 minute');

  select r.success,r.order_num,r.work_order_id,r.acknowledged_at
    into v_success,v_order,v_work,v_ack_at
  from public.complete_work_order_ack(v_token_ok) r;
  if v_success is distinct from true or v_order is distinct from v_order_ok or v_work is distinct from v_work_ok or v_ack_at is null then
    raise exception 'Gate G ACK assertion failed: first valid acknowledgment did not succeed';
  end if;

  select r.success into v_success from public.complete_work_order_ack(v_token_ok) r;
  if v_success is distinct from false then
    raise exception 'Gate G ACK assertion failed: replay was accepted';
  end if;

  select r.success into v_success from public.complete_work_order_ack(v_token_expired) r;
  if v_success is distinct from false then
    raise exception 'Gate G ACK assertion failed: expired token was accepted';
  end if;

  if exists (
    select 1 from public.work_order_acknowledgments
    where work_order_id=v_work_exp and acknowledged_at is not null
  ) then
    raise exception 'Gate G ACK assertion failed: expired row was mutated';
  end if;

  delete from public.work_order_acknowledgments where work_order_id in (v_work_ok,v_work_exp);
end $$;

commit;
