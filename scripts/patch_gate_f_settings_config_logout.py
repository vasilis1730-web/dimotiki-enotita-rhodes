from pathlib import Path

path=Path('aftepistasia.html')
s=path.read_text(encoding='utf-8')
orig=s

def one(old,new,label):
    global s
    c=s.count(old)
    assert c==1,f'{label}: expected 1 match, found {c}'
    s=s.replace(old,new,1)

# ---------------------------------------------------------------------------
# 1. Settings are Administrator-only in UI, matching DB RLS.
# ---------------------------------------------------------------------------
one("function permSettings(u){ return userTier(u)!=='user'; }",
    "function permSettings(u){ return userTier(u)==='admin'; }",
    'permSettings')
s=s.replace('// v9.19.5: Ρυθμίσεις — Administrator & Διαχειριστής','// v9.20: Ρυθμίσεις — μόνο Administrator')
s=s.replace('Οι Ρυθμίσεις είναι διαθέσιμες μόνο σε Administrator/Διαχειριστή.','Οι Ρυθμίσεις είναι διαθέσιμες μόνο στον Administrator.')
s=s.replace('Οι Ρυθμίσεις επιτρέπονται μόνο σε Administrator/Διαχειριστή.','Οι Ρυθμίσεις επιτρέπονται μόνο στον Administrator.')

# ---------------------------------------------------------------------------
# 2. Supabase environment config is immutable at runtime.
# ---------------------------------------------------------------------------
one("""          <div class=\"fg full\"><label>Supabase Project URL</label>
            <input type=\"url\" id=\"sSupabaseUrl\" onchange=\"saveSupabaseConfig()\" placeholder=\"https://xxxx.supabase.co\" style=\"font-family:monospace;font-size:11px;\"></div>
          <div class=\"fg full\"><label>Supabase Anon Key</label>
            <input type=\"text\" id=\"sSupabaseKey\" onchange=\"saveSupabaseConfig()\" placeholder=\"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...\" style=\"font-family:monospace;font-size:10px;\"></div>""",
"""          <div class=\"fg full\"><label>Supabase Project URL — κλειδωμένο περιβάλλον</label>
            <input type=\"url\" id=\"sSupabaseUrl\" readonly aria-readonly=\"true\" style=\"font-family:monospace;font-size:11px;background:var(--sec);\"></div>
          <div class=\"fg full\"><label>Supabase Publishable/Anon Key — κλειδωμένο περιβάλλον</label>
            <input type=\"password\" id=\"sSupabaseKey\" readonly aria-readonly=\"true\" autocomplete=\"off\" style=\"font-family:monospace;font-size:10px;background:var(--sec);\"></div>""",
'locked config UI')

old_block="""function saveSupabaseConfig(){
  const url = (document.getElementById('sSupabaseUrl')?.value||'').trim();
  const key = (document.getElementById('sSupabaseKey')?.value||'').trim();
  localStorage.setItem('sb_url', url);
  localStorage.setItem('sb_key', key);
  // Re-init client
  _supabase = null;
  // Update the constants (they're read-only but we patch via closure)
  window._sb_url_override = url;
  window._sb_key_override = key;
  updateSupabaseStatus();
  renderStaffList();
}

function getSupabase(){
  const url = window._sb_url_override || localStorage.getItem('sb_url') || SUPABASE_URL;
  const key = window._sb_key_override || localStorage.getItem('sb_key') || SUPABASE_KEY;
  if(!_supabase && url && key && url.startsWith('http')){
    _supabase = supabase.createClient(url, key);"""
new_block="""function _clearLegacySupabaseOverrides(){
  try{ localStorage.removeItem('sb_url'); }catch(_){ }
  try{ localStorage.removeItem('sb_key'); }catch(_){ }
  try{ delete window._sb_url_override; }catch(_){ window._sb_url_override=undefined; }
  try{ delete window._sb_key_override; }catch(_){ window._sb_key_override=undefined; }
}

function saveSupabaseConfig(){
  _clearLegacySupabaseOverrides();
  updateSupabaseStatus();
  toast('🔒 Η σύνδεση Supabase είναι κλειδωμένη από την έκδοση της εφαρμογής και δεν αλλάζει από τον browser.');
}

function getSupabase(){
  _clearLegacySupabaseOverrides();
  const url = String(SUPABASE_URL || '').trim();
  const key = String(SUPABASE_KEY || '').trim();
  if(!_supabase && url && key && url.startsWith('http')){
    _supabase = supabase.createClient(url, key);"""
one(old_block,new_block,'Supabase config/getSupabase')

one("""function isSupabaseConfigured(){
  const url = window._sb_url_override || localStorage.getItem('sb_url') || SUPABASE_URL;
  const key = window._sb_key_override || localStorage.getItem('sb_key') || SUPABASE_KEY;
  return !!(url && key && url.startsWith('http'));
}""",
"""function isSupabaseConfigured(){
  _clearLegacySupabaseOverrides();
  const url=String(SUPABASE_URL||'').trim();
  const key=String(SUPABASE_KEY||'').trim();
  return !!(url && key && url.startsWith('http'));
}""",'isSupabaseConfigured')

one("""  // Populate fields from localStorage
  const url = localStorage.getItem('sb_url')||SUPABASE_URL||'';
  const key = localStorage.getItem('sb_key')||SUPABASE_KEY||'';
  if(document.getElementById('sSupabaseUrl')) document.getElementById('sSupabaseUrl').value=url;
  if(document.getElementById('sSupabaseKey')) document.getElementById('sSupabaseKey').value=key;""",
"""  // Environment is build-locked; legacy per-browser overrides are removed.
  _clearLegacySupabaseOverrides();
  const url = SUPABASE_URL||'';
  const key = SUPABASE_KEY||'';
  if(document.getElementById('sSupabaseUrl')) document.getElementById('sSupabaseUrl').value=url;
  if(document.getElementById('sSupabaseKey')) document.getElementById('sSupabaseKey').value=key;""",'status config fields')

# resolve-maps-link hard lock.
one("""    var k=window._sb_key_override||localStorage.getItem('sb_key')||SUPABASE_KEY;
    var b=window._sb_url_override||localStorage.getItem('sb_url')||SUPABASE_URL;""",
"""    var k=String(SUPABASE_KEY||'').trim();
    var b=String(SUPABASE_URL||'').replace(/\\/+$/,'');""",'resolve map environment')

# send-order-email has two runtime override blocks.
old="""  const sbUrl = String(window._sb_url_override || localStorage.getItem('sb_url') || SUPABASE_URL || '').replace(/\\/+$/,'');
  const anonKey = String(window._sb_key_override || localStorage.getItem('sb_key') || SUPABASE_KEY || '').trim();"""
new="""  const sbUrl = String(SUPABASE_URL || '').replace(/\\/+$/,'');
  const anonKey = String(SUPABASE_KEY || '').trim();"""
c=s.count(old)
assert c==2,f'send-order-email override blocks: expected 2, found {c}'
s=s.replace(old,new)

# ---------------------------------------------------------------------------
# 3. Logout: purge operational local persistence and in-memory state.
# ---------------------------------------------------------------------------
marker="async function doLogout(){"
assert s.count(marker)==1,'doLogout marker not unique'
helper=r'''async function _purgeOperationalBrowserState(){
  const keys=[
    'rodios_v9_light_cache','rodios_v9_last_counts','rhodesAppUsers','serviceStaff',
    'sb_url','sb_key'
  ];
  keys.forEach(k=>{ try{ localStorage.removeItem(k); }catch(_){ } });
  _clearLegacySupabaseOverrides();

  // Delete only RODIOS operational IndexedDB caches; do not wipe unrelated origin data.
  const known=['rodios_v9_cache_db','rodios_v9_cache_db_v2','rodios_v9_cache_db_v3','rodios_v9_cache_db_v4','rodios_v9_cache_db_v5'];
  let names=known.slice();
  try{
    if(indexedDB && typeof indexedDB.databases==='function'){
      const dbs=await indexedDB.databases();
      (dbs||[]).forEach(d=>{ if(d&&d.name&&String(d.name).startsWith('rodios_')&&!names.includes(d.name)) names.push(d.name); });
    }
  }catch(_){ }
  names.forEach(n=>{ try{ indexedDB.deleteDatabase(n); }catch(_){ } });

  // Remove sensitive operational state from memory before showing the login screen.
  issues=[]; workOrders=[]; payments=[];
  if(typeof SERVICE_STAFF!=='undefined') SERVICE_STAFF=[];
  try{ _locallyDeleted.clear(); }catch(_){ }
  try{ _bulkSelected.clear(); }catch(_){ }
  _lastSyncTime=0;
}

'''
s=s.replace(marker,helper+marker,1)

one("""async function doLogout(){
  try{ const sb=getSupabase(); if(sb && sb.auth) await sb.auth.signOut(); }catch(e){}
  currentUser=null;""",
"""async function doLogout(){
  try{ const sb=getSupabase(); if(sb && sb.auth) await sb.auth.signOut(); }catch(e){}
  await _purgeOperationalBrowserState();
  _supabase=null;
  currentUser=null;""",'doLogout purge')

# ---------------------------------------------------------------------------
# Invariants.
# ---------------------------------------------------------------------------
assert "function permSettings(u){ return userTier(u)==='admin'; }" in s
assert 'Administrator/Διαχειριστή' not in s
assert "localStorage.setItem('sb_url'" not in s
assert "localStorage.setItem('sb_key'" not in s
assert "localStorage.getItem('sb_url')" not in s
assert "localStorage.getItem('sb_key')" not in s
assert 'window._sb_url_override ||' not in s
assert 'window._sb_key_override ||' not in s
assert 'await _purgeOperationalBrowserState();' in s
assert "localStorage.removeItem('rodios_v9_light_cache')" in s or "'rodios_v9_light_cache'" in s
assert s!=orig

path.write_text(s,encoding='utf-8')
print('Gate F settings/config/logout hardening patch applied successfully.')
