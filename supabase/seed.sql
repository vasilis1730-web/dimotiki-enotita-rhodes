-- RODIOS PREVIEW/STAGING SEED
-- Synthetic data only. Never copies production citizen data.
-- This file is intended for Supabase Preview branches and local testing.
-- It creates placeholder auth.users rows WITHOUT passwords. They cannot sign in;
-- their UUIDs are used only to exercise auth.uid()-based RLS in SQL.

begin;

-- ---------------------------------------------------------------------------
-- 1. Synthetic Auth identities (loginless placeholders for RLS tests)
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data)
values
  ('10000000-0000-4000-8000-000000000001'::uuid, 'rodios-admin-staging@rhodes.gr',   '{}'::jsonb),
  ('10000000-0000-4000-8000-000000000002'::uuid, 'rodios-manager-staging@rhodes.gr', '{}'::jsonb),
  ('10000000-0000-4000-8000-000000000003'::uuid, 'rodios-user-staging@rhodes.gr',    '{}'::jsonb),
  ('10000000-0000-4000-8000-000000000099'::uuid, 'rodios-orphan-staging@rhodes.gr',  '{}'::jsonb)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Application profiles. The orphan Auth UUID deliberately gets NO profile.
-- ---------------------------------------------------------------------------
insert into public.rodios_app_users(id, auth_user_id, data, deleted_at)
values
(
  'admin',
  '10000000-0000-4000-8000-000000000001'::uuid,
  jsonb_build_object('id','admin','name','STAGING Administrator','email','rodios-admin-staging@rhodes.gr','tier','admin','role','Administrator','username','stg_admin','canOrders',true),
  null
),
(
  'stg_manager',
  '10000000-0000-4000-8000-000000000002'::uuid,
  jsonb_build_object('id','stg_manager','name','STAGING Manager','email','rodios-manager-staging@rhodes.gr','tier','manager','role','Διαχειριστής','username','stg_manager','canOrders',true),
  null
),
(
  'stg_user',
  '10000000-0000-4000-8000-000000000003'::uuid,
  jsonb_build_object('id','stg_user','name','STAGING User','email','rodios-user-staging@rhodes.gr','tier','user','role','Χρήστης','username','stg_user','canOrders',true),
  null
)
on conflict (id) do update set
  auth_user_id=excluded.auth_user_id,
  data=excluded.data,
  deleted_at=null;

insert into public.rodios_settings(key, value)
values ('main', '{"staging":true}'::jsonb)
on conflict (key) do update set value=excluded.value;

insert into public.rodios_issues(id, data, issue_date, receipt, status, category, priority, title, location, phone, deleted_at)
values
(
  'stg_issue_001',
  jsonb_build_object('id','stg_issue_001','issueNum','ΑΙΤ-2026-001','source','staff','date','2026-08-09','receiptMethod','Τηλεφωνικά','status','Εκκρεμεί','category','Οδοποιία','priority','ΚΑΤ. 2 - ΕΠΕΙΓΟΝ','title','STAGING - δοκιμαστική λακκούβα','location','Δοκιμαστική θέση Ρόδου','citizenName','STAGING TEST','contactInfo','0000000000','description','Synthetic staging data'),
  '2026-08-09','Τηλεφωνικά','Εκκρεμεί','Οδοποιία','ΚΑΤ. 2 - ΕΠΕΙΓΟΝ','STAGING - δοκιμαστική λακκούβα','Δοκιμαστική θέση Ρόδου','0000000000',null
),
(
  'stg_issue_002',
  jsonb_build_object('id','stg_issue_002','issueNum','ΑΙΤ-2026-002','source','staff','date','2026-08-09','receiptMethod','Email','status','Σε εξέλιξη','category','Δημοτικός Φωτισμός','priority','ΚΑΤ. 3 - ΥΨΗΛΗ','title','STAGING - δοκιμαστικό φωτιστικό','location','Δοκιμαστική πλατεία','citizenName','STAGING TEST','contactInfo','staging@example.invalid','description','Synthetic staging data'),
  '2026-08-09','Email','Σε εξέλιξη','Δημοτικός Φωτισμός','ΚΑΤ. 3 - ΥΨΗΛΗ','STAGING - δοκιμαστικό φωτιστικό','Δοκιμαστική πλατεία',null,null
)
on conflict (id) do update set
  data=excluded.data, issue_date=excluded.issue_date, receipt=excluded.receipt,
  status=excluded.status, category=excluded.category, priority=excluded.priority,
  title=excluded.title, location=excluded.location, phone=excluded.phone, deleted_at=null;

insert into public.rodios_service_staff(id, data, deleted_at)
values ('stg_staff_001', jsonb_build_object('id','stg_staff_001','name','STAGING Συνεργείο','role','Δοκιμή','phone','0000000000'), null)
on conflict (id) do update set data=excluded.data, deleted_at=null;

insert into public.rodios_sequences(kind,year,next_value)
values ('issue',2026,3), ('order',2026,1)
on conflict (kind,year) do update set
  next_value=greatest(public.rodios_sequences.next_value,excluded.next_value),
  updated_at=now();

-- ---------------------------------------------------------------------------
-- 3. Gate A: RLS / authorization assertions
-- ---------------------------------------------------------------------------

-- ADMIN
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
do $$
declare v_role text; v_count integer;
begin
  select public.rodios_current_role() into v_role;
  if v_role <> 'admin' then raise exception 'GATE_A_FAIL: admin role resolved as %', v_role; end if;
  select count(*) into v_count from public.rodios_issues where id like 'stg_%';
  if v_count <> 2 then raise exception 'GATE_A_FAIL: admin cannot read operational rows'; end if;
end $$;

-- MANAGER: can read/update operational rows but cannot change settings or delete.
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',true);
do $$
declare v_role text; v_count integer;
begin
  select public.rodios_current_role() into v_role;
  if v_role <> 'manager' then raise exception 'GATE_A_FAIL: manager role resolved as %', v_role; end if;
  select count(*) into v_count from public.rodios_issues where id like 'stg_%';
  if v_count <> 2 then raise exception 'GATE_A_FAIL: manager cannot read operational rows'; end if;
end $$;
update public.rodios_issues
set data = jsonb_set(data,'{stagingManagerUpdate}','true'::jsonb,true)
where id='stg_issue_001';
update public.rodios_settings
set value = jsonb_set(value,'{managerMustNotWrite}','true'::jsonb,true)
where key='main';
do $$ begin
  begin
    delete from public.rodios_issues where id='stg_issue_002';
  exception when insufficient_privilege then
    null; -- stronger table-level denial is an acceptable/pass condition
  end;
end $$;

-- USER: can read/update operational rows, cannot change settings or delete.
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000003',true);
do $$
declare v_role text; v_count integer;
begin
  select public.rodios_current_role() into v_role;
  if v_role <> 'user' then raise exception 'GATE_A_FAIL: user role resolved as %', v_role; end if;
  select count(*) into v_count from public.rodios_issues where id like 'stg_%';
  if v_count <> 2 then raise exception 'GATE_A_FAIL: user cannot read operational rows'; end if;
end $$;
update public.rodios_issues
set data = jsonb_set(data,'{stagingUserUpdate}','true'::jsonb,true)
where id='stg_issue_001';
update public.rodios_settings
set value = jsonb_set(value,'{userMustNotWrite}','true'::jsonb,true)
where key='main';
do $$ begin
  begin
    delete from public.rodios_issues where id='stg_issue_002';
  exception when insufficient_privilege then
    null; -- stronger table-level denial is an acceptable/pass condition
  end;
end $$;

-- ORPHAN AUTH: valid Auth UUID, no application profile => sees zero protected rows.
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000099',true);
do $$
declare v_role text; v_count integer; denied boolean := false;
begin
  select public.rodios_current_role() into v_role;
  if v_role is not null then raise exception 'GATE_A_FAIL: orphan unexpectedly resolved role %', v_role; end if;
  select count(*) into v_count from public.rodios_issues;
  if v_count <> 0 then raise exception 'GATE_A_FAIL: orphan can read % issue rows', v_count; end if;
  begin
    perform public.rodios_next_sequence('issue',2027);
  exception when insufficient_privilege then
    denied := true;
  end;
  if not denied then raise exception 'GATE_A_FAIL: orphan could call sequence RPC'; end if;
end $$;

reset role;

-- Verify manager/user forbidden operations were truly denied.
do $$
declare v_count integer;
begin
  if (select value ? 'managerMustNotWrite' from public.rodios_settings where key='main') then
    raise exception 'GATE_A_FAIL: manager changed settings';
  end if;
  if (select value ? 'userMustNotWrite' from public.rodios_settings where key='main') then
    raise exception 'GATE_A_FAIL: user changed settings';
  end if;
  select count(*) into v_count from public.rodios_issues where id='stg_issue_002';
  if v_count <> 1 then raise exception 'GATE_A_FAIL: non-admin deleted issue'; end if;
  if has_function_privilege('anon','public.rodios_next_sequence(text,integer)','EXECUTE') then
    raise exception 'GATE_A_FAIL: anon still has sequence EXECUTE';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Gate B: sequence and relational integrity assertions
-- ---------------------------------------------------------------------------

-- Active users can call sequence RPC; use next year so canonical 2026 seed stays intact.
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
do $$ declare n integer; begin
  select public.rodios_next_sequence('issue',2027) into n;
  if n <> 1 then raise exception 'GATE_B_FAIL: expected first 2027 sequence=1, got %',n; end if;
end $$;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',true);
do $$ declare n integer; begin
  select public.rodios_next_sequence('issue',2027) into n;
  if n <> 2 then raise exception 'GATE_B_FAIL: expected second 2027 sequence=2, got %',n; end if;
end $$;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000003',true);
do $$ declare n integer; bad_kind_denied boolean := false; begin
  select public.rodios_next_sequence('issue',2027) into n;
  if n <> 3 then raise exception 'GATE_B_FAIL: expected third 2027 sequence=3, got %',n; end if;
  begin
    perform public.rodios_next_sequence('other',2026);
  exception when invalid_parameter_value then
    bad_kind_denied := true;
  end;
  if not bad_kind_denied then raise exception 'GATE_B_FAIL: invalid sequence kind accepted'; end if;
end $$;
reset role;

-- Duplicate canonical issue number must be rejected by DB uniqueness.
do $$ declare blocked boolean := false; begin
  begin
    insert into public.rodios_issues(id,data,deleted_at)
    values ('stg_duplicate_probe', jsonb_build_object('id','stg_duplicate_probe','issueNum','ΑΙΤ-2026-001'), null);
  exception when unique_violation then
    blocked := true;
  end;
  if not blocked then
    delete from public.rodios_issues where id='stg_duplicate_probe';
    raise exception 'GATE_B_FAIL: duplicate canonical issueNum was accepted';
  end if;
end $$;

-- FK: work order cannot reference a nonexistent issue.
do $$ declare blocked boolean := false; begin
  begin
    insert into public.rodios_work_orders(id,issue_id,data,deleted_at)
    values ('stg_fk_wo_probe','stg_missing_issue',jsonb_build_object('id','stg_fk_wo_probe'),null);
  exception when foreign_key_violation then
    blocked := true;
  end;
  if not blocked then
    delete from public.rodios_work_orders where id='stg_fk_wo_probe';
    raise exception 'GATE_B_FAIL: invalid work-order issue FK was accepted';
  end if;
end $$;

-- FK: payment cannot reference a nonexistent work order.
do $$ declare blocked boolean := false; begin
  begin
    insert into public.rodios_payments(id,work_order_id,data,deleted_at)
    values ('stg_fk_pay_probe','stg_missing_order',jsonb_build_object('id','stg_fk_pay_probe'),null);
  exception when foreign_key_violation then
    blocked := true;
  end;
  if not blocked then
    delete from public.rodios_payments where id='stg_fk_pay_probe';
    raise exception 'GATE_B_FAIL: invalid payment work-order FK was accepted';
  end if;
end $$;

-- Clean probe-only future sequence; keep useful 2026 synthetic state.
delete from public.rodios_sequences where year=2027;

-- ---------------------------------------------------------------------------
-- 5. Gate H.5: server-issued verification proof + atomic acceptance assertions
-- ---------------------------------------------------------------------------
reset role;

insert into public.rodios_issues(id,data,status,deleted_at)
values(
  'stg_accept_issue',
  jsonb_build_object('id','stg_accept_issue','issueNum','ΑΙΤ-2026-998','status','Σε εξέλιξη','title','STAGING acceptance proof issue'),
  'Σε εξέλιξη',null
);

insert into public.rodios_work_orders(id,issue_id,data,status,deleted_at)
values(
  'stg_accept_wo','stg_accept_issue',
  jsonb_build_object(
    'id','stg_accept_wo','orderNum','ΕΝΤ-2026-998','status','Σε εξέλιξη','orderType','contractor',
    'items',jsonb_build_array(jsonb_build_object('qty',2,'unitPrice',100)),
    'discountPct',10,'penaltyAmount',5
  ),
  'Σε εξέλιξη',null
);

insert into public.rodios_pdf_verification_proofs(
  id,order_ids,pdf_sha256,protocol_path,pdf_name,signature_count,verified_by,
  order_snapshot,verification_summary,verified_at,expires_at
)
select
  '20000000-0000-4000-8000-000000000001'::uuid,
  array['stg_accept_wo']::text[],
  repeat('a',64),
  'verified/staging-proof.pdf',
  'staging-proof.pdf',
  3,
  '10000000-0000-4000-8000-000000000001'::uuid,
  jsonb_build_object('stg_accept_wo',public.rodios_acceptance_snapshot(w.id,w.issue_id,w.data)),
  jsonb_build_object('verified',true,'source','seed-behavioral-proof','count',3,'signatureCount',3),
  now(),
  now() + interval '15 minutes'
from public.rodios_work_orders w where w.id='stg_accept_wo';

set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);

-- Direct browser-style transition to accepted must be denied even for an active admin.
do $$
declare blocked boolean:=false;
begin
  begin
    update public.rodios_work_orders
    set data=data||jsonb_build_object('status','Παραλήφθηκε')
    where id='stg_accept_wo';
  exception when insufficient_privilege then blocked:=true;
  end;
  if not blocked then raise exception 'GATE_H5_FAIL: direct accepted-state UPDATE was allowed'; end if;
end $$;

-- Exact proof + exact order set must atomically update order, linked issue and one payment.
do $$
declare r jsonb; amt numeric;
begin
  select public.rodios_finalize_verified_acceptance(
    '20000000-0000-4000-8000-000000000001'::uuid,
    array['stg_accept_wo']::text[]
  ) into r;
  if coalesce((r->>'ok')::boolean,false) is not true then raise exception 'GATE_H5_FAIL: RPC did not return ok'; end if;
  if (select status from public.rodios_work_orders where id='stg_accept_wo') <> 'Παραλήφθηκε' then raise exception 'GATE_H5_FAIL: work order not accepted'; end if;
  if (select status from public.rodios_issues where id='stg_accept_issue') <> 'Ολοκληρωμένο' then raise exception 'GATE_H5_FAIL: linked issue not completed'; end if;
  select case when coalesce(data->>'amount','') ~ '^-?[0-9]+([.][0-9]+)?$' then (data->>'amount')::numeric else -1 end into amt
  from public.rodios_payments where work_order_id='stg_accept_wo' and deleted_at is null and coalesce(data->>'isPenalty','false')<>'true';
  if amt <> 175 then raise exception 'GATE_H5_FAIL: expected atomic payment 175, got %',amt; end if;
end $$;

-- Replay must fail.
do $$
declare blocked boolean:=false;
begin
  begin
    perform public.rodios_finalize_verified_acceptance(
      '20000000-0000-4000-8000-000000000001'::uuid,
      array['stg_accept_wo']::text[]
    );
  exception when others then blocked:=true;
  end;
  if not blocked then raise exception 'GATE_H5_FAIL: proof replay was allowed'; end if;
end $$;

-- Accepted critical financial/protocol state is immutable from direct client UPDATE.
do $$
declare blocked_fin boolean:=false; blocked_protocol boolean:=false;
begin
  begin
    update public.rodios_work_orders
    set data=jsonb_set(data,'{penaltyAmount}','99'::jsonb,true)
    where id='stg_accept_wo';
  exception when insufficient_privilege then blocked_fin:=true;
  end;
  if not blocked_fin then raise exception 'GATE_H5_FAIL: accepted financial state was mutable'; end if;

  begin
    update public.rodios_work_orders
    set data=jsonb_set(data,'{signedPdfPath}',to_jsonb('tampered/path.pdf'::text),true)
    where id='stg_accept_wo';
  exception when insufficient_privilege then blocked_protocol:=true;
  end;
  if not blocked_protocol then raise exception 'GATE_H5_FAIL: accepted protocol state was mutable'; end if;
end $$;

reset role;

-- Owner-level inspection confirms the proof was consumed without granting clients table access.
do $$
declare used timestamptz;
begin
  select used_at into used from public.rodios_pdf_verification_proofs
  where id='20000000-0000-4000-8000-000000000001'::uuid;
  if used is null then raise exception 'GATE_H5_FAIL: proof was not consumed'; end if;
end $$;

-- Clean behavioral probe rows so the ordinary synthetic dataset remains small.
delete from public.rodios_payments where work_order_id='stg_accept_wo';
delete from public.rodios_pdf_verification_proofs where id='20000000-0000-4000-8000-000000000001'::uuid;
delete from public.rodios_work_orders where id='stg_accept_wo';
delete from public.rodios_issues where id='stg_accept_issue';

select 'STAGING_GATE_H5_VERIFIED_ACCEPTANCE_PASS' as result;

commit;

select 'STAGING_GATE_A_B_PASS' as result,
       (select count(*) from public.rodios_app_users where deleted_at is null) as active_profiles,
       (select count(*) from public.rodios_issues where id like 'stg_%') as synthetic_issues,
       (select next_value from public.rodios_sequences where kind='issue' and year=2026) as next_issue_2026;
