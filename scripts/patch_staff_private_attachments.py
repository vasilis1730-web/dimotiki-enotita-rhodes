from pathlib import Path

path = Path('aftepistasia.html')
s = path.read_text(encoding='utf-8')
original = s

# 1. Never persist short-lived signed URLs into DB/local cache.
needle = """    if(key==='signedPdfData' || key==='pdfData' || key==='base64' || key==='base64Data' || key==='dataUrl') return undefined;
    if(typeof val === 'string' && val.length > 250000 && val.startsWith('data:')) return undefined;"""
replacement = """    if(key==='signedPdfData' || key==='pdfData' || key==='base64' || key==='base64Data' || key==='dataUrl') return undefined;
    if(key==='url' && typeof val==='string' && val.includes('/storage/v1/object/sign/attachments/')) return undefined;
    if(typeof val === 'string' && val.length > 250000 && val.startsWith('data:')) return undefined;"""
assert s.count(needle) == 1, f'_safeCloneForDb marker count={s.count(needle)}'
s = s.replace(needle, replacement)

# 2. Add a batched signed-URL hydrator after _safeCloneForDb.
marker = """function _ensureId(obj, prefix){"""
assert s.count(marker) == 1, f'_ensureId marker count={s.count(marker)}'
helper = r'''
// v9.20 staging: private Storage attachments — URL is runtime-only, path is canonical.
function _v920CollectAttachmentRefs(value, out, seen){
  if(value===null || value===undefined) return;
  if(!out) out=[];
  if(!seen) seen=new Set();
  if(typeof value!=='object') return out;
  if(seen.has(value)) return out;
  seen.add(value);
  if(Array.isArray(value)){
    value.forEach(v=>_v920CollectAttachmentRefs(v,out,seen));
    return out;
  }
  const p=typeof value.path==='string'?value.path.trim():'';
  if(p && (value.stored==='supabase' || 'name' in value || 'type' in value || 'size' in value)) out.push(value);
  Object.keys(value).forEach(k=>_v920CollectAttachmentRefs(value[k],out,seen));
  return out;
}

async function _v920RefreshPrivateAttachmentUrls(){
  const sb=(typeof getSupabase==='function')?getSupabase():null;
  if(!sb) return;
  const refs=[];
  _v920CollectAttachmentRefs(issues||[],refs,new Set());
  _v920CollectAttachmentRefs(workOrders||[],refs,new Set());
  const byPath=new Map();
  refs.forEach(r=>{ if(r&&r.path) byPath.set(String(r.path),r); });
  const paths=Array.from(byPath.keys());
  if(!paths.length) return;
  const urlMap=new Map();
  for(let i=0;i<paths.length;i+=100){
    const part=paths.slice(i,i+100);
    const {data,error}=await sb.storage.from('attachments').createSignedUrls(part,3600);
    if(error){ console.warn('[private attachments] signed URL batch failed',error); continue; }
    (data||[]).forEach((d,idx)=>{
      const p=(d&&d.path)||part[idx];
      const u=d&&(d.signedUrl||d.signedURL);
      if(p&&u) urlMap.set(String(p),String(u));
    });
  }
  refs.forEach(r=>{ const u=urlMap.get(String(r.path||'')); if(u) r.url=u; });
}

'''
s = s.replace(marker, helper + marker)

# 3. Hydrate URLs immediately after each full DB refresh.
block1 = """    issues = (issueRows||[]).map(r => ({...(r.data||{}), id: r.id}));
    workOrders = (orderRows||[]).map(r => ({...(r.data||{}), id: r.id, issueId: (r.data&&r.data.issueId) || r.issue_id || null}));
    payments = (paymentRows||[]).map(r => ({...(r.data||{}), id: r.id, orderId: (r.data&&r.data.orderId) || r.work_order_id || null}));"""
block1_new = block1 + "\n    await _v920RefreshPrivateAttachmentUrls();"
assert s.count(block1) == 1, f'initial DB mapping count={s.count(block1)}'
s = s.replace(block1, block1_new)

block2 = """    issues = (issueRows||[]).map(r=>({...(r.data||{}), id:r.id}));
    workOrders = (orderRows||[]).map(r=>({...(r.data||{}), id:r.id, issueId:(r.data&&r.data.issueId)||r.issue_id||null}));
    payments = (paymentRows||[]).map(r=>({...(r.data||{}), id:r.id, orderId:(r.data&&r.data.orderId)||r.work_order_id||null}));"""
block2_new = block2 + "\n    await _v920RefreshPrivateAttachmentUrls();"
assert s.count(block2) == 1, f'force-refresh DB mapping count={s.count(block2)}'
s = s.replace(block2, block2_new)

# 4. Order media upload: use signed URL instead of public URL.
old1 = """          .then(({error})=>{
            if(error) throw error;
            const {data:{publicUrl}} = sb.storage.from('attachments').getPublicUrl(path);
            item.url = publicUrl; item.path = path; item.stored='supabase';"""
new1 = """          .then(async ({error})=>{
            if(error) throw error;
            const {data:signed,error:signErr} = await sb.storage.from('attachments').createSignedUrl(path,3600);
            if(signErr || !signed || !signed.signedUrl) throw (signErr||new Error('Δεν δημιουργήθηκε ασφαλές URL συνημμένου'));
            item.url = signed.signedUrl; item.path = path; item.stored='supabase';"""
assert s.count(old1) == 1, f'order media public-url block count={s.count(old1)}'
s = s.replace(old1, new1)

# 5. Issue attachment upload: use signed URL.
old2 = """        // Get public URL
        const {data:{publicUrl}} = sb.storage.from('attachments').getPublicUrl(path);
        // Update attachment entry
        const idx = _issueAttachments.findIndex(a=>a.uploading&&a.name===file.name);
        if(idx>=0) _issueAttachments[idx] = {
          name:file.name, size:file.size, type:file.type,
          url:publicUrl, path:path, stored:'supabase'"""
new2 = """        // Private bucket: create a short-lived runtime URL; persist only path.
        const {data:signed,error:signErr} = await sb.storage.from('attachments').createSignedUrl(path,3600);
        if(signErr || !signed || !signed.signedUrl) throw (signErr||new Error('Δεν δημιουργήθηκε ασφαλές URL συνημμένου'));
        // Update attachment entry
        const idx = _issueAttachments.findIndex(a=>a.uploading&&a.name===file.name);
        if(idx>=0) _issueAttachments[idx] = {
          name:file.name, size:file.size, type:file.type,
          url:signed.signedUrl, path:path, stored:'supabase'"""
assert s.count(old2) == 1, f'issue attachment public-url block count={s.count(old2)}'
s = s.replace(old2, new2)

# 6. Pre-send base64 media upload: use signed URL.
old3 = """        const { data:{ publicUrl } } = sb.storage.from('attachments').getPublicUrl(path);
        arr[i] = {name:m.name||safe, type:m.type||'', url:publicUrl, path, stored:'supabase'};"""
new3 = """        const {data:signed,error:signErr} = await sb.storage.from('attachments').createSignedUrl(path,3600);
        if(signErr || !signed || !signed.signedUrl) throw (signErr||new Error('Δεν δημιουργήθηκε ασφαλές URL συνημμένου'));
        arr[i] = {name:m.name||safe, type:m.type||'', url:signed.signedUrl, path, stored:'supabase'};"""
assert s.count(old3) == 1, f'pre-send public-url block count={s.count(old3)}'
s = s.replace(old3, new3)

# 7. Guard against future accidental public URL use for this bucket.
assert "getPublicUrl(path)" not in s, 'getPublicUrl(path) remains in staff client'
assert "_v920RefreshPrivateAttachmentUrls" in s
assert "createSignedUrls(part,3600)" in s
assert s != original, 'Staff patch made no changes'

path.write_text(s, encoding='utf-8')
print('Staff private-attachment patch applied successfully.')
