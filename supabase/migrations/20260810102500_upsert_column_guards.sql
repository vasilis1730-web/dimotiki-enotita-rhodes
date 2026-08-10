-- RODIOS release hardening: precise browser write columns with upsert compatibility.
begin;

create or replace function public.rodios_guard_immutable_id()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id then
    raise exception 'row id is immutable' using errcode='42501';
  end if;
  return new;
end $$;
revoke all on function public.rodios_guard_immutable_id() from public, anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array[
    'rodios_issues','rodios_work_orders','rodios_payments','rodios_service_staff'
  ] loop
    execute format('drop trigger if exists trg_%I_immutable_id on public.%I', t, t);
    execute format('create trigger trg_%I_immutable_id before update of id on public.%I for each row execute function public.rodios_guard_immutable_id()', t, t);
  end loop;
end $$;

-- Revoke broad INSERT/UPDATE and grant only fields used by the browser sync.
-- deleted_at is intentionally excluded: deletion is only rodios_soft_delete().
revoke insert, update on table
  public.rodios_issues,
  public.rodios_work_orders,
  public.rodios_payments,
  public.rodios_service_staff
from authenticated;

grant insert(id,data), update(id,data)
  on table public.rodios_issues to authenticated;

grant insert(id,issue_id,data), update(id,issue_id,data)
  on table public.rodios_work_orders to authenticated;

grant insert(id,work_order_id,data), update(id,work_order_id,data)
  on table public.rodios_payments to authenticated;

grant insert(id,data), update(id,data)
  on table public.rodios_service_staff to authenticated;

commit;
