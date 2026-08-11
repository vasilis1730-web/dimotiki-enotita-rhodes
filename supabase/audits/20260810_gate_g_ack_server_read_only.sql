-- RODIOS / Gate G — READ-ONLY ACK SERVER AUDIT
-- Date: 2026-08-10
-- Purpose: inspect the real public ACK backend before any production change.
-- SAFE: SELECT-only. No INSERT/UPDATE/DELETE/DDL, no temp objects, no function calls with side effects.
-- Run in the PRODUCTION Supabase SQL Editor and export the result as CSV.

with
ack_table as (
  select c.oid, n.nspname as schema_name, c.relname, c.relrowsecurity, c.relforcerowsecurity, c.relowner
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'work_order_acknowledgments' and c.relkind in ('r','p')
),
columns_json as (
  select jsonb_agg(
    jsonb_build_object(
      'position', a.attnum,
      'name', a.attname,
      'type', pg_catalog.format_type(a.atttypid, a.atttypmod),
      'not_null', a.attnotnull,
      'default', pg_get_expr(ad.adbin, ad.adrelid)
    ) order by a.attnum
  ) as details
  from ack_table t
  join pg_attribute a on a.attrelid=t.oid and a.attnum>0 and not a.attisdropped
  left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum
),
constraints_json as (
  select jsonb_agg(
    jsonb_build_object(
      'name', con.conname,
      'type', con.contype,
      'definition', pg_get_constraintdef(con.oid, true)
    ) order by con.conname
  ) as details
  from ack_table t
  join pg_constraint con on con.conrelid=t.oid
),
indexes_json as (
  select jsonb_agg(
    jsonb_build_object(
      'name', i.indexrelname,
      'definition', pg_get_indexdef(i.indexrelid),
      'scans', coalesce(i.idx_scan,0)
    ) order by i.indexrelname
  ) as details
  from ack_table t
  join pg_stat_user_indexes i on i.relid=t.oid
),
policies as (
  select
    p.policyname,
    p.permissive,
    p.roles,
    p.cmd,
    p.qual,
    p.with_check
  from pg_policies p
  where p.schemaname='public' and p.tablename='work_order_acknowledgments'
),
table_grants as (
  select grantee, privilege_type, is_grantable
  from information_schema.role_table_grants
  where table_schema='public' and table_name='work_order_acknowledgments'
),
target_functions as (
  select
    p.oid,
    n.nspname as schema_name,
    p.proname,
    pg_get_function_identity_arguments(p.oid) as identity_args,
    pg_get_function_result(p.oid) as result_type,
    p.prosecdef as security_definer,
    p.provolatile as volatility,
    p.proconfig,
    p.proowner,
    pg_get_userbyid(p.proowner) as owner_name,
    pg_get_functiondef(p.oid) as function_definition,
    p.proacl
  from pg_proc p
  join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public'
    and p.proname in ('complete_work_order_ack','acknowledge_work_order','generate_ack_token')
),
function_grants as (
  select
    f.oid,
    f.proname,
    f.identity_args,
    case when x.grantee=0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end as grantee,
    x.privilege_type,
    x.is_grantable
  from target_functions f
  cross join lateral aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) x
),
results as (
  select '00_CONTEXT'::text section, 'INFO'::text severity, 'DATABASE_CONTEXT'::text check_name,
         current_database()::text object_name, 'INFO'::text status,
         jsonb_build_object(
           'current_user', current_user,
           'server_version_num', current_setting('server_version_num'),
           'checked_at', clock_timestamp()
         )::text details

  union all
  select '10_ACK_TABLE','P0','ACK_TABLE_EXISTS','public.work_order_acknowledgments',
         case when exists(select 1 from ack_table) then 'PASS' else 'FAIL' end,
         coalesce((select jsonb_build_object(
           'rls_enabled', relrowsecurity,
           'rls_forced', relforcerowsecurity,
           'owner', pg_get_userbyid(relowner)
         )::text from ack_table),'{}')

  union all
  select '11_ACK_COLUMNS','INFO','ACK_TABLE_COLUMNS','public.work_order_acknowledgments',
         case when (select details from columns_json) is null then 'NO_DATA' else 'INFO' end,
         coalesce((select details::text from columns_json),'[]')

  union all
  select '12_ACK_CONSTRAINTS','P1','ACK_TABLE_CONSTRAINTS','public.work_order_acknowledgments',
         case when (select details from constraints_json) is null then 'REVIEW' else 'INFO' end,
         coalesce((select details::text from constraints_json),'[]')

  union all
  select '13_ACK_INDEXES','P1','ACK_TABLE_INDEXES','public.work_order_acknowledgments',
         case when (select details from indexes_json) is null then 'REVIEW' else 'INFO' end,
         coalesce((select details::text from indexes_json),'[]')

  union all
  select '20_ACK_RLS','P0','ACK_RLS_ENABLED','public.work_order_acknowledgments',
         case when exists(select 1 from ack_table where relrowsecurity) then 'PASS' else 'FAIL' end,
         coalesce((select jsonb_build_object('rls_enabled',relrowsecurity,'rls_forced',relforcerowsecurity)::text from ack_table),'{}')

  union all
  select '21_ACK_POLICIES','P0','ACK_POLICY',policyname,
         'REVIEW',
         jsonb_build_object(
           'permissive', permissive,
           'roles', roles,
           'command', cmd,
           'using', qual,
           'with_check', with_check
         )::text
  from policies

  union all
  select '22_ACK_TABLE_GRANTS','P0','ACK_TABLE_GRANT',grantee||':'||privilege_type,
         case
           when grantee in ('anon','PUBLIC') and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER') then 'REVIEW'
           else 'INFO'
         end,
         jsonb_build_object('grantee',grantee,'privilege',privilege_type,'grantable',is_grantable)::text
  from table_grants

  union all
  select '30_ACK_FUNCTIONS','P0','ACK_FUNCTION_DEFINITION',
         schema_name||'.'||proname||'('||identity_args||')',
         case
           when security_definer and not coalesce(array_to_string(proconfig,','),'') like '%search_path=%' then 'FAIL'
           else 'REVIEW'
         end,
         jsonb_build_object(
           'owner', owner_name,
           'security_definer', security_definer,
           'volatility', volatility,
           'proconfig', proconfig,
           'result_type', result_type,
           'definition', function_definition
         )::text
  from target_functions

  union all
  select '31_ACK_FUNCTION_GRANTS','P0','ACK_FUNCTION_EXECUTE',
         proname||'('||identity_args||') -> '||grantee,
         case
           when proname='complete_work_order_ack' and grantee='anon' and privilege_type='EXECUTE' then 'EXPECTED_PUBLIC_ENTRY_REVIEW'
           when grantee='PUBLIC' and privilege_type='EXECUTE' then 'REVIEW'
           else 'INFO'
         end,
         jsonb_build_object('grantee',grantee,'privilege',privilege_type,'grantable',is_grantable)::text
  from function_grants

  union all
  select '40_ACK_SECURITY_ASSERTIONS','P0','COMPLETE_ACK_EXISTS','public.complete_work_order_ack(p_token)',
         case when exists(select 1 from target_functions where proname='complete_work_order_ack') then 'PASS' else 'FAIL' end,
         jsonb_build_object('count',(select count(*) from target_functions where proname='complete_work_order_ack'))::text

  union all
  select '40_ACK_SECURITY_ASSERTIONS','P0','COMPLETE_ACK_SECURITY_DEFINER_SEARCH_PATH','public.complete_work_order_ack',
         case
           when exists(
             select 1 from target_functions
             where proname='complete_work_order_ack'
               and security_definer
               and coalesce(array_to_string(proconfig,','),'') like '%search_path=%'
           ) then 'PASS'
           else 'FAIL'
         end,
         'Must be SECURITY DEFINER only if body is tightly scoped, with fixed search_path and explicit token checks.'

  union all
  select '40_ACK_SECURITY_ASSERTIONS','P0','COMPLETE_ACK_ANON_EXECUTE','public.complete_work_order_ack',
         case when exists(
           select 1 from function_grants
           where proname='complete_work_order_ack' and grantee='anon' and privilege_type='EXECUTE'
         ) then 'EXPECTED_PUBLIC_ENTRY_REVIEW' else 'REVIEW' end,
         'The public ack.html currently requires anonymous EXECUTE. Do not revoke blindly; verify one-time, expiry, row scope and replay protection in the function body.'
)
select section, severity, check_name, object_name, status, details
from results
order by section, check_name, object_name;
