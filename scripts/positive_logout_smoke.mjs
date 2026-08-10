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
  const originalRenderAll=window.renderAll;
  const originalCloseSigModal=window.closeSigModal;
  const originalGetSupabase=window.getSupabase;
  const alerts=[]; const toasts=[];
  window.alert=m=>alerts.push(String(m));
  window.toast=m=>toasts.push(String(m));

  settings.eSignUsers=[{name:'A'},{name:'B'},{name:'C'}];
  const fakePdf='data:application/pdf;base64,'+btoa('%PDF-1.7');
  const proofId='20000000-0000-4000-8000-000000000010';
  const localOrder={
    id:'wo_positive_sig',orderNum:'ΕΝΤ-2099-010',status:'Σε εξέλιξη',issueId:'issue_positive',
    signedPdfData:fakePdf,signedPdfName:'verified-by-server.pdf',
    _edgeResult:{verified:true,count:3,signatureCount:3,verificationProofId:proofId},_edgeSigCount:3,
    items:[{qty:2,unitPrice:100}],discountPct:10,penaltyAmount:5
  };
  workOrders=[structuredClone(localOrder)];
  issues=[{id:'issue_positive',status:'Σε εξέλιξη',title:'Before server response'}];
  payments=[];
  _sigOrderId='wo_positive_sig';

  const serverOrder={...structuredClone(localOrder),status:'Παραλήφθηκε',completionDate:'2099-01-02',_protocolReady:true,verificationProofId:proofId,pdfSha256:'a'.repeat(64)};
  const serverIssue={id:'issue_positive',status:'Ολοκληρωμένο',title:'Before server response',completionDate:'2099-01-02'};
  const serverPayment={id:'payment_positive',orderId:'wo_positive_sig',amount:175,autoCreated:true,isPenalty:false,date:'2099-01-02'};
  let rpcCalls=0; let rpcName=''; let rpcArgs=null;
  window.getSupabase=()=>({rpc:async(name,args)=>{
    rpcCalls++; rpcName=name; rpcArgs=args;
    return {data:{ok:true,proofId,pdfSha256:'a'.repeat(64),orderIds:['wo_positive_sig'],orders:[serverOrder],issues:[serverIssue],payments:[serverPayment]},error:null};
  }});
  let renderAllCalls=0, closeSigCalls=0;
  window.renderAll=()=>{renderAllCalls++;};
  window.closeSigModal=()=>{closeSigCalls++;};

  await finalizeAcceptance();
  out.pdfPositive={
    rpcCalls,rpcName,rpcArgs,
    status:workOrders[0].status,
    protocolReady:!!workOrders[0]._protocolReady,
    completionDate:workOrders[0].completionDate||'',
    issueStatus:issues.find(i=>i.id==='issue_positive')?.status||'',
    paymentCount:payments.filter(p=>p.orderId==='wo_positive_sig'&&p.autoCreated).length,
    paymentAmount:payments.find(p=>p.orderId==='wo_positive_sig')?.amount??null,
    renderAllCalls,closeSigCalls,
    alert:alerts.at(-1)||'',toast:toasts.at(-1)||''
  };

  window.renderAll=originalRenderAll;
  window.closeSigModal=originalCloseSigModal;

  // Full logout path remains unchanged after the acceptance refactor.
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

assert.equal(result.pdfPositive.rpcCalls,1,'proof acceptance did not call exactly one RPC');
assert.equal(result.pdfPositive.rpcName,'rodios_finalize_verified_acceptance','wrong acceptance RPC');
assert.equal(result.pdfPositive.rpcArgs.p_proof_id,'20000000-0000-4000-8000-000000000010','wrong proof ID sent');
assert.deepEqual(result.pdfPositive.rpcArgs.p_expected_order_ids,['wo_positive_sig'],'wrong order ID set sent');
assert.equal(result.pdfPositive.status,'Παραλήφθηκε','client did not merge server accepted order');
assert.equal(result.pdfPositive.protocolReady,true,'client did not merge server protocolReady');
assert.equal(result.pdfPositive.completionDate,'2099-01-02','client did not use server completionDate');
assert.equal(result.pdfPositive.issueStatus,'Ολοκληρωμένο','client did not merge server linked issue');
assert.equal(result.pdfPositive.paymentCount,1,'client did not merge exactly one server-created payment');
assert.equal(result.pdfPositive.paymentAmount,175,'client altered server-calculated payment amount');
assert.equal(result.pdfPositive.alert,'','successful proof RPC unexpectedly alerted rejection');
assert.equal(result.pdfPositive.renderAllCalls,1,'successful proof RPC did not rerender exactly once');
assert.equal(result.pdfPositive.closeSigCalls,1,'successful proof RPC did not close signature modal exactly once');

assert.equal(result.logout.signOutCalls,1,'doLogout did not call Supabase auth.signOut exactly once');
assert.equal(result.logout.currentUserIsNull,true,'doLogout left currentUser populated');
assert.equal(result.logout.loginDisplay,'flex','doLogout did not return to login screen');
assert.equal(result.logout.headerDisplay,'none','doLogout left header user visible');
for(const [k,v] of Object.entries(result.logout.keys)) assert.equal(v,null,`doLogout left operational key ${k}`);
assert.equal(prod.length,0,'positive/logout test attempted production Supabase: '+prod.join(', '));

console.log('PASS server-proof RPC success merges authoritative order/issue/payment rows');
console.log('PASS full doLogout signOut + purge + login return');
console.log('POSITIVE_LOGOUT_SMOKE_PASS');
await browser.close();
