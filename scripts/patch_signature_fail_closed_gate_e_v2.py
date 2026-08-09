from pathlib import Path
import re

path=Path('aftepistasia.html')
s=path.read_text(encoding='utf-8')
orig=s

def one(old,new,label):
    global s
    c=s.count(old)
    assert c==1,f'{label}: expected 1 match, found {c}'
    s=s.replace(old,new,1)

def regex_one(pattern,replacement,label,flags=re.S):
    global s
    p=re.compile(pattern,flags)
    matches=list(p.finditer(s))
    assert len(matches)==1,f'{label}: expected 1 regex match, found {len(matches)}'
    s=p.sub(replacement,s,count=1)

# Local fallback: diagnostics only.
one("""    wo._edgeResult = {
      verified: null,
      valid: _sigs >= _req,
      count: _sigs,
      signers: localNames,
      message: message || 'Τοπικός έλεγχος: εντοπίστηκαν '+_sigs+'/'+_req+' ψηφιακές υπογραφές στο PDF.'
    };
    if(_sigs >= _req) wo._protocolReady = true;""",
"""    wo._edgeResult = {
      verified: null,
      valid: false,
      count: _sigs,
      signers: localNames,
      message: message || 'Τοπικός προκαταρκτικός έλεγχος: εντοπίστηκαν '+_sigs+'/'+_req+' υπογραφές. Απαιτείται κρυπτογραφική επαλήθευση από τον server.'
    };
    wo._protocolReady = false;""",'local fallback')

# Single-modal verification state.
one("""  const _edgeOk = _edgeResult
    ? ((_edgeResult.verified === true || _edgeResult.valid === true || _edgeResult.certificatesOk === true)
        ? true
        : ((_edgeResult.verified === false || _edgeResult.valid === false) ? false : null))
    : null;""",
"""  const _edgeOk = _edgeResult
    ? (_edgeResult.verified === true ? true : (_edgeResult.verified === false ? false : null))
    : null;""",'single edge state')

one("""  const isValid = hasSigned && _committeeConfigured && _localSigCountOk && !_edgeFailed
    && (_edgeOk === true || _edgeOk === null);
  const _verificationMode = _edgeOk === true ? 'crypto' : (isValid ? 'local' : 'pending');""",
"""  const isValid = hasSigned && _committeeConfigured && _localSigCountOk && !_edgeFailed
    && _edgeOk === true;
  const _verificationMode = isValid ? 'crypto' : 'pending';""",'single validity')

# Result processing: replace the complete fail-open subsection using structural markers.
regex_one(
    r"          // Set persistent flag if verification succeeded OR if Edge only reports valid=true.*?(?=\n        \}\n      \}\n      wo\._sigExtractedNames)",
"""          // Gate E: fail closed. Only explicit server cryptographic verification authorizes the protocol.
          wo._protocolReady = (_result.verified === true);
          if(_result.verified === true){
            toast('✅ Κρυπτογραφική επαλήθευση: ΕΓΚΥΡΟ — '+(_extractedNames.join(', ')||(_sigs+'/'+_req+' υπογραφές')));
          } else if(_result.verified === false){
            toast('❌ Κρυπτογραφική επαλήθευση: ΑΠΟΡΡΙΦΘΗΚΕ — '+(_result.message||'Μη έγκυρο PDF'));
          } else {
            toast('⏳ Δεν υπάρχει οριστικό κρυπτογραφικό αποτέλεσμα. Η παραλαβή παραμένει κλειδωμένη.');
          }""",'verification response')

# Post-processing/local signer merge must not promote validity.
one("""  if(!wo._edgeResult){
    wo._edgeResult = {verified:null, valid:_sigs>=_req, count:_sigs, signers:_allNames, message:'Τοπικός έλεγχος: εντοπίστηκαν '+_sigs+'/'+_req+' ψηφιακές υπογραφές στο PDF.'};
  } else {
    if(!Array.isArray(wo._edgeResult.signers) || !wo._edgeResult.signers.length) wo._edgeResult.signers = _allNames;
    if(!wo._edgeResult.count || wo._edgeResult.count < _sigs) wo._edgeResult.count = _sigs;
    if(_sigs >= _req && wo._edgeResult.verified !== false && wo._edgeResult.valid !== false){
      wo._edgeResult.valid = true;
      wo._protocolReady = true;
      if(!wo._edgeResult.message) wo._edgeResult.message = 'Τοπικός έλεγχος: εντοπίστηκαν '+_sigs+'/'+_req+' ψηφιακές υπογραφές στο PDF.';
    }
  }""",
"""  if(!wo._edgeResult){
    wo._edgeResult = {verified:null, valid:false, count:_sigs, signers:_allNames, message:'Τοπικός προκαταρκτικός έλεγχος: εντοπίστηκαν '+_sigs+'/'+_req+' υπογραφές. Αναμένεται κρυπτογραφική επαλήθευση.'};
    wo._protocolReady = false;
  } else {
    if(!Array.isArray(wo._edgeResult.signers) || !wo._edgeResult.signers.length) wo._edgeResult.signers = _allNames;
    if(!wo._edgeResult.count || wo._edgeResult.count < _sigs) wo._edgeResult.count = _sigs;
    wo._protocolReady = (wo._edgeResult.verified === true);
  }""",'local promotion')

# Order list readiness is verified-server-only.
one("""      // hasProtocol = PDF exists AND edge function verified it (or no edge result yet)
      const _wEdgeOk = w._edgeResult
        ? ((w._edgeResult.verified === true || w._edgeResult.valid === true || w._edgeResult.certificatesOk === true)
            ? true
            : ((w._edgeResult.verified === false || w._edgeResult.valid === false) ? false : null))
        : null;
      // Multiple checks for robustness across page reloads:
      // 1. _protocolReady flag (set when verification succeeds, survives reloads)
      // 2. signedPdfUrl exists (file uploaded to Supabase Storage)
      // 3. signedPdfData exists (base64 in memory, may not survive reload)
      const hasProtocol = !!(w._protocolReady || w.signedPdfUrl || w.signedPdfPath || (w.signedPdfData && _wEdgeOk !== false));""",
"""      // Gate E: a protocol is ready only if a PDF exists and the server explicitly verified it cryptographically.
      const _wEdgeOk = w._edgeResult
        ? (w._edgeResult.verified === true ? true : (w._edgeResult.verified === false ? false : null))
        : null;
      const hasProtocol = !!((w.signedPdfUrl || w.signedPdfPath || w.signedPdfData) && _wEdgeOk === true && w._protocolReady === true);""",'order readiness')

# Bulk modal.
one("""  const edgeOk=edgeResult
    ? ((edgeResult.verified===true || edgeResult.valid===true || edgeResult.certificatesOk===true)
        ? true
        : ((edgeResult.verified===false || edgeResult.valid===false) ? false : null))
    : null;""",
"""  const edgeOk=edgeResult
    ? (edgeResult.verified===true ? true : (edgeResult.verified===false ? false : null))
    : null;""",'bulk edge state')
one("const isValid=sigCount>=req&&!edgeFailed&&(edgeOk===true || edgeOk===null);",
    "const isValid=sigCount>=req&&!edgeFailed&&edgeOk===true;",'bulk validity')

# Single acceptance: server verification first.
one("""  let sigs = countPdfSignatures(wo.signedPdfData||'');
  const req = Math.max(1, (settings.eSignUsers||[]).filter(u=>u.name).length||3);""",
"""  if(!wo._edgeResult || wo._edgeResult.verified !== true){
    alert('🚫 Η παραλαβή δεν μπορεί να οριστικοποιηθεί χωρίς ρητή επιτυχή κρυπτογραφική επαλήθευση του PDF από τον server.');
    return;
  }
  let sigs = countPdfSignatures(wo.signedPdfData||'');
  const req = Math.max(1, (settings.eSignUsers||[]).filter(u=>u.name).length||3);""",'single finalize crypto guard')

# Remove the whole admin override section up to the old explicit-edge-reject comment.
regex_one(
    r"  // v9\.19\.4 \(#5\): ΣΚΛΗΡΟ μπλοκ — η παραλαβή απαιτεί ΟΛΕΣ τις υπογραφές\..*?  // Check using Edge Function result ONLY if it explicitly rejected the PDF\.",
"""  // Gate E: all required signatures are mandatory; no administrative bypass is allowed.
  if(sigs < req){
    alert('🚫 Ανιχνεύθηκαν '+sigs+'/'+req+' ψηφιακές υπογραφές.\\n\\nΗ παραλαβή απαιτεί όλες τις υπογραφές (Άρθρο 9). Ανεβάστε το πλήρως υπογεγραμμένο πρωτόκολλο.');
    return;
  }

  // Server result was already required to be verified=true above.""",'admin override removal')

# Remove redundant legacy rejection block that followed that comment.
regex_one(
    r"\n  if\(wo\._edgeResult && \(wo\._edgeResult\.verified === false \|\| wo\._edgeResult\.valid === false\)\)\{.*?\n  \}\n",
    '\n','legacy reject block')

# Bulk finalization: no finalization without explicit crypto verification and enough server-reported signatures.
one("""  const bulkWo=window._bulkWo||{};
  const today=todayStr(); const d=new Date();""",
"""  const bulkWo=window._bulkWo||{};
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
  const today=todayStr(); const d=new Date();""",'bulk finalize crypto guard')

# Security invariants: no known fail-open authorizers remain.
for forbidden in [
    "_edgeOk === true || _edgeOk === null",
    "edgeOk===true || edgeOk===null",
    "_edgeResult.verified === true || _edgeResult.valid === true || _edgeResult.certificatesOk === true",
    "edgeResult.verified===true || edgeResult.valid===true || edgeResult.certificatesOk===true",
    "w._edgeResult.verified === true || w._edgeResult.valid === true || w._edgeResult.certificatesOk === true",
    "wo.sigOverride =",
    "ADMIN OVERRIDE",
    "συνέχιση με τοπικό έλεγχο",
]:
    assert forbidden not in s,f'forbidden fail-open pattern remains: {forbidden}'

assert "wo._edgeResult.verified !== true" in s
assert "edgeResult.verified !== true" in s
assert "const isValid=sigCount>=req&&!edgeFailed&&edgeOk===true;" in s
assert "wo._protocolReady = (_result.verified === true);" in s
assert s!=orig
path.write_text(s,encoding='utf-8')
print('Gate E v2 fail-closed cryptographic signature patch applied successfully.')
