import { assertAllowedOrigin, consumeHourlyQuota, corsHeaders, handleError, HttpError, json, requireActiveStaff } from "../_shared/rodios-staff-auth.ts";

function normalizeEmail(v: unknown): string {
  return String(v || "").trim().toLowerCase();
}
function cleanText(v: unknown, max = 180): string {
  return String(v || "").trim().slice(0, max);
}
function safeProfile(input: any) {
  const p = input && typeof input === "object" ? input : {};
  const email = normalizeEmail(p.email);
  const id = cleanText(p.id || crypto.randomUUID(), 180).replace(/[^\w.\-:/]/g, "_");
  const tierRaw = String(p.tier || "").toLowerCase();
  const tier = id === "admin" ? "admin" : (tierRaw === "manager" ? "manager" : "user");
  return { id, name: cleanText(p.name,160), role: cleanText(p.role,160), tier, email,
    username: cleanText(p.username || email.split("@")[0] || "",120),
    color: /^#[0-9a-f]{6}$/i.test(String(p.color||"")) ? String(p.color) : "#2d4a8a",
    initials: cleanText(p.initials||"?",2).toUpperCase(),
    canEdit: p.canEdit !== false, canOrders: p.canOrders !== false,
    canDelete: Boolean(p.canDelete), canPenalty: Boolean(p.canPenalty) };
}
async function findAuthUserIdByEmail(admin:any,email:string):Promise<string|null>{
  if(!email)return null; let page=1; const perPage=100;
  while(page<=50){const {data,error}=await admin.auth.admin.listUsers({page,perPage}); if(error)throw error;
    const found=(data?.users||[]).find((u:any)=>normalizeEmail(u.email)===email); if(found)return found.id;
    if(!data?.users||data.users.length<perPage)return null; page++;} return null;
}
async function existingProfile(admin:any,profileId:string){
  if(!profileId)return null; const {data,error}=await admin.from("rodios_app_users").select("id, auth_user_id, data, deleted_at").eq("id",profileId).maybeSingle();
  if(error)throw error; return data||null;
}
Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS"){try{assertAllowedOrigin(req);return new Response(null,{status:204,headers:corsHeaders(req)});}catch(e){return handleError(req,"manage-app-user",e);}}
  if(req.method!=="POST")return json(req,{ok:false,error:"Method not allowed"},405);
  try{
    const ctx=await requireActiveStaff(req,{adminOnly:true});
    await consumeHourlyQuota(ctx.admin,"manage-app-user",ctx.user.id,60);
    let body:any; try{body=await req.json();}catch{throw new HttpError(400,"Invalid JSON");}
    const action=cleanText(body?.action,20);
    if(action==="ping")return json(req,{ok:true,action:"ping",admin:true,version:"gate-g-v1"});
    if(!["create","update","delete"].includes(action))throw new HttpError(400,"Invalid action");
    const profile=safeProfile(body?.profile); const password=String(body?.password||""); const oldEmail=normalizeEmail(body?.oldEmail||profile.email);
    if(!profile.id)throw new HttpError(400,"Profile id is required");
    if(action!=="delete"){
      if(!profile.name||!profile.role||!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(profile.email))throw new HttpError(400,"Missing or invalid profile data");
      if(password.length>256)throw new HttpError(400,"Invalid password");
    }
    if(action==="delete"&&profile.id==="admin")throw new HttpError(400,"The primary Administrator profile cannot be deleted");
    const current=await existingProfile(ctx.admin,profile.id); let authUserId:string|null=current?.auth_user_id||null;
    if(!authUserId&&action!=="create")authUserId=await findAuthUserIdByEmail(ctx.admin,normalizeEmail(current?.data?.email||oldEmail||profile.email));
    if(action==="create"){
      if(current&&current.deleted_at===null)throw new HttpError(409,"Profile id already exists");
      if(password.length<6)throw new HttpError(400,"Password must be at least 6 characters");
      const {data,error}=await ctx.admin.auth.admin.createUser({email:profile.email,password,email_confirm:true,user_metadata:{rodios_profile_id:profile.id,name:profile.name,role:profile.role,tier:profile.tier}});
      if(error)throw error; authUserId=data.user?.id||null; if(!authUserId)throw new Error("Created Auth user has no id");
      const stored={...profile,authUserId};
      const {error:upsertError}=await ctx.admin.from("rodios_app_users").upsert({id:profile.id,auth_user_id:authUserId,data:stored,deleted_at:null},{onConflict:"id"});
      if(upsertError){try{await ctx.admin.auth.admin.deleteUser(authUserId);}catch(_){} throw upsertError;}
      return json(req,{ok:true,action,profile:stored});
    }
    if(action==="update"){
      if(!current||current.deleted_at!==null)throw new HttpError(404,"Profile not found");
      if(!authUserId){
        if(password.length<6)throw new HttpError(409,"Auth account is missing; set a password to recreate it");
        const {data,error}=await ctx.admin.auth.admin.createUser({email:profile.email,password,email_confirm:true,user_metadata:{rodios_profile_id:profile.id,name:profile.name,role:profile.role,tier:profile.tier}});
        if(error)throw error; authUserId=data.user?.id||null;
      }else{
        const attrs:Record<string,unknown>={email:profile.email,user_metadata:{rodios_profile_id:profile.id,name:profile.name,role:profile.role,tier:profile.tier}};
        if(password){if(password.length<6)throw new HttpError(400,"Password must be at least 6 characters"); attrs.password=password;}
        const {error}=await ctx.admin.auth.admin.updateUserById(authUserId,attrs); if(error)throw error;
      }
      if(!authUserId)throw new Error("Auth account id is missing after update");
      const stored={...profile,authUserId}; const {error}=await ctx.admin.from("rodios_app_users").update({auth_user_id:authUserId,data:stored,deleted_at:null}).eq("id",profile.id); if(error)throw error;
      return json(req,{ok:true,action,profile:stored});
    }
    if(!current||current.deleted_at!==null)throw new HttpError(404,"Profile not found");
    if(authUserId){const {error}=await ctx.admin.auth.admin.deleteUser(authUserId);if(error)throw error;}
    const {error}=await ctx.admin.from("rodios_app_users").update({deleted_at:new Date().toISOString(),auth_user_id:null}).eq("id",profile.id); if(error)throw error;
    return json(req,{ok:true,action,profile:{...profile,authUserId:null}});
  }catch(e){return handleError(req,"manage-app-user",e);}
});
