from pathlib import Path

p=Path('supabase/seed.sql')
s=p.read_text(encoding='utf-8')
old="""  select public.rodios_jsonb_numeric(data->'amount',-1) into amt
  from public.rodios_payments where work_order_id='stg_accept_wo' and deleted_at is null and coalesce(data->>'isPenalty','false')<>'true';"""
new="""  select case when coalesce(data->>'amount','') ~ '^-?[0-9]+([.][0-9]+)?$' then (data->>'amount')::numeric else -1 end into amt
  from public.rodios_payments where work_order_id='stg_accept_wo' and deleted_at is null and coalesce(data->>'isPenalty','false')<>'true';"""
if s.count(old)!=1:
    raise SystemExit(f'expected one H5 amount assertion, found {s.count(old)}')
s=s.replace(old,new,1)
if 'select public.rodios_jsonb_numeric(data->' in s:
    raise SystemExit('client-side seed still calls private numeric helper')
p.write_text(s,encoding='utf-8')
print('H5 payment assertion now respects private helper boundary')
