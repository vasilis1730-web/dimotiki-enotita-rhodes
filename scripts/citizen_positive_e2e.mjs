import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const previewRef=process.env.PREVIEW_REF||'';
const phone=process.env.RODIOS_FIREBASE_TEST_PHONE||'';
const code=process.env.RODIOS_FIREBASE_TEST_CODE||'';
const debugToken=process.env.RODIOS_FIREBASE_APPCHECK_DEBUG_TOKEN||'';
assert(previewRef && phone && code && debugToken,'Missing positive Firebase E2E configuration');

const base=`https://${previewRef}.supabase.co/functions/v1`;
const origin='https://vasilis1730-web.github.io';
const fixtureUrl=`${base}/staging-citizen-positive-fixture`;
const bridgeUrl=`${base}/citizen-bridge`;
const attachmentsUrl=`${base}/citizen-attachments`;
const cleanupIds=[]; const cleanupPaths=[];

async function postJson(url,body,headers={}){
  const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
  let data=null; try{data=await r.json()}catch{}
  return {r,data};
}

const seeded=await postJson(fixtureUrl,{action:'seedLegacy',phone});
assert.equal(seeded.r.status,200,'legacy fixture seed failed');
assert(seeded.data?.matchingId&&seeded.data?.otherId,'legacy fixture ids missing');
cleanupIds.push(seeded.data.matchingId,seeded.data.otherId);

let browser;
let submittedId='';
try{
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage();
  await page.goto('http://localhost:4174/citizen-positive.html',{waitUntil:'domcontentloaded'});
  const tokens=await page.evaluate(async({phone,code,debugToken})=>{
    self.FIREBASE_APPCHECK_DEBUG_TOKEN=debugToken;
    const {initializeApp}=await import('https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js');
    const {getAuth,RecaptchaVerifier,signInWithPhoneNumber}=await import('https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js');
    const {initializeAppCheck,ReCaptchaV3Provider,getToken}=await import('https://www.gstatic.com/firebasejs/12.17.1/firebase-app-check.js');
    const app=initializeApp({apiKey:'AIzaSyATvkHqSyyVxVD8UujQQnj_wdR2Kc306wA',authDomain:'dimosrodou-otp.firebaseapp.com',projectId:'dimosrodou-otp',appId:'1:315292350668:web:8288883847d24ac33e2a69'},'rodios-ci-positive');
    const appCheck=initializeAppCheck(app,{provider:new ReCaptchaV3Provider('6LcF_HctAAAAAJwwZPbh_BFMDwoQ5AgX0CocYqFB'),isTokenAutoRefreshEnabled:false});
    const auth=getAuth(app); auth.settings.appVerificationDisabledForTesting=true;
    const verifier=new RecaptchaVerifier(auth,'recaptcha-container',{size:'invisible'});
    const confirmation=await signInWithPhoneNumber(auth,phone,verifier);
    const credential=await confirmation.confirm(code);
    const idToken=await credential.user.getIdToken(true);
    const appCheckResult=await getToken(appCheck,true);
    return {idToken,appCheckToken:appCheckResult.token,uid:credential.user.uid};
  },{phone,code,debugToken});
  assert(tokens.idToken&&tokens.appCheckToken&&tokens.uid,'Firebase positive tokens missing');

  const authHeaders={'origin':origin,'x-firebase-id-token':tokens.idToken,'x-firebase-appcheck':tokens.appCheckToken};
  const payload=`RODIOS citizen positive E2E ${Date.now()}`;
  const form=new FormData(); form.set('action','upload'); form.set('file',new Blob([payload],{type:'text/plain'}),'citizen-e2e.txt');
  const upload=await fetch(attachmentsUrl,{method:'POST',headers:authHeaders,body:form});
  const uploadData=await upload.json();
  assert.equal(upload.status,200,`citizen attachment upload failed: ${JSON.stringify(uploadData)}`);
  assert(uploadData?.attachment?.path,'citizen attachment path missing');
  const attachment=uploadData.attachment; cleanupPaths.push(attachment.path);

  const submit=await postJson(bridgeUrl,{action:'submit',issue:{citizenRef:'920001',citizenName:'STAGING FIREBASE CITIZEN',municipality:'Ρόδος',category:'Οδοποιία',title:'STAGING positive citizen submit',location:'STAGING',description:'Positive Firebase/App Check integration test',attachments:[attachment]}},authHeaders);
  assert.equal(submit.r.status,200,`citizen submit failed: ${JSON.stringify(submit.data)}`);
  submittedId=submit.data?.issue?.id||''; assert(submittedId,'submitted issue id missing'); cleanupIds.push(submittedId);

  const listed=await postJson(bridgeUrl,{action:'list'},authHeaders);
  assert.equal(listed.r.status,200,'citizen list failed');
  const ids=(listed.data?.issues||[]).map(x=>x.id);
  assert(ids.includes(submittedId),'submitted citizen issue missing from own list');
  assert(ids.includes(seeded.data.matchingId),'matching legacy-phone issue missing from list');
  assert(!ids.includes(seeded.data.otherId),'different-phone legacy issue leaked into list');

  const legacyUpdate=await postJson(bridgeUrl,{action:'update',issue:{id:seeded.data.matchingId,title:'STAGING legacy claimed by Firebase UID'}},authHeaders);
  assert.equal(legacyUpdate.r.status,200,'matching legacy issue update failed');
  const inspect=await postJson(fixtureUrl,{action:'inspect',ids:[seeded.data.matchingId,seeded.data.otherId]});
  assert.equal(inspect.r.status,200,'fixture inspection failed');
  const match=inspect.data.rows.find(x=>x.id===seeded.data.matchingId);
  const other=inspect.data.rows.find(x=>x.id===seeded.data.otherId);
  assert.equal(match?.authUid,tokens.uid,'matching legacy row was not claimed by authenticated Firebase UID');
  assert.equal(other?.authUid,'','other legacy row unexpectedly gained an auth UID');

  const forbidden=await postJson(bridgeUrl,{action:'update',issue:{id:seeded.data.otherId,title:'MUST NOT UPDATE'}},authHeaders);
  assert.equal(forbidden.r.status,403,'different-phone legacy issue update was not denied');

  const ownUpdate=await postJson(bridgeUrl,{action:'update',issue:{id:submittedId,title:'STAGING positive citizen updated'}},authHeaders);
  assert.equal(ownUpdate.r.status,200,'UID-owned citizen update failed');

  const signed=await postJson(attachmentsUrl,{action:'sign',paths:[attachment.path]},authHeaders);
  assert.equal(signed.r.status,200,'citizen signed URL request failed');
  const signedUrl=signed.data?.urls?.[attachment.path]; assert(signedUrl,'citizen signed URL missing');
  const dl=await fetch(signedUrl); assert(dl.ok,'citizen signed URL download failed');
  assert.equal(await dl.text(),payload,'citizen signed URL returned wrong bytes');

  const removed=await postJson(attachmentsUrl,{action:'remove',path:attachment.path},authHeaders);
  assert.equal(removed.r.status,200,'citizen attachment remove failed');
  cleanupPaths.splice(cleanupPaths.indexOf(attachment.path),1);

  console.log('CITIZEN_POSITIVE_FIREBASE_E2E_PASS');
  console.log('PASS fictional Firebase phone Auth produced a real signed ID token');
  console.log('PASS registered App Check debug provider produced a valid App Check token');
  console.log('PASS citizen attachment upload/sign/download/remove');
  console.log('PASS citizen submit/list/update and legacy-phone claim/isolation');
} finally {
  if(browser) await browser.close();
  try{await postJson(fixtureUrl,{action:'cleanup',ids:cleanupIds,paths:cleanupPaths});}catch{}
}
