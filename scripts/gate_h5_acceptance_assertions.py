from pathlib import Path

mig=Path('supabase/migrations/20260810114000_verified_pdf_acceptance_transaction.sql')
ms=mig.read_text(encoding='utf-8')
old="""  update public.rodios_pdf_verification_proofs set used_at=now() where id=v_proof.id;

  return jsonb_build_object("""
new="""  update public.rodios_pdf_verification_proofs set used_at=now() where id=v_proof.id;
  -- Do not leave the transaction-local trigger capability enabled after the trusted writes.
  perform set_config('rodios.verified_acceptance','',true);

  return jsonb_build_object("""
if ms.count(old)!=1: raise SystemExit(f'migration capability marker count={ms.count(old)}')
ms=ms.replace(old,new,1)
if "perform set_config('rodios.verified_acceptance','',true);" not in ms: raise SystemExit('capability reset missing')
mig.write_text(ms,encoding='utf-8')

seed=Path('supabase/seed.sql')
s=seed.read_text(encoding='utf-8')
if 'STAGING_GATE_H5_VERIFIED_ACCEPTANCE_PASS' in s: raise SystemExit('Gate H5 assertions already present')
marker="""-- Clean probe-only future sequence; keep useful 2026 synthetic state.
delete from public.rodios_sequences where year=2027;

commit;
"""
if s.count(marker)!=1: raise SystemExit(f'seed insertion marker count={s.count(marker)}')
block=r'''-- Clean probe-only future sequence; keep useful 2026 synthetic state.
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
  jsonb_build_object('verified',true,'source','seed-behavioral-proof','count',3,'signatureCount',3)
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
declare r jsonb; amt numeric; used timestamptz;
begin
  select public.rodios_finalize_verified_acceptance(
    '20000000-0000-4000-8000-000000000001'::uuid,
    array['stg_accept_wo']::text[]
  ) into r;
  if coalesce((r->>'ok')::boolean,false) is not true then raise exception 'GATE_H5_FAIL: RPC did not return ok'; end if;
  if (select status from public.rodios_work_orders where id='stg_accept_wo') <> 'Παραλήφθηκε' then raise exception 'GATE_H5_FAIL: work order not accepted'; end if;
  if (select status from public.rodios_issues where id='stg_accept_issue') <> 'Ολοκληρωμένο' then raise exception 'GATE_H5_FAIL: linked issue not completed'; end if;
  select public.rodios_jsonb_numeric(data->'amount',-1) into amt
  from public.rodios_payments where work_order_id='stg_accept_wo' and deleted_at is null and coalesce(data->>'isPenalty','false')<>'true';
  if amt <> 175 then raise exception 'GATE_H5_FAIL: expected atomic payment 175, got %',amt; end if;
  select used_at into used from public.rodios_pdf_verification_proofs where id='20000000-0000-4000-8000-000000000001'::uuid;
  if used is null then raise exception 'GATE_H5_FAIL: proof was not consumed'; end if;
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

-- Clean behavioral probe rows so the ordinary synthetic dataset remains small.
delete from public.rodios_payments where work_order_id='stg_accept_wo';
delete from public.rodios_pdf_verification_proofs where id='20000000-0000-4000-8000-000000000001'::uuid;
delete from public.rodios_work_orders where id='stg_accept_wo';
delete from public.rodios_issues where id='stg_accept_issue';

select 'STAGING_GATE_H5_VERIFIED_ACCEPTANCE_PASS' as result;

commit;
'''
s=s.replace(marker,block,1)
if 'GATE_H5_FAIL' not in s or 'STAGING_GATE_H5_VERIFIED_ACCEPTANCE_PASS' not in s: raise SystemExit('seed Gate H5 invariants missing')
seed.write_text(s,encoding='utf-8')
print('Gate H5 migration reset + seed behavioral assertions applied')
