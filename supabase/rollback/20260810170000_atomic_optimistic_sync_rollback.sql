-- RODIOS emergency rollback for 20260810170000_atomic_optimistic_sync.sql.
--
-- Rehearse on an isolated Supabase Preview before production release. In a real
-- rollback, deploy the previous frontend commit first (or in the same controlled
-- window), then run this SQL. It restores only the legacy browser write surface;
-- it does not delete business rows, audit rows, Storage objects or Realtime data.

begin;

-- Restore the exact pre-atomic browser column privileges.
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

-- Remove the forward-only RPC after the previous frontend is ready.
revoke execute on function public.rodios_save_bundle(jsonb) from authenticated;
drop function public.rodios_save_bundle(jsonb);

-- Realtime publication membership is intentionally retained. Removing it could
-- suppress updates for concurrently open legacy sessions and is not required to
-- restore the old write contract.

do $$
begin
  if not has_any_column_privilege('authenticated','public.rodios_issues','INSERT')
     or not has_any_column_privilege('authenticated','public.rodios_issues','UPDATE')
     or not has_function_privilege('authenticated','public.rodios_soft_delete(text,text[])','EXECUTE') then
    raise exception 'ATOMIC_SYNC_ROLLBACK_FAIL: legacy issue write contract was not restored';
  end if;
  if to_regprocedure('public.rodios_save_bundle(jsonb)') is not null then
    raise exception 'ATOMIC_SYNC_ROLLBACK_FAIL: atomic save function still exists';
  end if;
end $$;

commit;
