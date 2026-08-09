from pathlib import Path
import re

path = Path('index.html')
s = path.read_text(encoding='utf-8')
original = s

# 1. Dedicated Firebase-authenticated attachment endpoint.
needle = "const BRIDGE_URL = SUPABASE_URL + '/functions/v1/citizen-bridge';"
assert s.count(needle) == 1, f'Expected exactly one BRIDGE_URL marker, found {s.count(needle)}'
s = s.replace(needle, needle + "\nconst CITIZEN_ATTACHMENTS_URL = SUPABASE_URL + '/functions/v1/citizen-attachments';")

# 2. Helpers for private attachment signed URLs. Insert immediately before FILE UPLOAD.
marker = "// ════════════════ FILE UPLOAD ════════════════"
assert s.count(marker) == 1, f'Expected exactly one FILE UPLOAD marker, found {s.count(marker)}'
helpers = r'''// ════════════════ PRIVATE ATTACHMENTS (v9.20 staging) ════════════════
async function callCitizenAttachmentsJson(action, payload){
  const idToken = await getIdToken();
  if(!idToken) return {ok:false,noAuth:true};
  try{
    const res = await fetch(CITIZEN_ATTACHMENTS_URL, {
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'apikey':SUPABASE_KEY,
        'x-firebase-id-token':idToken
      },
      body:JSON.stringify(Object.assign({action},payload||{}))
    });
    let data=null; try{ data=await res.json(); }catch(_){}
    return res.ok ? {ok:true,data:data||{}} : {ok:false,status:res.status,error:(data&&data.error)||('HTTP '+res.status)};
  }catch(e){
    console.warn('citizen-attachments request failed',e);
    return {ok:false,error:(e&&e.message)||String(e)};
  }
}

async function hydrateCitizenAttachmentUrls(issueList){
  const list=Array.isArray(issueList)?issueList:[];
  const paths=[];
  list.forEach(iss=>(iss&&Array.isArray(iss.attachments)?iss.attachments:[]).forEach(a=>{
    if(a&&a.path&&!paths.includes(a.path)) paths.push(a.path);
  }));
  if(!paths.length) return;
  const r=await callCitizenAttachmentsJson('sign',{paths:paths.slice(0,50)});
  if(!r.ok||!r.data||!r.data.urls){
    console.warn('Could not refresh private attachment URLs',r.error||r.status||'unknown');
    return;
  }
  list.forEach(iss=>(iss&&Array.isArray(iss.attachments)?iss.attachments:[]).forEach(a=>{
    if(a&&a.path&&r.data.urls[a.path]) a.url=r.data.urls[a.path];
  }));
}

'''
s = s.replace(marker, helpers + marker)

# 3. Replace direct anonymous Storage upload with Firebase-authenticated Edge upload.
pattern = re.compile(r"async function handleFiles\(fileList\)\{.*?\nfunction removeAttachment\(id\)\{.*?\}\nfunction renderAttachments", re.S)
match = pattern.search(s)
assert match, 'Could not locate handleFiles/removeAttachment block uniquely'
assert len(pattern.findall(s)) == 1, f'Expected one handleFiles block, found {len(pattern.findall(s))}'
replacement = r'''async function handleFiles(fileList){
  const files=Array.from(fileList||[]);
  if(!files.length) return;
  for(const f of files){
    if(f.size>50*1024*1024){ toast('Το «'+f.name+'» ξεπερνά τα 50MB.'); continue; }
    const tmpId='att_'+genId();
    pendingAttachments.push({_id:tmpId,name:f.name,type:f.type,size:f.size,url:null,path:null,uploading:true,_newUpload:true});
    renderAttachments();
    try{
      const idToken=await getIdToken();
      if(!idToken) throw new Error('Η σύνδεση έληξε. Συνδεθείτε ξανά.');
      const fd=new FormData();
      fd.append('action','upload');
      fd.append('file',f,f.name);
      const res=await fetch(CITIZEN_ATTACHMENTS_URL,{
        method:'POST',
        headers:{'apikey':SUPABASE_KEY,'x-firebase-id-token':idToken},
        body:fd
      });
      let data=null; try{data=await res.json();}catch(_){}
      if(!res.ok||!data||!data.ok||!data.attachment) throw new Error((data&&data.error)||('HTTP '+res.status));
      const item=pendingAttachments.find(a=>a._id===tmpId);
      if(item){
        item.path=data.attachment.path;
        item.name=data.attachment.name||f.name;
        item.type=data.attachment.type||f.type||'';
        item.size=data.attachment.size||f.size;
        item.uploading=false;
        // URL is intentionally short-lived and never persisted for private files.
        const signed=await callCitizenAttachmentsJson('sign',{paths:[item.path]});
        if(signed.ok&&signed.data&&signed.data.urls) item.url=signed.data.urls[item.path]||null;
      }
    }catch(e){
      console.warn('secure attachment upload failed',e);
      pendingAttachments=pendingAttachments.filter(a=>a._id!==tmpId);
      toast('❌ Αποτυχία μεταφόρτωσης «'+f.name+'»');
    }
    renderAttachments();
  }
  document.getElementById('i_fileInput').value='';
}
async function removeAttachment(id){
  const item=pendingAttachments.find(a=>a._id===id);
  pendingAttachments=pendingAttachments.filter(a=>a._id!==id);
  renderAttachments();
  // Delete only files uploaded during the current unsaved form session.
  // Existing attachments are not deleted merely by removing them from an edit form.
  if(item&&item._newUpload&&item.path){
    const r=await callCitizenAttachmentsJson('remove',{path:item.path});
    if(!r.ok) console.warn('Could not clean unsaved attachment',r.error||r.status||'unknown');
  }
}
function renderAttachments'''
s = pattern.sub(replacement, s, count=1)

# 4. Persist path, not expiring signed URL, for new private attachments.
old_atts = "atts:pendingAttachments.filter(a=>!a.uploading && a.url).map(a=>({name:a.name,type:a.type,size:a.size,url:a.url,path:a.path}))"
new_atts = "atts:pendingAttachments.filter(a=>!a.uploading && (a.path||a.url)).map(a=>({name:a.name,type:a.type,size:a.size,path:a.path||null,url:a.path?null:(a.url||null)}))"
assert s.count(old_atts) == 1, f'Expected one collectForm attachment mapping, found {s.count(old_atts)}'
s = s.replace(old_atts, new_atts)

# 5. Refresh signed URLs whenever canonical issue records return from the bridge.
old_return = "if(r.ok && r.data && r.data.issue) return r.data.issue;"
assert s.count(old_return) == 2, f'Expected two canonical issue returns, found {s.count(old_return)}'
s = s.replace(old_return, "if(r.ok && r.data && r.data.issue){ await hydrateCitizenAttachmentUrls([r.data.issue]); return r.data.issue; }")

old_list = "myIssues = r.data.issues;   // server already filtered to this caller's phone\n    renderIssues(); return;"
new_list = "myIssues = r.data.issues;   // server already filtered to this caller's phone\n    await hydrateCitizenAttachmentUrls(myIssues);\n    renderIssues(); return;"
assert s.count(old_list) == 1, f'Expected one loadMyIssues assignment, found {s.count(old_list)}'
s = s.replace(old_list, new_list)

# 6. Private URL display fails closed instead of creating blank/unsafe links.
old_map = """const isImg=(a.type||'').startsWith('image/');
            if(isImg) return '<a href=\"'+esc(a.url)+'\" target=\"_blank\"><img class=\"att-thumb\" src=\"'+esc(a.url)+'\" alt=\"\"></a>';
            return '<a class=\"att-file\" href=\"'+esc(a.url)+'\" target=\"_blank\">📎 '+esc((a.name||'αρχείο').slice(0,22))+'</a>';"""
new_map = """const isImg=(a.type||'').startsWith('image/');
            if(!a.url) return '<span class=\"att-file\" title=\"Το προσωρινό ασφαλές URL δεν είναι διαθέσιμο\">🔒 '+esc((a.name||'αρχείο').slice(0,22))+'</span>';
            if(isImg) return '<a href=\"'+esc(a.url)+'\" target=\"_blank\" rel=\"noopener\"><img class=\"att-thumb\" src=\"'+esc(a.url)+'\" alt=\"\"></a>';
            return '<a class=\"att-file\" href=\"'+esc(a.url)+'\" target=\"_blank\" rel=\"noopener\">📎 '+esc((a.name||'αρχείο').slice(0,22))+'</a>';"""
assert s.count(old_map) == 1, f'Expected one attachment preview renderer, found {s.count(old_map)}'
s = s.replace(old_map, new_map)

assert s != original, 'Patch made no changes'
assert "sb.storage.from('attachments').upload(path,f" not in s, 'Legacy direct citizen Storage upload still present'
assert "getPublicUrl(path)" not in s, 'Legacy citizen public URL generation still present'
assert "CITIZEN_ATTACHMENTS_URL" in s
assert "hydrateCitizenAttachmentUrls" in s

path.write_text(s, encoding='utf-8')
print('Citizen private-attachment patch applied successfully.')
