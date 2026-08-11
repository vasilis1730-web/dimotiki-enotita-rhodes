import { createClient } from "npm:@supabase/supabase-js@2.110.9";

const PROD_REF = "nzrdcgmrsfdmocyhfrod";
const GOOD_ORIGIN = "https://vasilis1730-web.github.io";
const EVIL_ORIGIN = "https://attacker.example.invalid";

type Result = { name: string; ok: boolean; detail?: unknown };

function assert(v: unknown, message: string): asserts v { if (!v) throw new Error(message); }
function refOf(url: string) { try { return new URL(url).hostname.split(".")[0] || ""; } catch { return ""; } }
function err(e: unknown) { return e instanceof Error ? e.message : String(e); }
function response(body: unknown, status=200) { return new Response(JSON.stringify(body,null,2),{status,headers:{"content-type":"application/json","cache-control":"no-store"}}); }

Deno.serve(async (req: Request) => {
  const url = Deno.env.get("SUPABASE_URL") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SECRET_KEY") || "";
  const ref = refOf(url);
  if (!url || !anonKey || !serviceKey || !ref || ref === PROD_REF) return response({ok:false,error:"REFUSED: non-preview runtime"},403);
  const admin = createClient(url, serviceKey, {auth:{persistSession:false,autoRefreshToken:false}});
  const {data:settings,error:settingsError}=await admin.from("rodios_settings").select("value").eq("key","main").maybeSingle();
  if(settingsError || settings?.value?.staging!==true) return response({ok:false,error:"REFUSED: database is not staging:true"},403);
  if(req.method==="GET") return response({ok:true,ready:true,previewRef:ref});
  if(req.method!=="POST") return response({ok:false,error:"Method not allowed"},405);

  const results: Result[]=[];
  async function test(name:string, fn:()=>Promise<unknown>){try{const detail=await fn();results.push({name,ok:true,detail});}catch(e){results.push({name,ok:false,detail:err(e)});}}
  async function call(fn:string, init:RequestInit={}){
    return await fetch(`${url}/functions/v1/${fn}`,init);
  }
  async function bodyJson(r:Response){try{return await r.json();}catch{return null;}}

  await test("citizen_bridge_disallowed_origin", async()=>{
    const r=await call("citizen-bridge",{method:"POST",headers:{"content-type":"application/json","origin":EVIL_ORIGIN},body:JSON.stringify({action:"list"})});
    const b=await bodyJson(r); assert(r.status===403,`expected 403 got ${r.status}`); assert(b?.ok===false,"bridge evil-origin body not fail-closed");
    assert(!r.headers.get("access-control-allow-origin"),"evil origin received CORS allow header"); return {status:r.status};
  });

  await test("citizen_bridge_missing_firebase_and_appcheck", async()=>{
    const r=await call("citizen-bridge",{method:"POST",headers:{"content-type":"application/json","origin":GOOD_ORIGIN},body:JSON.stringify({action:"list"})});
    const b=await bodyJson(r); assert(r.status===401,`expected 401 got ${r.status}`); assert(b?.ok===false,"missing-auth bridge request not denied");
    assert(r.headers.get("access-control-allow-origin")===GOOD_ORIGIN,"allowed origin missing expected CORS response"); return {status:r.status};
  });

  await test("citizen_bridge_invalid_tokens", async()=>{
    const r=await call("citizen-bridge",{method:"POST",headers:{"content-type":"application/json","origin":GOOD_ORIGIN,"x-firebase-id-token":"abc.def.ghi","x-firebase-appcheck":"abc.def.ghi"},body:JSON.stringify({action:"list"})});
    const b=await bodyJson(r); assert(r.status===401,`expected 401 got ${r.status}`); assert(b?.ok===false,"invalid-token bridge request not denied"); return {status:r.status};
  });

  await test("citizen_bridge_oversized_json", async()=>{
    const huge="x".repeat(530*1024);
    const r=await call("citizen-bridge",{method:"POST",headers:{"content-type":"application/json","origin":GOOD_ORIGIN},body:JSON.stringify({action:"list",padding:huge})});
    const b=await bodyJson(r); assert(r.status===413,`expected 413 got ${r.status}`); assert(b?.ok===false,"oversized bridge request not denied"); return {status:r.status};
  });

  await test("citizen_bridge_wrong_method", async()=>{
    const r=await call("citizen-bridge",{method:"GET",headers:{"origin":GOOD_ORIGIN}}); assert(r.status===405,`expected 405 got ${r.status}`); return {status:r.status};
  });

  await test("citizen_attachments_disallowed_origin", async()=>{
    const r=await call("citizen-attachments",{method:"POST",headers:{"content-type":"application/json","origin":EVIL_ORIGIN},body:JSON.stringify({action:"sign",paths:["citizen/301234567890/x.txt"]})});
    const b=await bodyJson(r); assert(r.status===403,`expected 403 got ${r.status}`); assert(b?.ok===false,"attachment evil-origin request not denied");
    assert(!r.headers.get("access-control-allow-origin"),"evil origin received attachment CORS allow header"); return {status:r.status};
  });

  await test("citizen_attachments_missing_auth", async()=>{
    const r=await call("citizen-attachments",{method:"POST",headers:{"content-type":"application/json","origin":GOOD_ORIGIN},body:JSON.stringify({action:"sign",paths:["citizen/301234567890/x.txt"]})});
    const b=await bodyJson(r); assert(r.status===401,`expected 401 got ${r.status}`); assert(b?.ok===false,"missing-auth attachment request not denied"); return {status:r.status};
  });

  await test("citizen_attachments_invalid_tokens", async()=>{
    const r=await call("citizen-attachments",{method:"POST",headers:{"content-type":"application/json","origin":GOOD_ORIGIN,"x-firebase-id-token":"abc.def.ghi","x-firebase-appcheck":"abc.def.ghi"},body:JSON.stringify({action:"sign",paths:["citizen/301234567890/x.txt"]})});
    const b=await bodyJson(r); assert(r.status===401,`expected 401 got ${r.status}`); assert(b?.ok===false,"invalid-token attachment request not denied"); return {status:r.status};
  });

  await test("citizen_attachments_wrong_method", async()=>{
    const r=await call("citizen-attachments",{method:"GET",headers:{"origin":GOOD_ORIGIN}}); assert(r.status===405,`expected 405 got ${r.status}`); return {status:r.status};
  });

  await test("direct_anon_storage_upload_denied", async()=>{
    const anon=createClient(url,anonKey,{auth:{persistSession:false,autoRefreshToken:false}});
    const path=`citizen/301234567890/security-probe-${crypto.randomUUID()}.txt`;
    const up=await anon.storage.from("attachments").upload(path,new Blob(["must-not-exist"],{type:"text/plain"}),{upsert:false});
    const probe=await admin.storage.from("attachments").download(path);
    if(!probe.error&&probe.data){await admin.storage.from("attachments").remove([path]);throw new Error("anonymous upload created a private Storage object");}
    assert(!!up.error,"anonymous Storage upload returned success despite no object"); return {sdkDenied:true,objectAbsent:true};
  });

  const ok=results.length===10&&results.every(x=>x.ok);
  return response({ok,previewRef:ref,realNetwork:true,results},ok?200:500);
});
