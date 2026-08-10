from pathlib import Path

p=Path('aftepistasia.html')
s=p.read_text(encoding='utf-8')
orig=s

single_old="body: JSON.stringify({ pdfBase64: wo.signedPdfData||'' })"
single_new="body: JSON.stringify({ pdfBase64: wo.signedPdfData||'', workOrderIds:[wo.id], signedPdfPath:wo.signedPdfPath||'', pdfName:wo.signedPdfName||file.name||'' })"
if s.count(single_old)!=1: raise SystemExit(f'single verifier body count={s.count(single_old)}')
s=s.replace(single_old,single_new,1)

bulk_old="body:JSON.stringify({pdfBase64:b64})"
bulk_new="body:JSON.stringify({pdfBase64:b64,workOrderIds:orders.map(w=>w.id),pdfName:file.name||''})"
if s.count(bulk_old)!=1: raise SystemExit(f'bulk verifier body count={s.count(bulk_old)}')
s=s.replace(bulk_old,bulk_new,1)

single_result_old="""          wo._edgeResult = _result;
          const _edgeCount = Number(_result.count || _result.signatureCount || 0);"""
single_result_new="""          wo._edgeResult = _result;
          if(_result.protocolPath){ wo.signedPdfPath=_result.protocolPath; wo.signedPdfBucket='protocols'; }
          const _edgeCount = Number(_result.count || _result.signatureCount || 0);"""
if s.count(single_result_old)!=1: raise SystemExit('single result marker missing')
s=s.replace(single_result_old,single_result_new,1)

bulk_result_old="""  window._bulkWo._edgeResult=edgeResult;
  renderBulkResultModal(orders,edgeResult,file.name,b64);"""
bulk_result_new="""  window._bulkWo._edgeResult=edgeResult;
  if(edgeResult&&edgeResult.protocolPath){ window._bulkWo.signedPdfPath=edgeResult.protocolPath; window._bulkWo.signedPdfBucket='protocols'; }
  renderBulkResultModal(orders,edgeResult,file.name,b64);"""
if s.count(bulk_result_old)!=1: raise SystemExit('bulk result marker missing')
s=s.replace(bulk_result_old,bulk_result_new,1)

single_start=s.find('async function finalizeAcceptance(){')
single_end=s.find('\n}\n\nfunction renderESignUsersSettings',single_start)
if single_start<0 or single_end<0: raise SystemExit('single acceptance bounds missing')
single_end+=2
single_replacement=r'''function _mergeAcceptanceRows(target,rows){
  if(!Array.isArray(rows)) return;
  rows.forEach(row=>{
    if(!row||!row.id)return;
    const idx=target.findIndex(x=>x&&x.id===row.id);
    if(idx>=0) target[idx]=row;
    else target.push(row);
  });
}
async function _finalizeVerifiedAcceptanceRpc(orderIds,edgeResult){
  const ids=[...new Set((orderIds||[]).map(x=>String(x||'').trim()).filter(Boolean))].sort();
  if(!ids.length) throw new Error('Δεν υπάρχουν εντολές προς παραλαβή.');
  const proofId=String(edgeResult&&edgeResult.verificationProofId||'').trim();
  if(!proofId) throw new Error('Η κρυπτογραφική επαλήθευση δεν διαθέτει server proof. Επαληθεύστε ξανά το PDF.');
  const sb=getSupabase();
  if(!sb) throw new Error('Δεν υπάρχει σύνδεση με τη βάση.');
  const {data,error}=await sb.rpc('rodios_finalize_verified_acceptance',{p_proof_id:proofId,p_expected_order_ids:ids});
  if(error) throw error;
  if(!data||data.ok!==true) throw new Error('Η βάση δεν επιβεβαίωσε την παραλαβή.');
  _mergeAcceptanceRows(workOrders,data.orders);
  _mergeAcceptanceRows(issues,data.issues);
  _mergeAcceptanceRows(payments,data.payments);
  return data;
}
async function finalizeAcceptance(){
  const wo = workOrders.find(w=>w.id===_sigOrderId);
  if(!wo) return;
  if(!wo.signedPdfData && !wo.signedPdfUrl && !wo.signedPdfPath){
    if(wo.signedPdfName){
      alert('⚠ Το υπογεγραμμένο PDF «'+wo.signedPdfName+'» δεν βρέθηκε αποθηκευμένο.\n\nΤο πρωτόκολλο ΔΕΝ μπορεί να παραληφθεί. Ανεβάστε ξανά το PDF.');
    } else alert('Εισάγετε πρώτα το υπογεγραμμένο PDF.');
    return;
  }
  if(!wo._edgeResult || wo._edgeResult.verified !== true){
    alert('🚫 Η παραλαβή δεν μπορεί να οριστικοποιηθεί χωρίς ρητή επιτυχή κρυπτογραφική επαλήθευση του PDF από τον server.');
    return;
  }
  let sigs=countPdfSignatures(wo.signedPdfData||'');
  const req=Math.max(1,(settings.eSignUsers||[]).filter(u=>u.name).length||3);
  if(sigs===0) sigs=Number(wo._edgeSigCount||(wo._edgeResult&&(wo._edgeResult.count||wo._edgeResult.signatureCount))||((wo._sigExtractedNames||[]).length)||0);
  if(sigs<req){
    alert('🚫 Ανιχνεύθηκαν '+sigs+'/'+req+' ψηφιακές υπογραφές.\n\nΗ παραλαβή απαιτεί όλες τις υπογραφές (Άρθρο 9). Ανεβάστε το πλήρως υπογεγραμμένο πρωτόκολλο.');
    return;
  }
  if(!wo._edgeResult.verificationProofId){
    alert('🚫 Η επαλήθευση είναι παλαιού τύπου ή έχει λήξει. Πατήστε «↩ Επανεκκίνηση» και επαληθεύστε ξανά το PDF ώστε να εκδοθεί server proof.');
    return;
  }
  try{
    const result=await _finalizeVerifiedAcceptanceRpc([wo.id],wo._edgeResult);
    closeSigModal();
    renderAll();
    const created=(result.payments||[]).length;
    toast('✅ Η παραλαβή αποθηκεύτηκε ατομικά στη βάση'+(created?' — δημιουργήθηκε αυτόματα η χρέωση.':'.'));
  }catch(e){
    console.error('[ACCEPT] transactional acceptance failed:',e);
    alert('❌ Η παραλαβή ΔΕΝ ολοκληρώθηκε και δεν έγινε τοπική αλλαγή κατάστασης.\n\n'+((e&&e.message)||e)+'\n\nΕπαληθεύστε ξανά το PDF αν το proof έληξε ή η εντολή άλλαξε.');
  }
}'''
s=s[:single_start]+single_replacement+s[single_end:]

bulk_start=s.find('async function finalizeBulkAcceptance(){')
bulk_end=s.find('\n}\nfunction printBulkProtocol',bulk_start)
if bulk_start<0 or bulk_end<0: raise SystemExit('bulk acceptance bounds missing')
bulk_end+=2
bulk_replacement=r'''async function finalizeBulkAcceptance(){
  const orders=workOrders.filter(w=>_bulkSelected.has(w.id));
  if(!orders.length)return;
  if(!confirm('Ολοκλήρωση μαζικής παραλαβής για '+orders.length+' εντολές;'))return;
  const bulkWo=window._bulkWo||{};
  const edgeResult=bulkWo._edgeResult||null;
  if(!edgeResult || edgeResult.verified !== true){
    alert('🚫 Η μαζική παραλαβή δεν μπορεί να οριστικοποιηθεί χωρίς ρητή επιτυχή κρυπτογραφική επαλήθευση του PDF από τον server.');
    return;
  }
  const req=Math.max(1,(settings.eSignUsers||[]).filter(u=>u.name&&u.name.trim()).length||3);
  const serverCount=Number(edgeResult.count||edgeResult.signatureCount||((edgeResult.signers||[]).length)||0);
  if(serverCount<req){
    alert('🚫 Ο server επιβεβαίωσε μόνο '+serverCount+'/'+req+' απαιτούμενες υπογραφές. Η μαζική παραλαβή ακυρώθηκε.');
    return;
  }
  if(!edgeResult.verificationProofId){
    alert('🚫 Δεν υπάρχει server proof για το συγκεκριμένο σύνολο εντολών. Επαληθεύστε ξανά το κοινό PDF.');
    return;
  }
  const ids=orders.map(w=>w.id).sort();
  try{
    const result=await _finalizeVerifiedAcceptanceRpc(ids,edgeResult);
    _bulkSelected.clear(); window._bulkWo=null;
    closeSigModal(); renderAll(); updateBulkBar();
    toast('✅ Μαζική παραλαβή '+orders.length+' εντολών αποθηκεύτηκε ατομικά στη βάση ('+(result.payments||[]).length+' νέες χρεώσεις).');
  }catch(e){
    console.error('[BULK ACCEPT] transactional acceptance failed:',e);
    alert('❌ Η μαζική παραλαβή ΔΕΝ ολοκληρώθηκε και δεν άλλαξε τοπικά καμία εντολή.\n\n'+((e&&e.message)||e)+'\n\nΑν άλλαξε η επιλογή εντολών ή έληξε το proof, επαληθεύστε ξανά το κοινό PDF.');
  }
}'''
s=s[:bulk_start]+bulk_replacement+s[bulk_end:]

for marker in ['workOrderIds:[wo.id]','workOrderIds:orders.map(w=>w.id)','rodios_finalize_verified_acceptance','verificationProofId','δεν έγινε τοπική αλλαγή κατάστασης']:
    if marker not in s: raise SystemExit('missing invariant: '+marker)
if "wo.status='Παραλήφθηκε'; wo.completionDate=today" in s: raise SystemExit('old bulk local acceptance remains')
if s==orig: raise SystemExit('no E2E client changes produced')
p.write_text(s,encoding='utf-8')
print('E2E server-authoritative acceptance client patch applied')
