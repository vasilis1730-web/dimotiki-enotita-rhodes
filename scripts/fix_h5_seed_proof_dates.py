from pathlib import Path

p=Path('supabase/seed.sql')
s=p.read_text(encoding='utf-8')
old="""  jsonb_build_object('stg_accept_wo',public.rodios_acceptance_snapshot(w.id,w.issue_id,w.data)),
  jsonb_build_object('verified',true,'source','seed-behavioral-proof','count',3,'signatureCount',3)
from public.rodios_work_orders w where w.id='stg_accept_wo';"""
new="""  jsonb_build_object('stg_accept_wo',public.rodios_acceptance_snapshot(w.id,w.issue_id,w.data)),
  jsonb_build_object('verified',true,'source','seed-behavioral-proof','count',3,'signatureCount',3),
  now(),
  now() + interval '15 minutes'
from public.rodios_work_orders w where w.id='stg_accept_wo';"""
if s.count(old)!=1:
    raise SystemExit(f'expected one H5 proof fixture block, found {s.count(old)}')
s=s.replace(old,new,1)
if new not in s or old in s:
    raise SystemExit('H5 proof date replacement invariant failed')
p.write_text(s,encoding='utf-8')
print('H5 synthetic proof dates fixed')
