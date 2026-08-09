from pathlib import Path
import re

path=Path('aftepistasia.html')
s=path.read_text(encoding='utf-8')
orig=s

# ---- ISSUE ATTACHMENTS: replace upload routine with retryable in-memory File state ----
pat=re.compile(r"async function addIssueAttachments\(input\)\{.*?\n\}\n\nfunction renderIssueAttachList\(\)\{",re.S)
m=pat.search(s)
assert m and len(pat.findall(s))==1,'Gate D: issue upload block not uniquely found'
new=r'''async function _uploadIssueAttachmentAt(idx){
  const a=_issueAttachments[idx];
  if(!a || !a._file) return false;
  a.uploading=true; a.upload_failed=false; renderIssueAttachList();
  try{
    const sb=getSupabase();
    if(!sb || !isSupabaseConfigured()) throw new Error('Δεν υπάρχει ενεργή σύνδεση με Supabase.');
    const safe=(a.name||'file').replace(/[^a-zA-Z0-9._-]/g,'_');
    const p='issues/'+Date.now()+'_'+Math.random().toString(36).slice(2,8)+'_'+safe;
    const {error}=await sb.storage.from('attachments').upload(p,a._file,{cacheControl:'3600',upsert:false,contentType:a.type||'application/octet-stream'});
    if(error) throw error;
    const {data:signed,error:signErr}=await sb.storage.from('attachments').createSignedUrl(p,3600);
    if(signErr||!signed||!signed.signedUrl) throw (signErr||new Error('Δεν δημιουργήθηκε ασφαλές URL συνημμένου'));
    a.url=signed.signedUrl; a.path=p; a.stored='supabase';
    delete a._file; delete a.uploading; delete a.upload_failed; delete a.upload_error;
    renderIssueAttachList(); return true;
  }catch(err){
    console.warn('Issue attachment upload failed:',err);
    delete a.uploading; a.upload_failed=true; a.upload_error=(err&&err.message)||String(err);
    renderIssueAttachList(); return false;
  }
}

async function retryIssueAttachment(idx){
  const ok=await _uploadIssueAttachmentAt(idx);
  toast(ok?'✅ Το συνημμένο μεταφορτώθηκε.':'❌ Η μεταφόρτωση απέτυχε ξανά.');
}

async function addIssueAttachments(input){
  const files=Array.from(input.files||[]); input.value='';
  for(const file of files){
    const item={name:file.name,size:file.size,type:file.type,_file:file,uploading:true};
    _issueAttachments.push(item);
    const idx=_issueAttachments.length-1;
    renderIssueAttachList();
    await _uploadIssueAttachmentAt(idx);
  }
}

function renderIssueAttachList(){'''
s=pat.sub(new,s,count=1)

old="""    const icon = a.uploading ? '⏳' : isImg ? '🖼' : isPdf ? '📄' : '📎';
    const kb = Math.round((a.size||0)/1024);
    const storeBadge = a.stored==='supabase'
      ? '<span style=\"font-size:9px;background:#d1e7dd;color:#155724;padding:1px 5px;border-radius:3px;\">☁ Cloud</span>'
      : a.data ? '<span style=\"font-size:9px;background:#fff3cd;color:#856404;padding:1px 5px;border-radius:3px;\">📱 Τοπικό</span>'
      : '';"""
new="""    const icon = a.uploading ? '⏳' : a.upload_failed ? '⚠️' : isImg ? '🖼' : isPdf ? '📄' : '📎';
    const kb = Math.round((a.size||0)/1024);
    const storeBadge = a.stored==='supabase'
      ? '<span style=\"font-size:9px;background:#d1e7dd;color:#155724;padding:1px 5px;border-radius:3px;\">☁ Cloud</span>'
      : a.upload_failed ? '<span style=\"font-size:9px;background:#f8d7da;color:#842029;padding:1px 5px;border-radius:3px;\">⚠ Αποτυχία</span>'
      : a.uploading ? '<span style=\"font-size:9px;background:#cfe2ff;color:#084298;padding:1px 5px;border-radius:3px;\">⬆ Μεταφόρτωση</span>'
      : '';"""
assert s.count(old)==1,'Gate D: issue render badge marker not found'
s=s.replace(old,new)
# Add retry button beside controls by inserting before the remove button call pattern.
needle="""      +'<button type=\"button\" class=\"btn btn-sm\" onclick=\"removeIssueAttachment('+idx+')\" style=\"padding:2px 5px;color:var(--red);\">✕</button>'"""
if needle in s:
    repl="""      +(a.upload_failed?'<button type=\"button\" class=\"btn btn-sm\" onclick=\"retryIssueAttachment('+idx+')\" style=\"padding:2px 6px;color:var(--amber);\">↻ Retry</button>':'')
      +'<button type=\"button\" class=\"btn btn-sm\" onclick=\"removeIssueAttachment('+idx+')\" style=\"padding:2px 5px;color:var(--red);\">✕</button>'"""
    s=s.replace(needle,repl,1)

# Block issue save before number allocation.
needle="""  if(!_date||!_cat||!_title||!_loc){alert('Συμπληρώστε τα υποχρεωτικά πεδία (*).');return;}

  const _existingIssue"""
repl="""  if(!_date||!_cat||!_title||!_loc){alert('Συμπληρώστε τα υποχρεωτικά πεδία (*).');return;}
  if((_issueAttachments||[]).some(a=>a&&(a.uploading||a.upload_failed||a._file))){
    alert('⚠ Υπάρχει συνημμένο που δεν έχει μεταφορτωθεί επιτυχώς. Πατήστε Retry ή αφαιρέστε το πριν την αποθήκευση.'); return;
  }

  const _existingIssue"""
assert s.count(needle)==1,'Gate D: saveIssue guard marker not found'
s=s.replace(needle,repl)

# ---- ORDER MEDIA: flag failures, add retry helper and block save ----
# Modify upload failure/no-Supabase states.
old="""          .catch(err=>{ console.warn('Media upload failed, keeping base64:', err); delete item.uploading; renderThumbs(slot); });
      } else {
        delete item.uploading;
      }"""
new="""          .catch(err=>{ console.warn('Media upload failed:', err); delete item.uploading; item.upload_failed=true; item.upload_error=(err&&err.message)||String(err); renderThumbs(slot); });
      } else {
        delete item.uploading; item.upload_failed=true; item.upload_error='Δεν υπάρχει ενεργή σύνδεση με Supabase.';
      }"""
assert s.count(old)==1,'Gate D: media failure marker not found'
s=s.replace(old,new)

# Insert order-media retry helper before renderer.
marker="function renderThumbs(slot){"
assert s.count(marker)==1,'Gate D: renderThumbs marker not unique'
helper=r'''async function retryOrderMedia(slot,idx){
  const arr=slot==='before'?woMediaBefore:woMediaAfter;
  const m=arr[idx]; if(!m||!m.data) return;
  m.uploading=true; m.upload_failed=false; renderThumbs(slot);
  try{
    const sb=getSupabase(); if(!sb||!isSupabaseConfigured()) throw new Error('Δεν υπάρχει ενεργή σύνδεση με Supabase.');
    const blob=await (await fetch(m.data)).blob();
    const safe=(m.name||'photo').replace(/[^a-zA-Z0-9._-]/g,'_');
    const p='orders/'+Date.now()+'_'+Math.random().toString(36).slice(2,8)+'_'+safe;
    const {error}=await sb.storage.from('attachments').upload(p,blob,{cacheControl:'3600',upsert:false,contentType:m.type||blob.type||'image/jpeg'});
    if(error) throw error;
    const {data:signed,error:signErr}=await sb.storage.from('attachments').createSignedUrl(p,3600);
    if(signErr||!signed||!signed.signedUrl) throw (signErr||new Error('Δεν δημιουργήθηκε ασφαλές URL συνημμένου'));
    m.url=signed.signedUrl; m.path=p; m.stored='supabase'; delete m.data; delete m.uploading; delete m.upload_failed; delete m.upload_error;
    renderThumbs(slot); toast('✅ Η φωτογραφία μεταφορτώθηκε.');
  }catch(err){ delete m.uploading; m.upload_failed=true; m.upload_error=(err&&err.message)||String(err); renderThumbs(slot); toast('❌ Η μεταφόρτωση απέτυχε ξανά.'); }
}

function _hasUnresolvedOrderMedia(){
  return [woMediaBefore,woMediaAfter].some(arr=>(arr||[]).some(m=>m&&(m.uploading||m.upload_failed||(m.data&&!m.path))));
}

'''
s=s.replace(marker,helper+marker)

old="""    const badge = m.uploading ? `<div style=\"position:absolute;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;color:#fff;font-size:10px;\">⬆️…</div>` : '';
    return `<div class=\"photo-thumb\">${tag}${badge}<button class=\"del-thumb\" onclick=\"delMedia('${slot}',${idx})\">✕</button></div>`;"""
new="""    const badge = m.uploading ? `<div style=\"position:absolute;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;color:#fff;font-size:10px;\">⬆️…</div>`
      : m.upload_failed ? `<div style=\"position:absolute;left:2px;right:2px;bottom:2px;background:#842029;color:#fff;font-size:9px;padding:2px;border-radius:3px;text-align:center;\">⚠ Αποτυχία <button type=\"button\" onclick=\"event.stopPropagation();retryOrderMedia('${slot}',${idx})\" style=\"font-size:9px;margin-left:3px;\">Retry</button></div>` : '';
    return `<div class=\"photo-thumb\">${tag}${badge}<button class=\"del-thumb\" onclick=\"delMedia('${slot}',${idx})\">✕</button></div>`;"""
assert s.count(old)==1,'Gate D: renderThumbs badge block not found'
s=s.replace(old,new)

needle="""async function saveOrder(andPrint){
  if(currentUser && currentUser.canOrders===false){toast('⛔ Δεν έχετε δικαίωμα επεξεργασίας εντολών εργασίας.');return;}"""
repl=needle+"""
  if(_hasUnresolvedOrderMedia()){toast('⚠ Υπάρχουν φωτογραφίες/βίντεο που δεν μεταφορτώθηκαν. Πατήστε Retry ή αφαιρέστε τα πριν την αποθήκευση.');return;}"""
assert s.count(needle)==1,'Gate D: saveOrder marker not found'
s=s.replace(needle,repl)

# Email path must fail closed if any media remains local after retry attempt.
needle="""  await ensureOrderMediaUploaded(wo);
  // Body: request-attachment links"""
repl="""  await ensureOrderMediaUploaded(wo);
  const unresolvedMedia=[]
    .concat(Array.isArray(wo.mediaBefore)?wo.mediaBefore:[])
    .concat(Array.isArray(wo.mediaAfter)?wo.mediaAfter:[])
    .filter(m=>m&&(m.upload_failed||(m.data&&!m.path)));
  if(unresolvedMedia.length) throw new Error('Υπάρχουν '+unresolvedMedia.length+' αρχεία εντολής που δεν μεταφορτώθηκαν στο ασφαλές Storage. Η αποστολή ακυρώθηκε.');
  // Body: request-attachment links"""
assert s.count(needle)==1,'Gate D: email media guard marker not found'
s=s.replace(needle,repl)

# ensureOrderMediaUploaded catch must mark failure instead of silently swallowing.
old="""      }catch(e){ console.warn('media upload (pre-send) failed', e); }"""
new="""      }catch(e){ console.warn('media upload (pre-send) failed', e); m.upload_failed=true; m.upload_error=(e&&e.message)||String(e); }"""
assert s.count(old)==1,'Gate D: pre-send catch marker not found'
s=s.replace(old,new)

assert 'keeping base64' not in s
assert 'falling back to base64' not in s
assert 'retryIssueAttachment' in s and 'retryOrderMedia' in s and '_hasUnresolvedOrderMedia' in s
assert s!=orig
path.write_text(s,encoding='utf-8')
print('Gate D retry/fail-closed attachment patch applied successfully.')
