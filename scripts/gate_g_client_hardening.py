from pathlib import Path
import re

P = Path('aftepistasia.html')
s = P.read_text(encoding='utf-8')
orig = s


def replace_once(old: str, new: str, label: str):
    global s
    n = s.count(old)
    if n != 1:
        raise SystemExit(f'{label}: expected exactly 1 match, found {n}')
    s = s.replace(old, new, 1)

# 1) Signature-verifier endpoint is environment-locked; it must not be configurable in Settings.
replace_once(
'''          <label style="font-size:11px;font-weight:600;color:var(--muted);display:block;margin-bottom:4px;">Edge Function URL (προαιρετικό — για αυτόματο έλεγχο ονομάτων)</label>
          <input type="url" id="sEdgeFnUrl" onchange="saveSett()" placeholder="https://xxx.supabase.co/functions/v1/verify-pdf-signatures" style="font-family:monospace;font-size:10px;width:100%;">
          <p style="font-size:10px;color:var(--muted);margin:4px 0 0;">Αναπτύξτε την Edge Function από το αρχείο edge_function.zip</p>''',
'''          <label style="font-size:11px;font-weight:600;color:var(--muted);display:block;margin-bottom:4px;">Edge Function ψηφιακής επαλήθευσης — κλειδωμένο περιβάλλον</label>
          <input type="url" id="sEdgeFnUrl" readonly aria-readonly="true" style="font-family:monospace;font-size:10px;width:100%;background:var(--sec);">
          <p style="font-size:10px;color:var(--muted);margin:4px 0 0;">Η κρυπτογραφική επαλήθευση εκτελείται αποκλειστικά από το verify-pdf-signatures του ίδιου Supabase project.</p>''',
'locked verifier settings UI')

replace_once(
"  if(document.getElementById('sEdgeFnUrl')) document.getElementById('sEdgeFnUrl').value=settings.edgeFnUrl||'';",
"  if(document.getElementById('sEdgeFnUrl')) document.getElementById('sEdgeFnUrl').value=String(SUPABASE_URL||'').replace(/\\/+$/,'')+'/functions/v1/verify-pdf-signatures';",
'locked verifier settings value')

replace_once(
"  settings.edgeFnUrl=(document.getElementById('sEdgeFnUrl')?.value||'');",
"  try{ delete settings.edgeFnUrl; }catch(_){ settings.edgeFnUrl=''; } // Gate G: verifier endpoint is build-locked",
'remove persisted verifier override')

# 2) Single protocol verification: fixed endpoint + authenticated staff JWT.
replace_once(
"    const _edgeUrl = (settings.edgeFnUrl||'https://nzrdcgmrsfdmocyhfrod.supabase.co/functions/v1/verify-pdf-signatures').trim();",
"    const _edgeUrl = String(SUPABASE_URL||'').replace(/\\/+$/,'') + '/functions/v1/verify-pdf-signatures';",
'fixed single verifier URL')

replace_once(
"      const _anonKey = (window._sb_key_override||SUPABASE_KEY||SUPABASE_KEY||'').trim();\n      if(!_anonKey){ alert('Δεν βρέθηκε Supabase Anon Key. Ελέγξτε τις Ρυθμίσεις → Supabase.'); _sigImportInProgress=false; return; }\n      toast('📡 Επικοινωνία με Edge Function...');",
"      const _anonKey = String(SUPABASE_KEY||'').trim();\n      const _sigSessionRes = await getSupabase().auth.getSession();\n      const _sigAccessToken = _sigSessionRes && _sigSessionRes.data && _sigSessionRes.data.session && _sigSessionRes.data.session.access_token;\n      if(!_anonKey || !_sigAccessToken){ alert('Απαιτείται ενεργή σύνδεση Supabase για κρυπτογραφική επαλήθευση.'); _sigImportInProgress=false; return; }\n      toast('📡 Επικοινωνία με Edge Function...');",
'authenticated single verifier setup')

replace_once(
"          'Authorization': 'Bearer '+_anonKey,\n          'apikey': _anonKey",
"          'Authorization': 'Bearer '+_sigAccessToken,\n          'apikey': _anonKey",
'authenticated single verifier headers')

# 3) Bulk protocol verification: fixed endpoint + authenticated staff JWT.
old_bulk = "  const edgeUrl=(settings.edgeFnUrl||'').trim(), anonKey=(SUPABASE_KEY||'').trim();\n  if(edgeUrl&&anonKey){\n    try{const resp=await fetch(edgeUrl,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+anonKey,'apikey':anonKey},body:JSON.stringify({pdfBase64:b64})});\n      if(resp.ok)edgeResult=await resp.json();}catch(e){}\n  }"
new_bulk = "  const edgeUrl=String(SUPABASE_URL||'').replace(/\\/+$/,'')+'/functions/v1/verify-pdf-signatures', anonKey=String(SUPABASE_KEY||'').trim();\n  const _bulkSessionRes=await getSupabase().auth.getSession();\n  const _bulkAccessToken=_bulkSessionRes&&_bulkSessionRes.data&&_bulkSessionRes.data.session&&_bulkSessionRes.data.session.access_token;\n  if(edgeUrl&&anonKey&&_bulkAccessToken){\n    try{const resp=await fetch(edgeUrl,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+_bulkAccessToken,'apikey':anonKey},body:JSON.stringify({pdfBase64:b64})});\n      if(resp.ok)edgeResult=await resp.json();}catch(e){}\n  }"
replace_once(old_bulk, new_bulk, 'authenticated bulk verifier')

# 4) Municipal-PDF parsing is staff-only: remove literal endpoint/key and send the actual staff access token.
old_parse = """    try{\n      var resp=await fetch('https://nzrdcgmrsfdmocyhfrod.supabase.co/functions/v1/parse-municipal-pdf',{\n        method:'POST',\n        // v9.19.7: Authorization header — η function πλέον απαιτεί verify_jwt\n        headers:{'Content-Type':'application/json','Authorization':'Bearer '+SUPABASE_KEY,'apikey':'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im56cmRjZ21yc2ZkbW9jeWhmcm9kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5MTg5MDMsImV4cCI6MjA4OTQ5NDkwM30.irU9tlBluAeTGcI0i3cc080OY7_nqR5js4ZPW8MC7b4'},\n        body:JSON.stringify({fileData:b64,mediaType:mtype})\n      });"""
new_parse = """    try{\n      var _parseSessionRes=await getSupabase().auth.getSession();\n      var _parseAccessToken=_parseSessionRes&&_parseSessionRes.data&&_parseSessionRes.data.session&&_parseSessionRes.data.session.access_token;\n      if(!_parseAccessToken) throw new Error('Απαιτείται ενεργή σύνδεση Supabase για ανάγνωση δημοτικού εγγράφου.');\n      var _parseBase=String(SUPABASE_URL||'').replace(/\\/+$/,'');\n      var _parseAnon=String(SUPABASE_KEY||'').trim();\n      var resp=await fetch(_parseBase+'/functions/v1/parse-municipal-pdf',{\n        method:'POST',\n        headers:{'Content-Type':'application/json','Authorization':'Bearer '+_parseAccessToken,'apikey':_parseAnon},\n        body:JSON.stringify({fileData:b64,mediaType:mtype})\n      });"""
replace_once(old_parse, new_parse, 'authenticated municipal parser')

# 5) Maps-link resolver is staff-only: use current session JWT instead of anon bearer.
old_resolve = """async function _resolveShortLink(url){\n  try{\n    var k=String(SUPABASE_KEY||'').trim();\n    var b=String(SUPABASE_URL||'').replace(/\\/+$/,'');\n    var r=await fetch(b+'/functions/v1/resolve-maps-link',{\n      method:'POST',\n      headers:{'Content-Type':'application/json','Authorization':'Bearer '+k,'apikey':k},\n      body:JSON.stringify({url:url})\n    });"""
new_resolve = """async function _resolveShortLink(url){\n  try{\n    var k=String(SUPABASE_KEY||'').trim();\n    var b=String(SUPABASE_URL||'').replace(/\\/+$/,'');\n    var _mapSessionRes=await getSupabase().auth.getSession();\n    var _mapAccessToken=_mapSessionRes&&_mapSessionRes.data&&_mapSessionRes.data.session&&_mapSessionRes.data.session.access_token;\n    if(!_mapAccessToken) return '';\n    var r=await fetch(b+'/functions/v1/resolve-maps-link',{\n      method:'POST',\n      headers:{'Content-Type':'application/json','Authorization':'Bearer '+_mapAccessToken,'apikey':k},\n      body:JSON.stringify({url:url})\n    });"""
replace_once(old_resolve, new_resolve, 'authenticated maps resolver')

# 6) Remove stale wording that contradicts Gate E fail-closed behavior.
s = s.replace(
"  // IMPORTANT: Do not require Edge Function success to unlock the workflow.\n  // If the Edge Function is unavailable/slow, the UI falls back to the locally detected PDF signature count.",
"  // Gate E/G: only explicit server-side cryptographic verified=true can unlock the workflow.\n  // Local PDF markers/signature counts are informational only and never authorize acceptance."
)

# Security invariants.
for forbidden in [
    "settings.edgeFnUrl||",
    "window._sb_key_override||SUPABASE_KEY",
    "'Authorization': 'Bearer '+_anonKey",
    "'Authorization':'Bearer '+SUPABASE_KEY",
    "'Authorization':'Bearer '+anonKey",
    "https://nzrdcgmrsfdmocyhfrod.supabase.co/functions/v1/parse-municipal-pdf",
]:
    if forbidden in s:
        raise SystemExit(f'forbidden Gate G pattern remains: {forbidden}')

required = [
    "'/functions/v1/verify-pdf-signatures'",
    "'Authorization': 'Bearer '+_sigAccessToken",
    "'Authorization':'Bearer '+_bulkAccessToken",
    "'Authorization':'Bearer '+_parseAccessToken",
    "'Authorization':'Bearer '+_mapAccessToken",
    "delete settings.edgeFnUrl",
]
for marker in required:
    if marker not in s:
        raise SystemExit(f'required Gate G marker missing: {marker}')

if s == orig:
    raise SystemExit('Gate G patch made no changes')

P.write_text(s, encoding='utf-8')
print('Gate G client hardening applied successfully.')
