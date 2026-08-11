-- Gate H.7 regression fix: real browser rows keep the authoritative status in JSONB
-- and may leave the legacy/denormalized status column NULL. PostgreSQL three-valued
-- boolean logic must never turn the acceptance guard into NULL/unknown.

begin;

create or replace function public.rodios_guard_verified_acceptance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_authorized text := coalesce(current_setting('rodios.verified_acceptance', true),'');
  v_new_accepted boolean := (
    coalesce(new.status,'') = 'Παραλήφθηκε'
    or coalesce(new.data->>'status','') = 'Παραλήφθηκε'
  );
  v_old_accepted boolean := false;
  v_old_protocol jsonb;
  v_new_protocol jsonb;
begin
  if tg_op = 'UPDATE' then
    v_old_accepted := (
      coalesce(old.status,'') = 'Παραλήφθηκε'
      or coalesce(old.data->>'status','') = 'Παραλήφθηκε'
    );
  end if;

  if v_authorized <> 'on' then
    if v_new_accepted and not v_old_accepted then
      raise exception using errcode='42501', message='Verified acceptance must use rodios_finalize_verified_acceptance';
    end if;
    if v_old_accepted and not v_new_accepted then
      raise exception using errcode='42501', message='Accepted work order status is server-controlled';
    end if;
    if tg_op='UPDATE' and v_old_accepted and v_new_accepted then
      if public.rodios_acceptance_snapshot(old.id,old.issue_id,old.data)
         is distinct from public.rodios_acceptance_snapshot(new.id,new.issue_id,new.data) then
        raise exception using errcode='42501', message='Accepted work order financial/source fields are immutable';
      end if;
      v_old_protocol:=jsonb_build_object(
        'completionDate',old.data->'completionDate','_protocolReady',old.data->'_protocolReady',
        'signedPdfBucket',old.data->'signedPdfBucket','signedPdfPath',old.data->'signedPdfPath',
        'signedPdfName',old.data->'signedPdfName','signedAt',old.data->'signedAt',
        'verificationProofId',old.data->'verificationProofId','pdfSha256',old.data->'pdfSha256',
        '_edgeResult',old.data->'_edgeResult'
      );
      v_new_protocol:=jsonb_build_object(
        'completionDate',new.data->'completionDate','_protocolReady',new.data->'_protocolReady',
        'signedPdfBucket',new.data->'signedPdfBucket','signedPdfPath',new.data->'signedPdfPath',
        'signedPdfName',new.data->'signedPdfName','signedAt',new.data->'signedAt',
        'verificationProofId',new.data->'verificationProofId','pdfSha256',new.data->'pdfSha256',
        '_edgeResult',new.data->'_edgeResult'
      );
      if v_old_protocol is distinct from v_new_protocol then
        raise exception using errcode='42501', message='Accepted work order protocol fields are immutable';
      end if;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.rodios_guard_verified_acceptance() from public, anon, authenticated;

commit;
