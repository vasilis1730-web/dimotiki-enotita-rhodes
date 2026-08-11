-- RODIOS staging hardening: profile JSON must never contain credentials.
-- Authentication secrets belong exclusively to Supabase Auth.
begin;

update public.rodios_app_users
set data = coalesce(data, '{}'::jsonb)
           - 'password'
           - 'pin'
           - 'pwd'
           - 'passwordHash'
where coalesce(data, '{}'::jsonb) ?| array['password','pin','pwd','passwordHash'];

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'rodios_app_users_no_credentials_in_profile'
      and conrelid = 'public.rodios_app_users'::regclass
  ) then
    alter table public.rodios_app_users
      add constraint rodios_app_users_no_credentials_in_profile
      check (
        not (coalesce(data, '{}'::jsonb) ?| array['password','pin','pwd','passwordHash'])
      );
  end if;
end
$$;

commit;
