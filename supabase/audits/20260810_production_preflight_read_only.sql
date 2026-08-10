-- RODIOS final production preflight — READ ONLY.
--
-- Run only after separate explicit production-read approval, immediately before
-- release. The statements return aggregate counts and booleans only: no citizen
-- names, phones, email addresses, object names or attachment URLs are selected.
-- This script does not create, update, delete, grant, revoke or execute app RPCs.

begin transaction read only;
set local statement_timeout = '60s';
set local lock_timeout = '3s';

-- 1. Core row counts and profile/Auth binding health.
select
  (select count(*) from public.rodios_issues where deleted_at is null) as active_issues,
  (select count(*) from public.rodios_work_orders where deleted_at is null) as active_work_orders,
  (select count(*) from public.rodios_payments where deleted_at is null) as active_payments,
  (select count(*) from public.rodios_service_staff where deleted_at is null) as active_service_staff,
  (select count(*) from public.rodios_app_users where deleted_at is null) as active_app_profiles,
  (select count(*) from auth.users) as auth_users,
  (select count(*) from public.rodios_app_users where deleted_at is null and auth_user_id is null) as active_profiles_without_auth_uuid,
  (select count(*) from public.rodios_app_users p left join auth.users u on u.id=p.auth_user_id where p.deleted_at is null and u.id is null) as active_profiles_without_auth_user;

-- 2. No legacy password/PIN material may remain in active JSON profiles.
select
  count(*) filter (where data ? 'password') as password_keys,
  count(*) filter (where data ? 'pin') as pin_keys,
  count(*) filter (where data ? 'pwd') as pwd_keys,
  count(*) filter (where data ? 'passwordHash') as password_hash_keys
from public.rodios_app_users
where deleted_at is null;

-- 3. Environment identity. Production must never be marked staging=true.
select
  count(*) filter (where key='main') as main_settings_rows,
  coalesce(bool_or(lower(coalesce(value->>'staging','false')) in ('true','1','yes')) filter (where key='main'),false) as production_incorrectly_marked_staging
from public.rodios_settings;

-- 4. RLS must be enabled on all browser-visible operational tables.
select
  c.relname as table_name,
  c.relrowsecurity as rls_enabled,
  c.relforcerowsecurity as force_rls
from pg_class c
join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public'
  and c.relkind in ('r','p')
  and c.relname in (
    'rodios_app_users','rodios_issues','rodios_work_orders','rodios_payments',
    'rodios_settings','rodios_service_staff','rodios_sequences','rodios_audit_log'
  )
order by c.relname;

-- 5. Aggregate Storage inventory. Expected historical observation: 565 objects;
-- any difference is recorded, not assumed to be an error by itself.
select
  b.id as bucket_id,
  b.public as is_public,
  b.file_size_limit,
  count(o.id) as object_count,
  coalesce(sum(nullif(o.metadata->>'size','')::bigint),0) as total_bytes,
  count(*) filter (where o.name like '/%') as leading_slash_names,
  count(*) filter (where o.name ~ '(^|/)\.\.(/|$)') as traversal_like_names,
  count(*) filter (where o.name !~ '^[A-Za-z0-9._~!$&''()+,;=:@%/-]+$') as names_requiring_compatibility_review
from storage.buckets b
left join storage.objects o on o.bucket_id=b.id
where b.id in ('attachments','protocols')
group by b.id,b.public,b.file_size_limit
order by b.id;

-- 6. Recursively inspect attachment-shaped JSON nodes without returning values.
-- Canonical path refs and parseable same-project legacy URLs are matched to
-- Storage; external URLs/base64/pathless nodes remain explicit blockers.
with recursive roots as (
  select 'rodios_issues'::text as source_table,id,data as node from public.rodios_issues where deleted_at is null
  union all
  select 'rodios_work_orders',id,data from public.rodios_work_orders where deleted_at is null
  union all
  select 'rodios_payments',id,data from public.rodios_payments where deleted_at is null
), walk as (
  select source_table,id,'$'::text as json_path,node from roots
  union all
  select w.source_table,w.id,w.json_path||'/'||c.child_key,c.child_value
  from walk w
  cross join lateral (
    select e.key as child_key,e.value as child_value
    from jsonb_each(case when jsonb_typeof(w.node)='object' then w.node else '{}'::jsonb end) e
    union all
    select (a.ordinality-1)::text,a.value
    from jsonb_array_elements(case when jsonb_typeof(w.node)='array' then w.node else '[]'::jsonb end) with ordinality a(value,ordinality)
  ) c
), attachment_nodes as (
  select source_table,id,json_path,node,
         nullif(trim(node->>'path'),'') as canonical_path,
         nullif(trim(node->>'url'),'') as legacy_url
  from walk
  where jsonb_typeof(node)='object'
    and (node ? 'path' or node ? 'url')
    and (node ? 'name' or node ? 'type' or node ? 'size' or json_path ~* '(attach|media|protocol|photo|image)')
), normalized as (
  select *,
    case
      when canonical_path is not null then canonical_path
      when legacy_url ~ '^https://nzrdcgmrsfdmocyhfrod\.supabase\.co/storage/v1/object/(sign|authenticated|public)/attachments/'
        then substring(legacy_url from '/attachments/([^?#]+)')
      else null
    end as comparable_storage_name
  from attachment_nodes
)
select
  count(*) as attachment_metadata_nodes,
  count(*) filter (where canonical_path is not null) as canonical_path_refs,
  count(*) filter (where canonical_path is null and legacy_url is not null) as pathless_url_refs,
  count(*) filter (where legacy_url like 'data:%') as embedded_data_url_refs,
  count(*) filter (where legacy_url is not null and legacy_url !~ '^https://nzrdcgmrsfdmocyhfrod\.supabase\.co/storage/v1/object/(sign|authenticated|public)/attachments/') as non_project_or_non_storage_urls,
  count(*) filter (where comparable_storage_name is not null) as comparable_storage_refs,
  count(*) filter (where comparable_storage_name is not null and o.id is null) as comparable_refs_missing_objects,
  count(*) filter (where comparable_storage_name is not null and o.id is not null) as comparable_refs_with_objects
from normalized n
left join storage.objects o on o.bucket_id='attachments' and o.name=n.comparable_storage_name;

-- 7. Aggregate orphan estimate. This is conservative: unparseable percent-encoded
-- pathless URLs are excluded above and must be reviewed before release.
with recursive roots as (
  select data as node from public.rodios_issues where deleted_at is null
  union all select data from public.rodios_work_orders where deleted_at is null
  union all select data from public.rodios_payments where deleted_at is null
), walk as (
  select node from roots
  union all
  select c.child_value
  from walk w
  cross join lateral (
    select value as child_value from jsonb_each(case when jsonb_typeof(w.node)='object' then w.node else '{}'::jsonb end)
    union all
    select value from jsonb_array_elements(case when jsonb_typeof(w.node)='array' then w.node else '[]'::jsonb end)
  ) c
), refs as (
  select distinct coalesce(
    nullif(trim(node->>'path'),''),
    case when nullif(trim(node->>'url'),'') ~ '^https://nzrdcgmrsfdmocyhfrod\.supabase\.co/storage/v1/object/(sign|authenticated|public)/attachments/'
      then substring(node->>'url' from '/attachments/([^?#]+)') end
  ) as name
  from walk
  where jsonb_typeof(node)='object' and (node ? 'path' or node ? 'url')
)
select
  count(*) as attachment_objects,
  count(*) filter (where r.name is not null) as objects_with_comparable_metadata_ref,
  count(*) filter (where r.name is null) as objects_without_comparable_metadata_ref
from storage.objects o
left join refs r on r.name=o.name
where o.bucket_id='attachments';

-- 8. Release-function and privilege surface. NULL/false means migration or grant
-- mismatch; no function is executed.
select
  to_regprocedure('public.rodios_save_bundle(jsonb)') is not null as atomic_save_function_exists,
  to_regprocedure('public.rodios_finalize_verified_acceptance(uuid,text[])') is not null as verified_acceptance_function_exists,
  to_regprocedure('public.complete_work_order_ack(text)') is not null as public_ack_function_exists,
  not has_table_privilege('authenticated','public.rodios_issues','INSERT') as direct_issue_insert_denied,
  not has_table_privilege('authenticated','public.rodios_issues','UPDATE') as direct_issue_update_denied,
  not has_any_column_privilege('authenticated','public.rodios_issues','INSERT') as direct_issue_column_insert_denied,
  not has_any_column_privilege('authenticated','public.rodios_issues','UPDATE') as direct_issue_column_update_denied;

rollback;
