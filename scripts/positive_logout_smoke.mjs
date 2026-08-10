import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const ORIGIN='http://127.0.0.1:4173';
const PROD_SUPABASE_REF='nzrdcgmrsfdmocyhfrod';
const CDN_HOSTS=new Set(['cdn.jsdelivr.net','www.gstatic.com']);

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({serviceWorkers:'block'});
const page=await context.newPage();
const prod=[];
const errors=[];
page.on('request',r=>{if(r.url().includes(PROD_SUPABASE_REF))prod.push(r.url())});
page.on('pageerror',e=>errors.push(String(e?.stack||e?.message||e)));
await page.route('**/*',async route=>{
  const u=new URL(route.request().url());
  if(u.origin===ORIGIN||CDN_HOSTS.has(u.hostname)) return route.continue();
  return route.abort('blockedbyclient');
});
const r=await page.goto(ORIGIN+'/aftepistasia.html',{waitUntil:'domcontentloaded',timeout:45000});
assert(r&&r.ok(),'staff page load failed');
await page.waitForTimeout(1000);
assert.equal(errors.length,0,'staff pageerror before positive-path tests: '+errors.join(' | '));

const result=await page.evaluate(async()=>{
  const out={};
  const originalAlert=window.alert;
  const originalToast=window.toast;
  const originalSave=window.save;
  const originalRenderOrders=window.renderOrders;
  const originalCloseModal=window.closeModal;
  const originalGetSupabase=window.getSupabase;
  const alerts=[]; const toasts=[];
  window.alert=m=>alerts.push(String(m));
  window.toast=m=>toasts.push(String(m));

  // Positive client acceptance is permitted only with explicit server verified:true.
  settings.eSignUsers=[{name:'A'},{name:'B'},{name:'C'}];
  const fakePdf='data:application/pdf;base64,'+btoa('%PDF-1.7');
  workOrders=[{
    id:'wo_positive_sig',orderNum:'ΕΝΤ-2099-010',status:'Σε εξέλιξη',issueId:null,
    signedPdfData:fakePdf,signedPdfName:'verified-by-server.pdf',
    _edgeResult:{verified:true,count:3,signatureCount:3},_edgeSigCount:3
  }];
  _sigOrderId='wo_positive_sig';
  let saveCalls=0, renderCalls=0, closeCalls=0;
  window.save=()=>{saveCalls++;};
  window.renderOrders=()=>{renderCalls++;};
  window.closeModal=()=>{closeCalls++;};
  await finalizeAcceptance();
  out.pdfPositive={
    status:workOrders[0].status,
    protocolReady:!!workOrders[0]._protocolReady,
    actualEnd:workOrders[0].actualEnd||'',
    saveCalls,renderCalls,closeCalls,
    alert:alerts.at(-1)||'',toast:toasts.at(-1)||''
  };

  window.save=originalSave;
  window.renderOrders=originalRenderOrders;
  window.closeModal=originalCloseModal;

  // Full logout path: signOut + operational purge + return to login UI.
  currentUser={id:'admin',tier:'admin',email:'rodios-admin-staging@rhodes.gr',canOrders:true};
  document.getElementById('headerUser').style.display='block';
  document.getElementById('loginScreen').style.display='none';
  document.getElementById('logoutPop').style.display='block';
  localStorage.setItem('rodios_v9_light_cache','sensitive');
  localStorage.setItem('rodios_v9_last_counts','sensitive');
  localStorage.setItem('serviceStaff','sensitive');
  localStorage.setItem('sb_url','legacy');
  localStorage.setItem('sb_key','legacy');
  let signOutCalls=0;
  window.getSupabase=()=>({auth:{signOut:async()=>{signOutCalls++;}}});
  await doLogout();
  out.logout={
    signOutCalls,
    currentUserIsNull:currentUser===null,
    loginDisplay:getComputedStyle(document.getElementById('loginScreen')).display,
    headerDisplay:getComputedStyle(document.getElementById('headerUser')).display,
    keys:Object.fromEntries(['rodios_v9_light_cache','rodios_v9_last_counts','serviceStaff','sb_url','sb_key'].map(k=>[k,localStorage.getItem(k)]))
  };

  window.getSupabase=originalGetSupabase;
  window.alert=originalAlert;
  window.toast=originalToast;
  return out;
});

assert.equal(result.pdfPositive.status,'Παραλήφθηκε','verified:true PDF did not enter accepted state');
assert.equal(result.pdfPositive.protocolReady,true,'verified:true PDF did not set protocolReady');
assert(result.pdfPositive.actualEnd,'verified:true PDF did not set actual completion date');
assert.equal(result.pdfPositive.alert,'','verified:true PDF unexpectedly alerted rejection');
assert(result.pdfPositive.saveCalls>=1,'verified:true acceptance did not invoke persistence path');
assert(result.pdfPositive.renderCalls>=1,'verified:true acceptance did not rerender orders');
assert(result.pdfPositive.closeCalls>=1,'verified:true acceptance did not close modal');

assert.equal(result.logout.signOutCalls,1,'doLogout did not call Supabase auth.signOut exactly once');
assert.equal(result.logout.currentUserIsNull,true,'doLogout left currentUser populated');
assert.equal(result.logout.loginDisplay,'flex','doLogout did not return to login screen');
assert.equal(result.logout.headerDisplay,'none','doLogout left header user visible');
for(const [k,v] of Object.entries(result.logout.keys)) assert.equal(v,null,`doLogout left operational key ${k}`);
assert.equal(prod.length,0,'positive/logout test attempted production Supabase: '+prod.join(', '));

console.log('PASS PDF verified:true positive client acceptance path');
console.log('PASS full doLogout signOut + purge + login return');
console.log('POSITIVE_LOGOUT_SMOKE_PASS');
await browser.close();
