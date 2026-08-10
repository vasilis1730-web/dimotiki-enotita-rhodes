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
await page.waitForTimeout(1200);
assert.equal(errors.length,0,'staff pageerror before failure-path tests: '+errors.join(' | '));

const result=await page.evaluate(async()=>{
  const out={};
  const originalAlert=window.alert;
  const originalToast=window.toast;
  const alerts=[]; const toasts=[];
  window.alert=(m)=>alerts.push(String(m));
  window.toast=(m)=>toasts.push(String(m));

  // 1) Issue save must fail before numbering/persistence when an attachment is unresolved.
  document.getElementById('i_id').value='';
  document.getElementById('i_date').value='2026-08-10';
  document.getElementById('i_cat').value='Οδοποιία';
  // title/location are ordinary text/select fields in the current modal; values only need to be non-empty.
  document.getElementById('i_title').value='STAGING TEST';
  document.getElementById('i_location').value='STAGING LOCATION';
  _issueAttachments=[{name:'failed.jpg',upload_failed:true,_file:{name:'failed.jpg'}}];
  let numberingCalls=0;
  const originalNext=window.nextIssueNumAsync;
  window.nextIssueNumAsync=async()=>{numberingCalls++; return 'ΑΙΤ-2099-999';};
  const issuesBefore=issues.length;
  await saveIssue();
  out.issueBlocked={
    numberingCalls,
    issuesDelta:issues.length-issuesBefore,
    alert:alerts.at(-1)||''
  };
  window.nextIssueNumAsync=originalNext;

  // Retry path must remain available as an explicit function.
  out.retryFunction=typeof retryIssueAttachment;

  // 2) Order save must fail before reading the rest of the form when media is unresolved.
  currentUser={id:'admin',tier:'admin',email:'rodios-admin-staging@rhodes.gr',canOrders:true};
  woMediaBefore=[{name:'before.jpg',upload_failed:true,data:'data:image/jpeg;base64,AA'}];
  woMediaAfter=[];
  const ordersBefore=workOrders.length;
  await saveOrder(false);
  out.orderBlocked={ordersDelta:workOrders.length-ordersBefore,toast:toasts.at(-1)||''};

  // 3) Email preparation must reject unresolved media before returning a sendable payload.
  settings.contractorEmail='contractor@example.invalid';
  const originalEnsure=window.ensureOrderMediaUploaded;
  window.ensureOrderMediaUploaded=async()=>{};
  try{
    await prepareContractorEmailPayload({
      id:'wo_test',orderNum:'ΕΝΤ-2099-001',orderType:'contractor',
      mediaBefore:[{name:'x.jpg',upload_failed:true,data:'data:image/jpeg;base64,AA'}],mediaAfter:[]
    });
    out.emailBlocked={threw:false,message:''};
  }catch(e){ out.emailBlocked={threw:true,message:String(e?.message||e)}; }
  window.ensureOrderMediaUploaded=originalEnsure;

  // 4) manageAppUser must reject a non-admin before any Supabase client is requested.
  currentUser={id:'stg_manager',tier:'manager',email:'manager@example.invalid',canOrders:true};
  const originalGetSupabase=window.getSupabase;
  let supabaseRequested=false;
  window.getSupabase=()=>{supabaseRequested=true; throw new Error('SHOULD_NOT_BE_CALLED');};
  try{
    await manageAppUser('create',{email:'new@example.invalid'},'Password1!',null);
    out.manageUserBlocked={threw:false,message:'',supabaseRequested};
  }catch(e){ out.manageUserBlocked={threw:true,message:String(e?.message||e),supabaseRequested}; }
  window.getSupabase=originalGetSupabase;

  // 5) PDF acceptance: local markers/count alone must never authorize acceptance.
  settings.eSignUsers=[{name:'A'},{name:'B'},{name:'C'}];
  const fakePdf='data:application/pdf;base64,'+btoa('%PDF-1.7 /ByteRange [0 10 20 30] /ByteRange [0 10 20 30] /ByteRange [0 10 20 30]');
  const baseWo={id:'wo_sig_test',orderNum:'ΕΝΤ-2099-002',status:'Σε εξέλιξη',signedPdfData:fakePdf,signedPdfName:'fake.pdf',issueId:null};
  workOrders=[structuredClone(baseWo)];
  _sigOrderId='wo_sig_test';
  alerts.length=0;
  await finalizeAcceptance();
  out.pdfNoServer={status:workOrders[0].status,protocolReady:!!workOrders[0]._protocolReady,alert:alerts.at(-1)||''};

  workOrders=[{...structuredClone(baseWo),_edgeResult:{verified:false,count:3,signatureCount:3},_edgeSigCount:3}];
  _sigOrderId='wo_sig_test';
  alerts.length=0;
  await finalizeAcceptance();
  out.pdfVerifiedFalse={status:workOrders[0].status,protocolReady:!!workOrders[0]._protocolReady,alert:alerts.at(-1)||''};

  // 6) CSV export neutralizer must change dangerous leading spreadsheet formulas only in export representation.
  out.csv={
    eq:_csvSafeCell('=1+1'),
    plus:_csvSafeCell('+SUM(A1:A2)'),
    safe:_csvSafeCell('κανονικό κείμενο')
  };

  window.alert=originalAlert;
  window.toast=originalToast;
  return out;
});

assert.equal(result.issueBlocked.numberingCalls,0,'failed attachment burned/asked for issue number');
assert.equal(result.issueBlocked.issuesDelta,0,'failed attachment allowed issue persistence');
assert.match(result.issueBlocked.alert,/Retry|μεταφορτωθεί/i,'failed attachment did not show retry/block message');
assert.equal(result.retryFunction,'function','retryIssueAttachment is missing');

assert.equal(result.orderBlocked.ordersDelta,0,'unresolved order media allowed save');
assert.match(result.orderBlocked.toast,/Retry|δεν μεταφορτώθηκαν/i,'unresolved order media did not block save');

assert.equal(result.emailBlocked.threw,true,'unresolved order media allowed email payload');
assert.match(result.emailBlocked.message,/ακυρώθηκε|δεν μεταφορτώθηκαν/i,'email media failure message missing');

assert.equal(result.manageUserBlocked.threw,true,'manager could call manageAppUser');
assert.equal(result.manageUserBlocked.supabaseRequested,false,'manager reached Supabase before client guard');
assert.match(result.manageUserBlocked.message,/Administrator/i,'manager user-management denial message missing');

assert.notEqual(result.pdfNoServer.status,'Παραλήφθηκε','PDF without server verification was accepted');
assert.equal(result.pdfNoServer.protocolReady,false,'PDF without server verification set protocolReady');
assert.match(result.pdfNoServer.alert,/κρυπτογραφική επαλήθευση/i,'missing-verifier rejection absent');
assert.notEqual(result.pdfVerifiedFalse.status,'Παραλήφθηκε','verified:false PDF was accepted');
assert.equal(result.pdfVerifiedFalse.protocolReady,false,'verified:false PDF set protocolReady');

assert.match(result.csv.eq,/^"'/,'formula starting = was not neutralized');
assert.match(result.csv.plus,/^"'/,'formula starting + was not neutralized');
assert.equal(result.csv.safe,'"κανονικό κείμενο"','safe CSV text was unexpectedly altered');

assert.equal(prod.length,0,'failure-path test attempted production Supabase: '+prod.join(', '));
console.log('PASS issue attachment fail-closed + Retry contract');
console.log('PASS order media save/email fail-closed contract');
console.log('PASS non-admin manage-user client guard');
console.log('PASS PDF client fail-closed contract');
console.log('PASS CSV formula neutralization');
console.log('FAILURE_PATH_SMOKE_PASS');
await browser.close();
