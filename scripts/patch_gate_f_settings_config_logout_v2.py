from pathlib import Path

base=Path('scripts/patch_gate_f_settings_config_logout.py')
code=base.read_text(encoding='utf-8')
needle='assert "localStorage.getItem(\'sb_url\')" not in s\nassert "localStorage.getItem(\'sb_key\')" not in s'
replacement='''# Final catch-all: no legacy browser-selected project/key may survive in executable code.\ns=s.replace("localStorage.getItem('sb_url')", "SUPABASE_URL")\ns=s.replace("localStorage.getItem('sb_key')", "SUPABASE_KEY")\nassert "localStorage.getItem('sb_url')" not in s\nassert "localStorage.getItem('sb_key')" not in s'''
assert needle in code, 'Could not locate Gate F invariant insertion point'
code=code.replace(needle,replacement,1)
exec(compile(code,str(base),'exec'))
