from pathlib import Path

p=Path('aftepistasia.html')
s=p.read_text(encoding='utf-8')
old_early="""  let body = buildEmailBody(wo);
  if(wo.orderType !== 'service'){
    try { body += await buildAckCompletionText(wo); } catch(e){ console.error('ack link failed:', e); }
  }
  // Refresh from the linked request before sending, so old/stale copied attachments are corrected.
"""
new_early="""  let body = buildEmailBody(wo);
  // Gate H: do not create ACK tokens/rows before media validation succeeds.
  // Refresh from the linked request before sending, so old/stale copied attachments are corrected.
"""
old_after="""  if(unresolvedMedia.length) throw new Error('Υπάρχουν '+unresolvedMedia.length+' αρχεία εντολής που δεν μεταφορτώθηκαν στο ασφαλές Storage. Η αποστολή ακυρώθηκε.');
  // Body: request-attachment links (existing safety net).
"""
new_after="""  if(unresolvedMedia.length) throw new Error('Υπάρχουν '+unresolvedMedia.length+' αρχεία εντολής που δεν μεταφορτώθηκαν στο ασφαλές Storage. Η αποστολή ακυρώθηκε.');
  // Only after all media is durable may we create the contractor ACK capability.
  if(wo.orderType !== 'service'){
    try { body += await buildAckCompletionText(wo); } catch(e){ console.error('ack link failed:', e); }
  }
  // Body: request-attachment links (existing safety net).
"""
if s.count(old_early)!=1: raise SystemExit(f'early ACK block count={s.count(old_early)}')
if s.count(old_after)!=1: raise SystemExit(f'unresolved marker count={s.count(old_after)}')
s=s.replace(old_early,new_early,1).replace(old_after,new_after,1)
start=s.find('async function prepareContractorEmailPayload(wo){'); end=s.find('\n}\n',start)
chunk=s[start:end]
if chunk.find('await ensureOrderMediaUploaded(wo)') > chunk.find('await buildAckCompletionText(wo)'):
    raise SystemExit('ACK still before media validation')
p.write_text(s,encoding='utf-8')
print('E2E email ACK ordering fixed')
