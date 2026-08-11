-- RODIOS release hardening: application conflicts must not use SQLSTATE 40001.
--
-- 40001 is PostgreSQL's retryable serialization-failure class. PostgREST and
-- the database pool may therefore retry or hold a request that deliberately
-- raises it, turning an optimistic conflict into a long-running RPC. PT409 is
-- PostgREST's explicit HTTP 409 application error and rolls the transaction
-- back immediately.
--
-- Fresh deployments already receive PT409 from the corrected source
-- migrations. This forward-only migration also repairs disposable Previews
-- that applied the earlier function definitions before that correction.

begin;

do $$
declare
  v_definition text;
begin
  select pg_get_functiondef('public.rodios_save_bundle(jsonb)'::regprocedure)
    into v_definition;
  if strpos(v_definition, '''40001''') > 0 then
    execute replace(v_definition, '''40001''', '''PT409''');
  end if;

  select pg_get_functiondef('public.rodios_finalize_verified_acceptance(uuid,text[])'::regprocedure)
    into v_definition;
  if strpos(v_definition, '''40001''') > 0 then
    execute replace(v_definition, '''40001''', '''PT409''');
  end if;
end;
$$;

do $$
begin
  if strpos(
    pg_get_functiondef('public.rodios_save_bundle(jsonb)'::regprocedure),
    '''PT409'''
  ) = 0 then
    raise exception 'NONRETRYABLE_CONFLICT_FAIL: rodios_save_bundle is not PT409';
  end if;
  if strpos(
    pg_get_functiondef('public.rodios_finalize_verified_acceptance(uuid,text[])'::regprocedure),
    '''PT409'''
  ) = 0 then
    raise exception 'NONRETRYABLE_CONFLICT_FAIL: verified acceptance is not PT409';
  end if;
end;
$$;

commit;
