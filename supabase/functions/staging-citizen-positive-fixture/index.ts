import { createClient } from "npm:@supabase/supabase-js@2.110.9";

const PROD_REF="nzrdcgmrsfdmocyhfrod";
function refOf(url:string){try{return new URL(url).hostname.split('.')[0]||''}catch{return ''}}
function digits(v:unknown){return String(v||'').replace(/\D/g,'')}
function response(body:unknown,status=200){return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json','cache-control':'no-store'}})}

Deno.serve(async(req:Request)=>{
  const url=Deno.env.get('SUPABASE_URL')||'';
  const key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||Deno.env.get('SUPABASE_SECRET_KEY')||'';
  const ref=refOf(url);
  if(!url||!key||!ref||ref===PROD_REF)return response({ok:false,error:'REFUSED: non-preview runtime'},403);
  const admin=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:settings,error:settingsError}=await admin.from('rodios_settings').select('value').eq('key','main').maybeSingle();
  if(settingsError||settings?.value?.staging!==true)return response({ok:false,error:'REFUSED: database is not staging:true'},403);
  if(req.method==='GET')return response({ok:true,ready:true,previewRef:ref});
  if(req.method!=='POST')return response({ok:false,error:'Method not allowed'},405);
  let body:any;try{body=await req.json()}catch{return response({ok:false,error:'Invalid JSON'},400)}
  const action=String(body?.action||'');

  if(action==='seedLegacy'){
    const phone=digits(body?.phone);
    if(phone.length<10||phone.length>15)return response({ok:false,error:'Invalid test phone'},400);
    const run=crypto.randomUUID().replace(/-/g,'').slice(0,16);
    const matchingId=`cit_legacy_match_${run}`;
    const otherId=`cit_legacy_other_${run}`;
    const now=new Date().toISOString();
    const otherPhone=phone==='306900000001'?'306900000002':'306900000001';
    const rows=[
      {id:matchingId,data:{id:matchingId,citizenRef:'910001',source:'citizen',createdAt:now,serverReceivedAt:now,citizenName:'STAGING LEGACY MATCH',citizenMobile:phone,citizenPhone:phone,contactInfo:`📱 ${phone}`,municipality:'Ρόδος',category:'Οδοποιία',title:'STAGING legacy matching phone',location:'STAGING',description:'Legacy ownership integration fixture',status:'Προς ενέργεια',attachments:[]}},
      {id:otherId,data:{id:otherId,citizenRef:'910002',source:'citizen',createdAt:now,serverReceivedAt:now,citizenName:'STAGING LEGACY OTHER',citizenMobile:otherPhone,citizenPhone:otherPhone,contactInfo:`📱 ${otherPhone}`,municipality:'Ρόδος',category:'Οδοποιία',title:'STAGING legacy other phone',location:'STAGING',description:'Legacy isolation integration fixture',status:'Προς ενέργεια',attachments:[]}},
    ];
    const {error}=await admin.from('rodios_issues').insert(rows);
    if(error)return response({ok:false,error:error.message},500);
    return response({ok:true,matchingId,otherId});
  }

  if(action==='inspect'){
    const ids=Array.isArray(body?.ids)?body.ids.map((x:unknown)=>String(x||'')).filter(Boolean).slice(0,20):[];
    const {data,error}=await admin.from('rodios_issues').select('id,data,deleted_at').in('id',ids);
    if(error)return response({ok:false,error:error.message},500);
    return response({ok:true,rows:(data||[]).map((r:any)=>({id:r.id,authUid:String(r.data?.citizenAuthUid||''),title:String(r.data?.title||''),deleted:r.deleted_at!==null}))});
  }

  if(action==='cleanup'){
    const ids=Array.isArray(body?.ids)?body.ids.map((x:unknown)=>String(x||'')).filter(Boolean).slice(0,50):[];
    const paths=Array.isArray(body?.paths)?body.paths.map((x:unknown)=>String(x||'')).filter(Boolean).slice(0,50):[];
    if(paths.length)await admin.storage.from('attachments').remove(paths);
    if(ids.length)await admin.from('rodios_issues').delete().in('id',ids);
    return response({ok:true});
  }

  return response({ok:false,error:'Unknown action'},400);
});
