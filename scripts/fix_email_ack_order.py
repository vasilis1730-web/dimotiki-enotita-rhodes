from pathlib import Path

p=Path('aftepistasia.html')
s=p.read_text(encoding='utf-8')
orig=s

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
if s.count(old_early)!=1:
    raise SystemExit(f'expected one early ACK block, found {s.count(old_early)}')
s=s.replace(old_early,new_early,1)

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
if s.count(old_after)!=1:
    raise SystemExit(f'expected one unresolved-media marker, found {s.count(old_after)}')
s=s.replace(old_after,new_after,1)

func_start=s.find('async function prepareContractorEmailPayload(wo){')
func_end=s.find('\n}\n',func_start)
if func_start<0 or func_end<0:
    raise SystemExit('prepareContractorEmailPayload bounds not found')
chunk=s[func_start:func_end]
if chunk.find('await ensureOrderMediaUploaded(wo)') > chunk.find('await buildAckCompletionText(wo)'):
    raise SystemExit('ACK generation still occurs before media upload validation')
if chunk.count('buildAckCompletionText(wo)')!=1:
    raise SystemExit('unexpected ACK completion call count')
if s==orig:
    raise SystemExit('no changes produced')
p.write_text(s,encoding='utf-8')
print('email ACK ordering fixed')
