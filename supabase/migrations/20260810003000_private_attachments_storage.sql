-- RODIOS Gate C — Private attachment storage.
-- STAGING FIRST. Do not merge to production until citizen/staff signed-URL clients pass.

begin;

-- Ensure the bucket exists in fresh Preview branches and is private.
insert into storage.buckets (id, name, public, file_size_limit)
values ('attachments', 'attachments', false, 52428800)
on conflict (id) do update
set public = false,
    file_size_limit = 52428800;

-- Remove legacy/public policies if present. The citizen app will upload only through
-- citizen-attachments after cryptographic Firebase ID-token verification.
drop policy if exists "Anon upload attachments" on storage.objects;
drop policy if exists rodios_attachments_storage_select on storage.objects;
drop policy if exists rodios_attachments_storage_insert on storage.objects;
drop policy if exists rodios_attachments_storage_update on storage.objects;
drop policy if exists rodios_attachments_storage_delete on storage.objects;

-- Staff: only active RODIOS application users may read/upload/update attachments.
create policy rodios_attachments_storage_select
on storage.objects
for select
to authenticated
using (
  bucket_id = 'attachments'
  and public.rodios_is_active_user()
);

create policy rodios_attachments_storage_insert
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'attachments'
  and public.rodios_is_active_user()
);

create policy rodios_attachments_storage_update
on storage.objects
for update
to authenticated
using (
  bucket_id = 'attachments'
  and public.rodios_is_active_user()
)
with check (
  bucket_id = 'attachments'
  and public.rodios_is_active_user()
);

-- Deleting persisted Storage objects remains admin-only.
create policy rodios_attachments_storage_delete
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'attachments'
  and public.rodios_is_admin()
);

-- Deployment assertions: fail the migration rather than leave a half-hardened bucket.
do $$
declare
  v_public boolean;
  v_anon integer;
  v_staff integer;
begin
  select b.public into v_public
  from storage.buckets b
  where b.id='attachments';

  if v_public is distinct from false then
    raise exception 'GATE_C_FAIL: attachments bucket is not private';
  end if;

  select count(*) into v_anon
  from pg_policies p
  where p.schemaname='storage'
    and p.tablename='objects'
    and ('anon'=any(p.roles) or 'public'=any(p.roles))
    and (coalesce(p.qual,'') ilike '%attachments%' or coalesce(p.with_check,'') ilike '%attachments%');

  if v_anon <> 0 then
    raise exception 'GATE_C_FAIL: % anonymous/public attachment Storage policies remain', v_anon;
  end if;

  select count(*) into v_staff
  from pg_policies p
  where p.schemaname='storage'
    and p.tablename='objects'
    and p.policyname in (
      'rodios_attachments_storage_select',
      'rodios_attachments_storage_insert',
      'rodios_attachments_storage_update',
      'rodios_attachments_storage_delete'
    );

  if v_staff <> 4 then
    raise exception 'GATE_C_FAIL: expected 4 staff attachment policies, found %', v_staff;
  end if;
end $$;

commit;
