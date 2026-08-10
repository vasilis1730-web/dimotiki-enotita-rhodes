from pathlib import Path

p=Path('supabase/seed.sql')
s=p.read_text(encoding='utf-8')
old_decl="""do $$
declare r jsonb; amt numeric; used timestamptz;
begin"""
new_decl="""do $$
declare r jsonb; amt numeric;
begin"""
if s.count(old_decl)!=1:
    raise SystemExit(f'expected one H5 acceptance declaration, found {s.count(old_decl)}')
s=s.replace(old_decl,new_decl,1)

old_used="""  select used_at into used from public.rodios_pdf_verification_proofs where id='20000000-0000-4000-8000-000000000001'::uuid;
  if used is null then raise exception 'GATE_H5_FAIL: proof was not consumed'; end if;
end $$;"""
new_used="""end $$;"""
if s.count(old_used)!=1:
    raise SystemExit(f'expected one authenticated proof used_at check, found {s.count(old_used)}')
s=s.replace(old_used,new_used,1)

marker="""reset role;

-- Clean behavioral probe rows so the ordinary synthetic dataset remains small."""
insert="""reset role;

-- Owner-level inspection confirms the proof was consumed without granting clients table access.
do $$
declare used timestamptz;
begin
  select used_at into used from public.rodios_pdf_verification_proofs
  where id='20000000-0000-4000-8000-000000000001'::uuid;
  if used is null then raise exception 'GATE_H5_FAIL: proof was not consumed'; end if;
end $$;

-- Clean behavioral probe rows so the ordinary synthetic dataset remains small."""
if s.count(marker)!=1:
    raise SystemExit(f'expected one post-auth reset marker, found {s.count(marker)}')
s=s.replace(marker,insert,1)

# No authenticated block should directly inspect the private proof table after set role authenticated.
auth_start=s.find("set local role authenticated;\nselect set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);", s.find('Gate H.5'))
reset=s.find('\nreset role;',auth_start)
chunk=s[auth_start:reset]
if 'select used_at' in chunk or 'from public.rodios_pdf_verification_proofs' in chunk:
    raise SystemExit('authenticated H5 block still directly reads private proof table')
p.write_text(s,encoding='utf-8')
print('H5 proof privacy assertion moved to owner-level inspection')
