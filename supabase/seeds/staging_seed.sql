-- RODIOS synthetic STAGING seed
-- Contains no production citizen data.
--
-- BEFORE running this seed, create and auto-confirm these three users in the
-- STAGING Supabase Dashboard > Authentication > Users, with temporary passwords:
--   rodios-admin-staging@rhodes.gr
--   rodios-manager-staging@rhodes.gr
--   rodios-user-staging@rhodes.gr
--
-- Run this only in the isolated staging/preview Supabase branch.

begin;

-- Fail closed if the three synthetic Auth accounts were not created first.
do $$
declare
  missing_count integer;
begin
  select count(*) into missing_count
  from (values
    ('rodios-admin-staging@rhodes.gr'::text),
    ('rodios-manager-staging@rhodes.gr'::text),
    ('rodios-user-staging@rhodes.gr'::text)
  ) v(email)
  where not exists (
    select 1 from auth.users u where lower(u.email)=lower(v.email)
  );

  if missing_count <> 0 then
    raise exception 'STAGING seed aborted: create the 3 synthetic Auth users first';
  end if;
end
$$;

-- Application profiles. The admin keeps id='admin' because the current staging
-- frontend still uses that id for Administrator UI behaviour; DB authorization
-- itself uses auth_user_id, not the id/email shortcut.
insert into public.rodios_app_users(id, auth_user_id, data, deleted_at)
select
  'admin', u.id,
  jsonb_build_object(
    'id','admin',
    'name','STAGING Administrator',
    'email',u.email,
    'tier','admin',
    'role','Administrator',
    'username','stg_admin',
    'canOrders',true
  ),
  null
from auth.users u
where lower(u.email)='rodios-admin-staging@rhodes.gr'
on conflict (id) do update set
  auth_user_id=excluded.auth_user_id,
  data=excluded.data,
  deleted_at=null;

insert into public.rodios_app_users(id, auth_user_id, data, deleted_at)
select
  'stg_manager', u.id,
  jsonb_build_object(
    'id','stg_manager',
    'name','STAGING Manager',
    'email',u.email,
    'tier','manager',
    'role','Διαχειριστής',
    'username','stg_manager',
    'canOrders',true
  ),
  null
from auth.users u
where lower(u.email)='rodios-manager-staging@rhodes.gr'
on conflict (id) do update set
  auth_user_id=excluded.auth_user_id,
  data=excluded.data,
  deleted_at=null;

insert into public.rodios_app_users(id, auth_user_id, data, deleted_at)
select
  'stg_user', u.id,
  jsonb_build_object(
    'id','stg_user',
    'name','STAGING User',
    'email',u.email,
    'tier','user',
    'role','Χρήστης',
    'username','stg_user',
    'canOrders',true
  ),
  null
from auth.users u
where lower(u.email)='rodios-user-staging@rhodes.gr'
on conflict (id) do update set
  auth_user_id=excluded.auth_user_id,
  data=excluded.data,
  deleted_at=null;

-- Keep application defaults: an empty value is merged over the frontend's
-- built-in settings object rather than replacing its defaults.
insert into public.rodios_settings(key, value)
values ('main', '{}'::jsonb)
on conflict (key) do update set value=excluded.value;

-- Synthetic issues exercise canonical numbering, filtering and multiple states.
insert into public.rodios_issues(id, data, issue_date, receipt, status, category, priority, title, location, phone, deleted_at)
values
(
  'stg_issue_001',
  jsonb_build_object(
    'id','stg_issue_001','issueNum','ΑΙΤ-2026-001','source','staff',
    'date','2026-08-09','receiptMethod','Τηλεφωνικά','status','Εκκρεμεί',
    'category','Οδοποιία','priority','ΚΑΤ. 2 - ΕΠΕΙΓΟΝ',
    'title','STAGING - δοκιμαστική λακκούβα','location','Δοκιμαστική θέση Ρόδου',
    'citizenName','STAGING TEST','contactInfo','0000000000','description','Συνθετικό δεδομένο staging - όχι πραγματικό αίτημα'
  ),
  '2026-08-09','Τηλεφωνικά','Εκκρεμεί','Οδοποιία','ΚΑΤ. 2 - ΕΠΕΙΓΟ',
  'STAGING - δοκιμαστική λακκούβα','Δοκιμαστική θέση Ρόδου','0000000000',null
),
(
  'stg_issue_002',
  jsonb_build_object(
    'id','stg_issue_002','issueNum','ΑΙΤ-2026-002','source','staff',
    'date','2026-08-09','receiptMethod','Email','status','Σε εξέλιξη',
    'category','Δημοτικός Φωτισμός','priority','ΚΑΤ. 3 - ΥΨΗΛΗ',
    'title','STAGING - δοκιμαστικό φωτιστικό','location','Δοκιμαστική πλατεία',
    'citizenName','STAGING TEST','contactInfo','staging@example.invalid','description','Συνθετικό δεδομένο staging - όχι πραγματικό αίτημα'
  ),
  '2026-08-09','Email','Σε εξέλιξη','Δημοτικός Φωτισμός','ΚΑΤ. 3 - ΥΨΗΛΗ',
  'STAGING - δοκιμαστικό φωτιστικό','Δοκιμαστική πλατεία',null,null
)
on conflict (id) do update set
  data=excluded.data,
  issue_date=excluded.issue_date,
  receipt=excluded.receipt,
  status=excluded.status,
  category=excluded.category,
  priority=excluded.priority,
  title=excluded.title,
  location=excluded.location,
  phone=excluded.phone,
  deleted_at=null;

-- Synthetic service staff row.
insert into public.rodios_service_staff(id, data, deleted_at)
values (
  'stg_staff_001',
  jsonb_build_object('id','stg_staff_001','name','STAGING Συνεργείο','role','Δοκιμή','phone','0000000000'),
  null
)
on conflict (id) do update set data=excluded.data, deleted_at=null;

-- Seed counters consistently with synthetic canonical numbers.
insert into public.rodios_sequences(kind,year,next_value)
values ('issue',2026,3), ('order',2026,1)
on conflict (kind,year) do update set
  next_value=greatest(public.rodios_sequences.next_value,excluded.next_value),
  updated_at=now();

commit;

-- Read-only verification.
select id, auth_user_id, data->>'email' as email, data->>'tier' as tier
from public.rodios_app_users
where deleted_at is null
order by id;

select kind, year, next_value from public.rodios_sequences order by kind, year;
select id, data->>'issueNum' as issue_num, status from public.rodios_issues where id like 'stg_%' order by id;
