-- RODIOS disposable rollback rehearsal.
--
-- This migration makes no persistent schema, privilege or data change. It
-- exercises the emergency rollback inside a transaction, validates the legacy
-- write contract, rolls everything back, and then validates that the hardened
-- atomic contract (including PT409 conflicts) is fully restored.
--
-- TEST-ONLY: keep this file out of the release branch and main.

begin;
set local statement_timeout = '30s';
set local lock_timeout = '3s';

do $$
begin
  if to_regprocedure('public.rodios_save_bundle(jsonb)') is null then
    raise exception 'ROLLBACK_REHEARSAL_PRECHECK_FAIL: atomic save function missing';
  end if;
  if has_any_column_privilege('authenticated','public.rodios_issues','INSERT')
     or has_any_column_privilege('authenticated','public.rodios_issues','UPDATE')
     or has_function_privilege('authenticated','public.rodios_soft_delete(text,text[])','EXECUTE') then
    raise exception 'ROLLBACK_REHEARSAL_PRECHECK_FAIL: hardened write boundary is not active';
  end if;
end;
$$;

grant insert(id,data), update(id,data)
  on table public.rodios_issues to authenticated;
grant insert(id,issue_id,data), update(id,issue_id,data)
  on table public.rodios_work_orders to authenticated;
grant insert(id,work_order_id,data), update(id,work_order_id,data)
  on table public.rodios_payments to authenticated;
grant insert(id,data), update(id,data)
  on table public.rodios_service_staff to authenticated;
grant insert, update on table public.rodios_settings to authenticated;
grant execute on function public.rodios_soft_delete(text,text[]) to authenticated;

revoke execute on function public.rodios_save_bundle(jsonb) from authenticated;
drop function public.rodios_save_bundle(jsonb);

do $$
begin
  if not has_any_column_privilege('authenticated','public.rodios_issues','INSERT')
     or not has_any_column_privilege('authenticated','public.rodios_issues','UPDATE')
     or not has_function_privilege('authenticated','public.rodios_soft_delete(text,text[])','EXECUTE') then
    raise exception 'ROLLBACK_REHEARSAL_FAIL: legacy issue write contract was not restored';
  end if;
  if to_regprocedure('public.rodios_save_bundle(jsonb)') is not null then
    raise exception 'ROLLBACK_REHEARSAL_FAIL: atomic save function still exists';
  end if;
end;
$$;

rollback;

begin;
set local statement_timeout = '30s';
set local lock_timeout = '3s';

do $$
begin
  if to_regprocedure('public.rodios_save_bundle(jsonb)') is null then
    raise exception 'ROLLBACK_REHEARSAL_RESTORE_FAIL: atomic save function was not restored';
  end if;
  if has_any_column_privilege('authenticated','public.rodios_issues','INSERT')
     or has_any_column_privilege('authenticated','public.rodios_issues','UPDATE')
     or has_function_privilege('authenticated','public.rodios_soft_delete(text,text[])','EXECUTE') then
    raise exception 'ROLLBACK_REHEARSAL_RESTORE_FAIL: hardened write boundary was not restored';
  end if;
  if strpos(
    pg_get_functiondef('public.rodios_save_bundle(jsonb)'::regprocedure),
    '''PT409'''
  ) = 0 then
    raise exception 'ROLLBACK_REHEARSAL_RESTORE_FAIL: PT409 conflict definition was not restored';
  end if;
end;
$$;

rollback;
