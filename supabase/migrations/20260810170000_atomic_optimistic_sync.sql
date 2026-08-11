-- RODIOS release hardening: atomic optimistic concurrency for browser writes.
--
-- Direct browser INSERT/UPDATE and the legacy non-versioned soft-delete RPC are
-- removed. Active staff write through one transaction that compares the exact
-- server updated_at value read by the browser. A stale concurrent save therefore
-- rolls the entire bundle back instead of silently overwriting another session.

begin;

create or replace function public.rodios_save_bundle(p_bundle jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_entity text;
  v_section jsonb;
  v_rows jsonb;
  v_deletes jsonb;
  v_row jsonb;
  v_id text;
  v_expected timestamptz;
  v_updated timestamptz;
  v_table text;
  v_versions jsonb := jsonb_build_object(
    'issues', '{}'::jsonb,
    'workOrders', '{}'::jsonb,
    'payments', '{}'::jsonb,
    'settings', '{}'::jsonb,
    'serviceStaff', '{}'::jsonb
  );
  v_deleted jsonb := jsonb_build_object(
    'issues', '[]'::jsonb,
    'workOrders', '[]'::jsonb,
    'payments', '[]'::jsonb,
    'serviceStaff', '[]'::jsonb
  );
begin
  if p_bundle is null or jsonb_typeof(p_bundle) <> 'object' then
    raise exception 'Invalid RODIOS save bundle' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_object_keys(p_bundle) as k(key)
    where k.key <> all(array['issues','workOrders','payments','settings','serviceStaff'])
  ) then
    raise exception 'Unsupported RODIOS save entity' using errcode = '22023';
  end if;

  v_role := public.rodios_current_role();
  if v_role is null then
    raise exception 'RODIOS active application user required' using errcode = '42501';
  end if;

  -- Validate every supplied section before performing any write.
  foreach v_entity in array array['issues','workOrders','payments','settings','serviceStaff'] loop
    v_section := p_bundle -> v_entity;
    if v_section is null then
      continue;
    end if;
    if jsonb_typeof(v_section) <> 'object'
       or exists (
         select 1 from jsonb_object_keys(v_section) as k(key)
         where k.key <> all(array['upserts','deletes'])
       ) then
      raise exception 'Invalid RODIOS save section: %', v_entity using errcode = '22023';
    end if;

    v_rows := coalesce(v_section -> 'upserts', '[]'::jsonb);
    v_deletes := coalesce(v_section -> 'deletes', '[]'::jsonb);
    if jsonb_typeof(v_rows) <> 'array' or jsonb_typeof(v_deletes) <> 'array' then
      raise exception 'Invalid RODIOS save arrays: %', v_entity using errcode = '22023';
    end if;
    if jsonb_array_length(v_rows) > 500 or jsonb_array_length(v_deletes) > 500 then
      raise exception 'RODIOS save section is too large: %', v_entity using errcode = '22023';
    end if;
    if v_entity = 'settings' and jsonb_array_length(v_deletes) > 0 then
      raise exception 'Settings deletion is unsupported' using errcode = '22023';
    end if;
    if (
      select count(*) <> count(distinct coalesce(value ->> case when v_entity='settings' then 'key' else 'id' end, ''))
      from jsonb_array_elements(v_rows)
    ) or (
      select count(*) <> count(distinct coalesce(value ->> 'id', ''))
      from jsonb_array_elements(v_deletes)
    ) then
      raise exception 'Duplicate id in RODIOS save section: %', v_entity using errcode = '22023';
    end if;
  end loop;

  -- Deletions first, in dependency order. Every delete requires Administrator
  -- permission and the exact version originally read by the browser.
  foreach v_entity in array array['payments','workOrders','issues','serviceStaff'] loop
    v_deletes := coalesce(p_bundle -> v_entity -> 'deletes', '[]'::jsonb);
    if jsonb_array_length(v_deletes) = 0 then
      continue;
    end if;
    if v_role <> 'admin' then
      raise exception 'Administrator permission required' using errcode = '42501';
    end if;

    v_table := case v_entity
      when 'payments' then 'rodios_payments'
      when 'workOrders' then 'rodios_work_orders'
      when 'issues' then 'rodios_issues'
      when 'serviceStaff' then 'rodios_service_staff'
    end;

    for v_row in select value from jsonb_array_elements(v_deletes) loop
      if jsonb_typeof(v_row) <> 'object'
         or exists (
           select 1 from jsonb_object_keys(v_row) as k(key)
           where k.key <> all(array['id','expectedUpdatedAt'])
         ) then
        raise exception 'Invalid RODIOS delete row: %', v_entity using errcode = '22023';
      end if;
      v_id := trim(coalesce(v_row ->> 'id', ''));
      if length(v_id) < 1 or length(v_id) > 220 or nullif(v_row ->> 'expectedUpdatedAt','') is null then
        raise exception 'Invalid RODIOS delete identity/version: %', v_entity using errcode = '22023';
      end if;
      begin
        v_expected := (v_row ->> 'expectedUpdatedAt')::timestamptz;
      exception when others then
        raise exception 'Invalid RODIOS delete timestamp: %', v_entity using errcode = '22023';
      end;

      v_updated := null;
      execute format(
        'update public.%I set deleted_at=now() where id=$1 and updated_at=$2 and deleted_at is null returning updated_at',
        v_table
      ) into v_updated using v_id, v_expected;
      if v_updated is null then
        raise exception 'RODIOS_SYNC_CONFLICT'
          using errcode = 'PT409', detail = v_entity || ':' || v_id;
      end if;
      v_deleted := jsonb_set(
        v_deleted,
        array[v_entity],
        (v_deleted -> v_entity) || to_jsonb(v_id),
        true
      );
    end loop;
  end loop;

  -- Upserts next, in dependency order. NULL expectedUpdatedAt means a genuinely
  -- new id; a duplicate id is reported as a synchronization conflict.
  foreach v_entity in array array['issues','workOrders','payments','settings','serviceStaff'] loop
    v_rows := coalesce(p_bundle -> v_entity -> 'upserts', '[]'::jsonb);
    if jsonb_array_length(v_rows) = 0 then
      continue;
    end if;
    if v_entity = 'settings' and v_role <> 'admin' then
      raise exception 'Administrator permission required' using errcode = '42501';
    end if;

    v_table := case v_entity
      when 'issues' then 'rodios_issues'
      when 'workOrders' then 'rodios_work_orders'
      when 'payments' then 'rodios_payments'
      when 'settings' then 'rodios_settings'
      when 'serviceStaff' then 'rodios_service_staff'
    end;

    for v_row in select value from jsonb_array_elements(v_rows) loop
      if jsonb_typeof(v_row) <> 'object' then
        raise exception 'Invalid RODIOS upsert row: %', v_entity using errcode = '22023';
      end if;
      v_id := trim(coalesce(v_row ->> case when v_entity='settings' then 'key' else 'id' end, ''));
      if length(v_id) < 1 or length(v_id) > 220 then
        raise exception 'Invalid RODIOS upsert identity: %', v_entity using errcode = '22023';
      end if;
      if v_entity = 'settings' then
        if (v_row - array['key','value','expectedUpdatedAt']) <> '{}'::jsonb
           or jsonb_typeof(v_row -> 'value') <> 'object' then
          raise exception 'Invalid settings payload' using errcode = '22023';
        end if;
      elsif v_entity = 'workOrders' then
        if (v_row - array['id','issue_id','data','expectedUpdatedAt']) <> '{}'::jsonb
           or jsonb_typeof(v_row -> 'data') <> 'object' then
          raise exception 'Invalid work-order payload' using errcode = '22023';
        end if;
      elsif v_entity = 'payments' then
        if (v_row - array['id','work_order_id','data','expectedUpdatedAt']) <> '{}'::jsonb
           or jsonb_typeof(v_row -> 'data') <> 'object' then
          raise exception 'Invalid payment payload' using errcode = '22023';
        end if;
      else
        if (v_row - array['id','data','expectedUpdatedAt']) <> '{}'::jsonb
           or jsonb_typeof(v_row -> 'data') <> 'object' then
          raise exception 'Invalid RODIOS payload: %', v_entity using errcode = '22023';
        end if;
      end if;

      v_updated := null;
      if nullif(v_row ->> 'expectedUpdatedAt','') is null then
        begin
          case v_entity
            when 'issues' then
              insert into public.rodios_issues(id,data) values (v_id,v_row->'data') returning updated_at into v_updated;
            when 'workOrders' then
              insert into public.rodios_work_orders(id,issue_id,data)
              values (v_id,nullif(v_row->>'issue_id',''),v_row->'data') returning updated_at into v_updated;
            when 'payments' then
              insert into public.rodios_payments(id,work_order_id,data)
              values (v_id,nullif(v_row->>'work_order_id',''),v_row->'data') returning updated_at into v_updated;
            when 'settings' then
              insert into public.rodios_settings(key,value) values (v_id,v_row->'value') returning updated_at into v_updated;
            when 'serviceStaff' then
              insert into public.rodios_service_staff(id,data) values (v_id,v_row->'data') returning updated_at into v_updated;
          end case;
        exception when unique_violation then
          raise exception 'RODIOS_SYNC_CONFLICT'
            using errcode = 'PT409', detail = v_entity || ':' || v_id;
        end;
      else
        begin
          v_expected := (v_row ->> 'expectedUpdatedAt')::timestamptz;
        exception when others then
          raise exception 'Invalid RODIOS update timestamp: %', v_entity using errcode = '22023';
        end;
        case v_entity
          when 'issues' then
            update public.rodios_issues set data=v_row->'data'
            where id=v_id and updated_at=v_expected and deleted_at is null returning updated_at into v_updated;
          when 'workOrders' then
            update public.rodios_work_orders set issue_id=nullif(v_row->>'issue_id',''),data=v_row->'data'
            where id=v_id and updated_at=v_expected and deleted_at is null returning updated_at into v_updated;
          when 'payments' then
            update public.rodios_payments set work_order_id=nullif(v_row->>'work_order_id',''),data=v_row->'data'
            where id=v_id and updated_at=v_expected and deleted_at is null returning updated_at into v_updated;
          when 'settings' then
            update public.rodios_settings set value=v_row->'value'
            where key=v_id and updated_at=v_expected returning updated_at into v_updated;
          when 'serviceStaff' then
            update public.rodios_service_staff set data=v_row->'data'
            where id=v_id and updated_at=v_expected and deleted_at is null returning updated_at into v_updated;
        end case;
        if v_updated is null then
          raise exception 'RODIOS_SYNC_CONFLICT'
            using errcode = 'PT409', detail = v_entity || ':' || v_id;
        end if;
      end if;

      v_versions := jsonb_set(v_versions,array[v_entity,v_id],to_jsonb(v_updated),true);
    end loop;
  end loop;

  return jsonb_build_object('ok',true,'versions',v_versions,'deleted',v_deleted);
end;
$$;

revoke all on function public.rodios_save_bundle(jsonb) from public, anon;
grant execute on function public.rodios_save_bundle(jsonb) to authenticated, service_role;

-- Remove all legacy direct-write paths for browser-authenticated sessions.
revoke insert, update on table
  public.rodios_issues,
  public.rodios_work_orders,
  public.rodios_payments,
  public.rodios_settings,
  public.rodios_service_staff
from authenticated;
revoke insert(id,data), update(id,data) on table public.rodios_issues from authenticated;
revoke insert(id,issue_id,data), update(id,issue_id,data) on table public.rodios_work_orders from authenticated;
revoke insert(id,work_order_id,data), update(id,work_order_id,data) on table public.rodios_payments from authenticated;
revoke insert(id,data), update(id,data) on table public.rodios_service_staff from authenticated;
revoke execute on function public.rodios_soft_delete(text,text[]) from authenticated;

-- The application depends on these tables for two-session refresh. Add them to
-- the Supabase Realtime publication idempotently when that publication exists.
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname='supabase_realtime') then
    foreach t in array array[
      'rodios_issues','rodios_work_orders','rodios_payments',
      'rodios_settings','rodios_app_users','rodios_service_staff'
    ] loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname='supabase_realtime' and schemaname='public' and tablename=t
      ) then
        execute format('alter publication supabase_realtime add table public.%I',t);
      end if;
    end loop;
  end if;
end $$;

-- Deployment assertions: authenticated users can use only the atomic RPC for
-- operational writes, while ordinary SELECT remains governed by RLS.
do $$
declare
  t text;
begin
  foreach t in array array[
    'rodios_issues','rodios_work_orders','rodios_payments',
    'rodios_settings','rodios_service_staff'
  ] loop
    if has_table_privilege('authenticated',format('public.%I',t),'INSERT')
       or has_table_privilege('authenticated',format('public.%I',t),'UPDATE')
       or has_any_column_privilege('authenticated',format('public.%I',t),'INSERT')
       or has_any_column_privilege('authenticated',format('public.%I',t),'UPDATE') then
      raise exception 'ATOMIC_SYNC_FAIL: authenticated retains direct write privilege on %',t;
    end if;
  end loop;
  if not has_function_privilege('authenticated','public.rodios_save_bundle(jsonb)','EXECUTE') then
    raise exception 'ATOMIC_SYNC_FAIL: authenticated cannot execute rodios_save_bundle';
  end if;
  if has_function_privilege('authenticated','public.rodios_soft_delete(text,text[])','EXECUTE') then
    raise exception 'ATOMIC_SYNC_FAIL: legacy non-versioned soft delete remains executable';
  end if;
end $$;

commit;
