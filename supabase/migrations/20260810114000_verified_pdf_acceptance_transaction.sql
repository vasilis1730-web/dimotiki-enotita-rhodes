begin;

-- ---------------------------------------------------------------------------
-- Gate H.5 — server-issued PDF verification proofs + atomic acceptance.
-- The browser is never an authorization boundary for status='Παραλήφθηκε'.
-- ---------------------------------------------------------------------------

create table if not exists public.rodios_pdf_verification_proofs (
  id uuid primary key,
  order_ids text[] not null,
  pdf_sha256 text not null,
  protocol_path text not null,
  pdf_name text not null default '',
  signature_count integer not null,
  verified_by uuid not null references auth.users(id) on delete cascade,
  order_snapshot jsonb not null,
  verification_summary jsonb not null default '{}'::jsonb,
  verified_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  used_at timestamptz null,
  created_at timestamptz not null default now(),
  constraint rodios_pdf_proof_orders_nonempty check (cardinality(order_ids) between 1 and 100),
  constraint rodios_pdf_proof_sha256_format check (pdf_sha256 ~ '^[0-9a-f]{64}$'),
  constraint rodios_pdf_proof_signature_count check (signature_count between 1 and 20),
  constraint rodios_pdf_proof_expiry check (expires_at > verified_at)
);

alter table public.rodios_pdf_verification_proofs enable row level security;
revoke all on table public.rodios_pdf_verification_proofs from public, anon, authenticated;
grant select, insert, update, delete on table public.rodios_pdf_verification_proofs to service_role;

create index if not exists rodios_pdf_verification_proofs_expiry_idx
  on public.rodios_pdf_verification_proofs(expires_at)
  where used_at is null;
create index if not exists rodios_pdf_verification_proofs_user_idx
  on public.rodios_pdf_verification_proofs(verified_by, created_at desc);

-- Canonical subset of work-order state that must not change between verification
-- and acceptance. Verification/UI-only fields are intentionally excluded.
create or replace function public.rodios_acceptance_snapshot(
  p_id text,
  p_issue_id text,
  p_data jsonb
)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_id,
    'issueId', p_issue_id,
    'items', case when jsonb_typeof(p_data->'items')='array' then p_data->'items' else '[]'::jsonb end,
    'discountPct', coalesce(p_data->'discountPct', 'null'::jsonb),
    'penaltyAmount', coalesce(p_data->'penaltyAmount', '0'::jsonb),
    'orderNum', coalesce(p_data->'orderNum', to_jsonb(''::text)),
    'orderType', coalesce(p_data->'orderType', to_jsonb(''::text))
  );
$$;
revoke all on function public.rodios_acceptance_snapshot(text,text,jsonb) from public, anon, authenticated;
grant execute on function public.rodios_acceptance_snapshot(text,text,jsonb) to service_role;

-- Safe numeric conversion for server-side payment calculation.
create or replace function public.rodios_jsonb_numeric(p_value jsonb, p_default numeric default 0)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_text text;
begin
  if p_value is null or p_value = 'null'::jsonb then return p_default; end if;
  if jsonb_typeof(p_value) = 'number' then return (p_value::text)::numeric; end if;
  if jsonb_typeof(p_value) = 'string' then
    v_text := trim(both '"' from p_value::text);
    if v_text ~ '^-?[0-9]+([.][0-9]+)?$' then return v_text::numeric; end if;
  end if;
  return p_default;
exception when others then
  return p_default;
end;
$$;
revoke all on function public.rodios_jsonb_numeric(jsonb,numeric) from public, anon, authenticated;

-- Block any direct INSERT/UPDATE that attempts to enter the accepted state.
-- Only rodios_finalize_verified_acceptance() sets the transaction-local capability.
create or replace function public.rodios_guard_verified_acceptance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_authorized text := current_setting('rodios.verified_acceptance', true);
  v_new_accepted boolean := (new.status = 'Παραλήφθηκε' or coalesce(new.data->>'status','') = 'Παραλήφθηκε');
  v_old_accepted boolean := false;
begin
  if tg_op = 'UPDATE' then
    v_old_accepted := (old.status = 'Παραλήφθηκε' or coalesce(old.data->>'status','') = 'Παραλήφθηκε');
  end if;

  if v_new_accepted and not v_old_accepted and v_authorized <> 'on' then
    raise exception using errcode='42501', message='Verified acceptance must use rodios_finalize_verified_acceptance';
  end if;
  return new;
end;
$$;
revoke all on function public.rodios_guard_verified_acceptance() from public, anon, authenticated;

drop trigger if exists trg_rodios_verified_acceptance_guard on public.rodios_work_orders;
create trigger trg_rodios_verified_acceptance_guard
before insert or update on public.rodios_work_orders
for each row execute function public.rodios_guard_verified_acceptance();

create or replace function public.rodios_finalize_verified_acceptance(
  p_proof_id uuid,
  p_expected_order_ids text[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_profile jsonb;
  v_proof public.rodios_pdf_verification_proofs%rowtype;
  v_expected text[];
  v_required integer := 3;
  v_wo public.rodios_work_orders%rowtype;
  v_snapshot jsonb;
  v_list_total numeric;
  v_discount numeric;
  v_penalty numeric;
  v_net numeric;
  v_payment_id text;
  v_today text := to_char(current_date,'YYYY-MM-DD');
  v_month text := to_char(current_date,'YYYY-MM');
  v_orders jsonb := '[]'::jsonb;
  v_issues jsonb := '[]'::jsonb;
  v_payments jsonb := '[]'::jsonb;
  v_issue_data jsonb;
  v_payment_data jsonb;
  v_order_data jsonb;
  v_required_from_settings integer;
begin
  if v_uid is null then
    raise exception using errcode='42501', message='Authenticated user required';
  end if;

  select au.data into v_profile
  from public.rodios_app_users au
  where au.auth_user_id=v_uid and au.deleted_at is null
  limit 1;
  if v_profile is null then
    raise exception using errcode='42501', message='Active application profile required';
  end if;
  if coalesce(v_profile->'canOrders','true'::jsonb) = 'false'::jsonb then
    raise exception using errcode='42501', message='Work-order permission required';
  end if;

  if p_proof_id is null or p_expected_order_ids is null or cardinality(p_expected_order_ids)=0 then
    raise exception using errcode='22023', message='Verification proof and order IDs are required';
  end if;
  select array_agg(distinct x order by x) into v_expected from unnest(p_expected_order_ids) x where nullif(trim(x),'') is not null;
  if v_expected is null or cardinality(v_expected)<>cardinality(p_expected_order_ids) then
    raise exception using errcode='22023', message='Order IDs must be unique and non-empty';
  end if;

  select * into v_proof
  from public.rodios_pdf_verification_proofs p
  where p.id=p_proof_id
  for update;
  if not found then raise exception using errcode='22023', message='Verification proof not found'; end if;
  if v_proof.used_at is not null then raise exception using errcode='22023', message='Verification proof already used'; end if;
  if v_proof.expires_at <= now() then raise exception using errcode='22023', message='Verification proof expired'; end if;
  if v_proof.verified_by <> v_uid then raise exception using errcode='42501', message='Verification proof belongs to another user'; end if;
  if v_proof.order_ids <> v_expected then raise exception using errcode='22023', message='Verification proof does not match selected orders'; end if;

  select count(*)::integer into v_required_from_settings
  from public.rodios_settings s,
       lateral jsonb_array_elements(case when jsonb_typeof(s.value->'eSignUsers')='array' then s.value->'eSignUsers' else '[]'::jsonb end) e
  where s.key='main' and nullif(trim(coalesce(e->>'name','')),'') is not null;
  if coalesce(v_required_from_settings,0)>0 then v_required:=v_required_from_settings; end if;
  if v_proof.signature_count < v_required then
    raise exception using errcode='22023', message='Verification proof has insufficient signatures';
  end if;

  -- Lock every target work order and validate that critical state has not changed
  -- since the server cryptographically verified the PDF.
  foreach v_payment_id in array v_expected loop
    select * into v_wo from public.rodios_work_orders w
    where w.id=v_payment_id and w.deleted_at is null
    for update;
    if not found then raise exception using errcode='22023', message='Work order not found'; end if;
    if v_wo.status='Παραλήφθηκε' or coalesce(v_wo.data->>'status','')='Παραλήφθηκε' then
      raise exception using errcode='22023', message='Work order is already accepted';
    end if;
    v_snapshot:=public.rodios_acceptance_snapshot(v_wo.id,v_wo.issue_id,v_wo.data);
    if not (v_proof.order_snapshot ? v_wo.id) or v_proof.order_snapshot->v_wo.id <> v_snapshot then
      raise exception using errcode='40001', message='Work order changed after PDF verification; verify again';
    end if;
  end loop;

  perform set_config('rodios.verified_acceptance','on',true);

  foreach v_payment_id in array v_expected loop
    select * into v_wo from public.rodios_work_orders w where w.id=v_payment_id for update;

    v_order_data := v_wo.data || jsonb_build_object(
      'status','Παραλήφθηκε',
      'completionDate',v_today,
      '_protocolReady',true,
      'signedPdfBucket','protocols',
      'signedPdfPath',v_proof.protocol_path,
      'signedPdfName',v_proof.pdf_name,
      'signedAt',v_proof.verified_at,
      '_isBulkProtocol',(cardinality(v_expected)>1),
      'verificationProofId',v_proof.id::text,
      'pdfSha256',v_proof.pdf_sha256,
      '_edgeResult',v_proof.verification_summary || jsonb_build_object(
        'verified',true,'count',v_proof.signature_count,'signatureCount',v_proof.signature_count,
        'verificationProofId',v_proof.id::text,'pdfSha256',v_proof.pdf_sha256
      )
    );

    update public.rodios_work_orders
    set data=v_order_data, status='Παραλήφθηκε', updated_at=now()
    where id=v_wo.id;
    v_orders := v_orders || jsonb_build_array(v_order_data);

    if v_wo.issue_id is not null then
      update public.rodios_issues i
      set data=i.data || jsonb_build_object('status','Ολοκληρωμένο','completionDate',v_today),
          status='Ολοκληρωμένο', updated_at=now()
      where i.id=v_wo.issue_id and i.deleted_at is null
      returning data into v_issue_data;
      if found then v_issues:=v_issues||jsonb_build_array(v_issue_data); end if;
    end if;

    if not exists(
      select 1 from public.rodios_payments p
      where p.work_order_id=v_wo.id and p.deleted_at is null
        and coalesce(p.data->>'isPenalty','false') <> 'true'
    ) then
      select coalesce(sum(
        public.rodios_jsonb_numeric(item->'qty',0) * public.rodios_jsonb_numeric(item->'unitPrice',0)
      ),0) into v_list_total
      from jsonb_array_elements(case when jsonb_typeof(v_wo.data->'items')='array' then v_wo.data->'items' else '[]'::jsonb end) item;
      v_discount:=public.rodios_jsonb_numeric(v_wo.data->'discountPct',0);
      v_penalty:=public.rodios_jsonb_numeric(v_wo.data->'penaltyAmount',0);
      v_net:=greatest(0,round((v_list_total-(v_list_total*v_discount/100))-v_penalty,2));
      v_payment_id:=extensions.gen_random_uuid()::text;
      v_payment_data:=jsonb_build_object(
        'id',v_payment_id,'date',v_today,'amount',v_net,'orderId',v_wo.id,
        'invoiceNum','','month',v_month,
        'notes','Παραλαβή εντολής '||coalesce(v_wo.data->>'orderNum',v_wo.id)||' — επαληθευμένο ψηφιακό πρωτόκολλο',
        'isPenalty',false,'autoCreated',true
      );
      insert into public.rodios_payments(id,work_order_id,data,created_at,updated_at,deleted_at)
      values(v_payment_id,v_wo.id,v_payment_data,now(),now(),null);
      v_payments:=v_payments||jsonb_build_array(v_payment_data);
    end if;
  end loop;

  update public.rodios_pdf_verification_proofs set used_at=now() where id=v_proof.id;

  return jsonb_build_object(
    'ok',true,
    'proofId',v_proof.id::text,
    'pdfSha256',v_proof.pdf_sha256,
    'orderIds',to_jsonb(v_expected),
    'orders',v_orders,
    'issues',v_issues,
    'payments',v_payments
  );
end;
$$;

revoke all on function public.rodios_finalize_verified_acceptance(uuid,text[]) from public, anon;
grant execute on function public.rodios_finalize_verified_acceptance(uuid,text[]) to authenticated, service_role;

commit;
