from pathlib import Path
import re

path=Path('aftepistasia.html')
s=path.read_text(encoding='utf-8')
orig=s

# 1. Local scan can populate diagnostics only; never declare validity/readiness.
old="""    wo._edgeResult = {
      verified: null,
      valid: _sigs >= _req,
      count: _sigs,
      signers: localNames,
      message: message || 'Τοπικός έλεγχος: εντοπίστηκαν '+_sigs+'/'+_req+' ψηφιακές υπογραφές στο PDF.'
    };
    if(_sigs >= _req) wo._protocolReady = true;"""
new="""    wo._edgeResult = {
      verified: null,
      valid: false,
      count: _sigs,
      signers: localNames,
      message: message || 'Τοπικός προκαταρκτικός έλεγχος: εντοπίστηκαν '+_sigs+'/'+_req+' υπογραφές. Απαιτείται κρυπτογραφική επαλήθευση από τον server.'
    };
    wo._protocolReady = false;"""
assert s.count(old)==1, f'local fallback block count={s.count(old)}'
s=s.replace(old,new)

# 2. Single protocol: only explicit verified=true is positive.
old="""  const _edgeOk = _edgeResult
    ? ((_edgeResult.verified === true || _edgeResult.valid === true || _edgeResult.certificatesOk === true)
        ? true
        : ((_edgeResult.verified === false || _edgeResult.valid === false) ? false : null))
    : null;"""
new="""  const _edgeOk = _edgeResult
    ? (_edgeResult.verified === true ? true : (_edgeResult.verified === false ? false : null))
    : null;"""
assert s.count(old)==1, f'single edge normalization count={s.count(old)}'
s=s.replace(old,new)

old="""  const isValid = hasSigned && _committeeConfigured && _localSigCountOk && !_edgeFailed
    && (_edgeOk === true || _edgeOk === null);
  const _verificationMode = _edgeOk === true ? 'crypto' : (isValid ? 'local' : 'pending');"""
new="""  const isValid = hasSigned && _committeeConfigured && _localSigCountOk && !_edgeFailed
    && _edgeOk === true;
  const _verificationMode = isValid ? 'crypto' : 'pending';"""
assert s.count(old)==1, f'single isValid block count={s.count(old)}'
s=s.replace(old,new)

# 3. Verification response: only verified=true persists protocolReady.
pat=re.compile(r"          // Set persistent flag if verification succeeded OR if Edge only reports valid=true\n          if\(_result\.verified === true \|\| _result\.valid === true \|\| _result\.certificatesOk === true\) \{\n            wo\._protocolReady = true;\n          \} else if\(_result\.verified !== false && _result\.valid !== false && _sigs >= _req\) \{\n            // Edge did not explicitly reject the PDF, and local count is sufficient\.\n            wo\._protocolReady = true;\n          \}\n          if\(_result\.valid \|\| _result\.verified === true\)\{\n            toast\('✅ Κρυπτογραφική επαλήθευση: ΕΓΚΥΡΟ — '\+\(_extractedNames\.join\(', '\)\|\|\(_sigs\+'/'+_req\+' υπογραφές'\)\)\);\n          \} else if\(_result\.verified && !_result\.certificatesOk\)\{\n            toast\('⚠ Υπογραφές παρούσες αλλά: '\+_result\.message\);\n          \} else if\(_sigs >= _req && _result\.verified !== false && _result\.valid !== false\)\{\n            toast\('✅ '\+_sigs\+'/'+_req\+' ψηφιακές υπογραφές — συνέχιση με τοπικό έλεγχο'\);\n          \} else \{\n            toast\('❌ Επαλήθευση: '\+\(_result\.message\|\|'Σφάλμα'\)\);\n          \}")
assert pat.search(s), 'verification response fallback block not found'
s=pat.sub("""          // Fail closed: only explicit server cryptographic verification authorizes the protocol.
          wo._protocolReady = (_result.verified === true);
          if(_result.verified === true){
            toast('✅ Κρυπτογραφική επαλήθευση: ΕΓΚΥΡΟ — '+(_extractedNames.join(', ')||(_sigs+'/'+_req+' υπογραφές')));
          } else if(_result.verified === false){
            toast('❌ Κρυπτογραφική επαλήθευση: ΑΠΟΡΡΙΦΘΗΚΕ — '+(_result.message||'Μη έγκυρο PDF'));
          } else {
            toast('⏳ Δεν υπάρχει οριστικό κρυπτογραφικό αποτέλεσμα. Η παραλαβή παραμένει κλειδωμένη.');
          }""",s,count=1)

# 4. Synchronous local merge after upload must never promote local result to valid.
old="""  if(!wo._edgeResult){
    wo._edgeResult = {verified:null, valid:_sigs>=_req, count:_sigs, signers:_allNames, message:'Τοπικός έλεγχος: εντοπίστηκαν '+_sigs+'/'+_req+' ψηφιακές υπογραφές στο PDF.'};
  } else {
    if(!Array.isArray(wo._edgeResult.signers) || !wo._edgeResult.signers.length) wo._edgeResult.signers = _allNames;
    if(!wo._edgeResult.count || wo._edgeResult.count < _sigs) wo._edgeResult.count = _sigs;
    if(_sigs >= _req && wo._edgeResult.verified !== false && wo._edgeResult.valid !== false){
      wo._edgeResult.valid = true;
      wo._protocolReady = true;
      if(!wo._edgeResult.message) wo._edgeResult.message = 'Τοπικός έλεγχος: εντοπίστηκαν '+_sigs+'/'+_req+' ψηφιακές υπογραφές στο PDF.';
    }
  }"""
new="""  if(!wo._edgeResult){
    wo._edgeResult = {verified:null, valid:false, count:_sigs, signers:_allNames, message:'Τοπικός προκαταρκτικός έλεγχος: εντοπίστηκαν '+_sigs+'/'+_req+' υπογραφές. Αναμένεται κρυπτογραφική επαλήθευση.'};
    wo._protocolReady = false;
  } else {
    if(!Array.isArray(wo._edgeResult.signers) || !wo._edgeResult.signers.length) wo._edgeResult.signers = _allNames;
    if(!wo._edgeResult.count || wo._edgeResult.count < _sigs) wo._edgeResult.count = _sigs;
    wo._protocolReady = (wo._edgeResult.verified === true);
  }"""
assert s.count(old)==1, f'local merge promotion count={s.count(old)}'
s=s.replace(old,new)

# 5. Order list: signed file alone is not a verified protocol.
old="""      // hasProtocol = PDF exists AND edge function verified it (or no edge result yet)
      const _wEdgeOk = w._edgeResult
        ? ((w._edgeResult.verified === true || w._edgeResult.valid === true || w._edgeResult.certificatesOk === true)
            ? true
            : ((w._edgeResult.verified === false || w._edgeResult.valid === false) ? false : null))
        : null;
      // Multiple checks for robustness across page reloads:
      // 1. _protocolReady flag (set when verification succeeds, survives reloads)
      // 2. signedPdfUrl exists (file uploaded to Supabase Storage)
      // 3. signedPdfData exists (base64 in memory, may not survive reload)
      const hasProtocol = !!(w._protocolReady || w.signedPdfUrl || w.signedPdfPath || (w.signedPdfData && _wEdgeOk !== false));"""
new="""      // A protocol is accepted only when a signed PDF exists AND the server explicitly verified it cryptographically.
      const _wEdgeOk = w._edgeResult
        ? (w._edgeResult.verified === true ? true : (w._edgeResult.verified === false ? false : null))
        : null;
      const hasProtocol = !!((w.signedPdfUrl || w.signedPdfPath || w.signedPdfData) && _wEdgeOk === true && w._protocolReady === true);"""
assert s.count(old)==1, f'hasProtocol block count={s.count(old)}'
s=s.replace(old,new)

# 6. Bulk normalization/validity: explicit verified only.
old="""  const edgeOk=edgeResult
    ? ((edgeResult.verified===true || edgeResult.valid===true || edgeResult.certificatesOk===true)
        ? true
        : ((edgeResult.verified===false || edgeResult.valid===false) ? false : null))
    : null;"""
new="""  const edgeOk=edgeResult
    ? (edgeResult.verified===true ? true : (edgeResult.verified===false ? false : null))
    : null;"""
assert s.count(old)==1, f'bulk edge normalization count={s.count(old)}'
s=s.replace(old,new)

old="const isValid=sigCount>=req&&!edgeFailed&&(edgeOk===true || edgeOk===null);"
new="const isValid=sigCount>=req&&!edgeFailed&&edgeOk===true;"
assert s.count(old)==1, f'bulk isValid count={s.count(old)}'
s=s.replace(old,new)

# 7. Finalize single: crypto verification is mandatory before any count logic.
marker="""  let sigs = countPdfSignatures(wo.signedPdfData||'');
  const req = Math.max(1, (settings.eSignUsers||[]).filter(u=>u.name).length||3);"""
insert="""  if(!wo._edgeResult || wo._edgeResult.verified !== true){
    alert('🚫 Η παραλαβή δεν μπορεί να οριστικοποιηθεί χωρίς ρητή επιτυχή κρυπτογραφική επαλήθευση του PDF από τον server.');
    return;
  }
  let sigs = countPdfSignatures(wo.signedPdfData||'');
  const req = Math.max(1, (settings.eSignUsers||[]).filter(u=>u.name).length||3);"""
assert s.count(marker)==1, f'finalizeAcceptance signature marker count={s.count(marker)}'
s=s.replace(marker,insert)

# Remove admin override: insufficient required signatures always block.
pat=re.compile(r"  // v9\.19\.4 \(#5\): ΣΚΛΗΡΟ μπλοκ — η παραλαβή απαιτεί ΟΛΕΣ τις υπογραφές\..*?  // Check using Edge Function result ONLY if it explicitly rejected the PDF\.",re.S)
m=pat.search(s)
assert m,'admin override block not found'
s=pat.sub("""  // Gate E: all required signatures are mandatory; no administrative bypass is allowed.
  if(sigs < req){
    alert('🚫 Ανιχνεύθηκαν '+sigs+'/'+req+' ψηφιακές υπογραφές.\\n\\nΗ παραλαβή απαιτεί όλες τις υπογραφές (Άρθρο 9). Ανεβάστε το πλήρως υπογεγραμμένο πρωτόκολλο.');
    return;
  }

  // Server result was already required to be verified=true above.""",s,count=1)

# The legacy explicit-reject-only block is redundant after verified=true guard; remove if still present.
pat2=re.compile(r"\n  if\(wo\._edgeResult && \(wo\._edgeResult\.verified === false \|\| wo\._edgeResult\.valid === false\)\)\{.*?\n  \}\n",re.S)
s,n=pat2.subn('\n',s,count=1)
assert n==1, f'legacy explicit reject block removal count={n}'

# 8. Bulk finalize: explicit server verification and required count required before status changes.
marker="""  const bulkWo=window._bulkWo||{};
  const today=todayStr(); const d=new Date();"""
insert="""  const bulkWo=window._bulkWo||{};
  const edgeResult=bulkWo._edgeResult||null;
  if(!edgeResult || edgeResult.verified !== true){
    alert('🚫 Η μαζική παραλαβή δεν μπορεί να οριστικοποιηθεί χωρίς ρητή επιτυχή κρυπτογραφική επαλήθευση του PDF από τον server.');
    return;
  }
  const req=Math.max(1,(settings.eSignUsers||[]).filter(u=>u.name&&u.name.trim()).length||3);
  const serverCount=Number(edgeResult.count||edgeResult.signatureCount||((edgeResult.signers||[]).length)||0);
  if(serverCount < req){
    alert('🚫 Ο server επιβεβαίωσε μόνο '+serverCount+'/'+req+' απαιτούμενες υπογραφές. Η μαζική παραλαβή ακυρώθηκε.');
    return;
  }
  const today=todayStr(); const d=new Date();"""
assert s.count(marker)==1, f'bulk finalize marker count={s.count(marker)}'
s=s.replace(marker,insert)

# 9. Any generic _protocolReady assignment after final acceptance is okay ONLY after guard; local promotions must be gone.
# Security invariants.
for forbidden in [
    "_edgeOk === true || _edgeOk === null",
    "edgeOk===true || edgeOk===null",
    "verified === true || _edgeResult.valid === true",
    "verified===true || edgeResult.valid===true",
    "Force immediate receipt",
    "ADMIN OVERRIDE",
    "wo.sigOverride =",
    "συνέχιση με τοπικό έλεγχο",
]:
    assert forbidden not in s, f'forbidden fail-open signature pattern remains: {forbidden}'

# There may be display-only certificatesOk references, but it must not be in an authorization OR-expression.
assert "_result.verified === true || _result.valid === true || _result.certificatesOk === true" not in s
assert "w._edgeResult.verified === true || w._edgeResult.valid === true || w._edgeResult.certificatesOk === true" not in s
assert "edgeResult.verified===true || edgeResult.valid===true || edgeResult.certificatesOk===true" not in s
assert "wo._edgeResult.verified !== true" in s
assert "edgeResult.verified !== true" in s
assert "const isValid=sigCount>=req&&!edgeFailed&&edgeOk===true;" in s
assert s!=orig

path.write_text(s,encoding='utf-8')
print('Gate E fail-closed cryptographic signature patch applied successfully.')
