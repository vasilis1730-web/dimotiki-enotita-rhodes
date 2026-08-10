import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const ORIGIN='http://127.0.0.1:4173';
const PROD_SUPABASE_REF='nzrdcgmrsfdmocyhfrod';
const CDN_HOSTS=new Set(['cdn.jsdelivr.net','www.gstatic.com']);
const launchOptions={headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})};

const browser=await chromium.launch(launchOptions);
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
  document.getElementById('i_cat').value='Οδοστρωσία';
  onCategoryChange();
  const titleEl=document.getElementById('i_title');
  const firstTitle=Array.from(titleEl.options).find(o=>o.value)?.value || 'STAGING TEST';
  if(!Array.from(titleEl.options).some(o=>o.value===firstTitle)){
    const opt=document.createElement('option'); opt.value=firstTitle; opt.textContent=firstTitle; titleEl.appendChild(opt);
  }
  titleEl.value=firstTitle;
  document.getElementById('i_location').value='STAGING LOCATION';
  _issueAttachments=[{name:'failed.jpg',upload_failed:true,_file:{name:'failed.jpg'}}];
  let numberingCalls=0;
  const originalNext=window.nextIssueNumAsync;
  window.nextIssueNumAsync=async()=>{numberingCalls++; return 'ΑΙΤ-2099-999';};
  const issuesBefore=issues.length;
  await saveIssue();
  out.issueBlocked={category:document.getElementById('i_cat').value,title:document.getElementById('i_title').value,numberingCalls,issuesDelta:issues.length-issuesBefore,alert:alerts.at(-1)||''};
  window.nextIssueNumAsync=originalNext;
  out.retryFunction=typeof retryIssueAttachment;

  // 2) Order save must fail before reading the rest of the form when media is unresolved.
  currentUser={id:'admin',tier:'admin',email:'rodios-admin-staging@rhodes.gr',canOrders:true};
  woMediaBefore=[{name:'before.jpg',upload_failed:true,data:'data:image/jpeg;base64,AA'}];
  woMediaAfter=[];
  const ordersBefore=workOrders.length;
  await saveOrder(false);
  out.orderBlocked={ordersDelta:workOrders.length-ordersBefore,toast:toasts.at(-1)||''};

  // 3) Email preparation must reject unresolved media before returning a sendable payload or ACK side effect.
  settings.contractorEmail='contractor@example.invalid';
  const originalEnsure=window.ensureOrderMediaUploaded;
  window.ensureOrderMediaUploaded=async()=>{};
  try{
    await prepareContractorEmailPayload({id:'wo_test',orderNum:'ΕΝΤ-2099-001',orderType:'contractor',mediaBefore:[{name:'x.jpg',upload_failed:true,data:'data:image/jpeg;base64,AA'}],mediaAfter:[]});
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

  // 5) Atomic synchronization carries the exact DB version and maps stale-write
  // rejection to the user-visible concurrency contract.
  const expectedVersion='2026-08-10T12:34:56.123456+00:00';
  _v9RowVersions.issues=new Map([['sync_contract_row',expectedVersion]]);
  const versioned=_v9ExpectedRow('issues',{id:'sync_contract_row',data:{id:'sync_contract_row',title:'changed'}});
  let capturedBundle=null;
  window.getSupabase=()=>({rpc:async(name,args)=>{
    capturedBundle={name,args};
    return {data:{ok:true,versions:{issues:{sync_contract_row:'2026-08-10T12:35:00.000001+00:00'}}},error:null};
  }});
  const committed=await _v9CommitBundle({issues:{upserts:[versioned],deletes:[]}});
  let conflict=null;
  window.getSupabase=()=>({rpc:async()=>({data:null,error:{code:'40001',message:'RODIOS_SYNC_CONFLICT',details:'issues:sync_contract_row'}})});
  try{ await _v9CommitBundle({issues:{upserts:[versioned],deletes:[]}}); }
  catch(e){ conflict={message:String(e?.message||e),ids:e?.conflictIds||[],code:e?.code||''}; }
  _v9Baseline.issues=new Map([['sync_delete_issue','x']]);
  _v9Baseline.payments=new Map([['sync_delete_payment','x']]);
  _v9RowVersions.issues=new Map([['sync_delete_issue','2026-08-10T13:00:00.000001+00:00']]);
  _v9RowVersions.payments=new Map([['sync_delete_payment','2026-08-10T13:00:00.000002+00:00']]);
  let deleteCalls=0; let deleteBundle=null;
  window.getSupabase=()=>({rpc:async(name,args)=>{
    deleteCalls++; deleteBundle=args.p_bundle;
    return {data:{ok:true,versions:{},deleted:{issues:['sync_delete_issue'],payments:['sync_delete_payment']}},error:null};
  }});
  await _v9DeleteBundle({rodios_issues:['sync_delete_issue'],rodios_payments:['sync_delete_payment']});
  out.atomicSync={expected:versioned.expectedUpdatedAt,capturedBundle,committed,conflict,deleteCalls,deleteBundle,
    deletedBaselinesAbsent:!_v9Baseline.issues.has('sync_delete_issue')&&!_v9Baseline.payments.has('sync_delete_payment')};
  window.getSupabase=originalGetSupabase;

  // 6) PDF acceptance: no/false verification must never authorize acceptance.
  settings.eSignUsers=[{name:'A'},{name:'B'},{name:'C'}];
  const fakePdf='data:application/pdf;base64,'+btoa('%PDF-1.7 /ByteRange [0 10 20 30] /ByteRange [0 10 20 30] /ByteRange [0 10 20 30]');
  const baseWo={id:'wo_sig_test',orderNum:'ΕΝΤ-2099-002',status:'Σε εξέλιξη',signedPdfData:fakePdf,signedPdfName:'fake.pdf',issueId:null};
  workOrders=[structuredClone(baseWo)]; payments=[]; issues=[];
  _sigOrderId='wo_sig_test'; alerts.length=0;
  await finalizeAcceptance();
  out.pdfNoServer={status:workOrders[0].status,protocolReady:!!workOrders[0]._protocolReady,alert:alerts.at(-1)||''};

  workOrders=[{...structuredClone(baseWo),_edgeResult:{verified:false,count:3,signatureCount:3},_edgeSigCount:3}]; payments=[];
  _sigOrderId='wo_sig_test'; alerts.length=0;
  await finalizeAcceptance();
  out.pdfVerifiedFalse={status:workOrders[0].status,protocolReady:!!workOrders[0]._protocolReady,alert:alerts.at(-1)||''};

  // 7) verified:true without a server proof must be blocked before RPC/client creation.
  let noProofRpcCalls=0;
  window.getSupabase=()=>({rpc:async()=>{noProofRpcCalls++; throw new Error('RPC_MUST_NOT_RUN');}});
  workOrders=[{...structuredClone(baseWo),_edgeResult:{verified:true,count:3,signatureCount:3},_edgeSigCount:3}]; payments=[]; issues=[];
  _sigOrderId='wo_sig_test'; alerts.length=0;
  await finalizeAcceptance();
  out.pdfNoProof={status:workOrders[0].status,protocolReady:!!workOrders[0]._protocolReady,paymentCount:payments.length,rpcCalls:noProofRpcCalls,alert:alerts.at(-1)||''};

  // 8) valid proof but failed transaction must leave all local business state untouched.
  let failedRpcCalls=0;
  window.getSupabase=()=>({rpc:async(name,args)=>{failedRpcCalls++; return {data:null,error:{message:'SIMULATED_ATOMIC_RPC_FAILURE'}};}});
  const failingWo={...structuredClone(baseWo),_edgeResult:{verified:true,count:3,signatureCount:3,verificationProofId:'20000000-0000-4000-8000-000000000099'},_edgeSigCount:3};
  workOrders=[failingWo]; payments=[{id:'existing_penalty',orderId:'other',amount:1}]; issues=[{id:'unrelated_issue',status:'Εκκρεμεί'}];
  const beforeFailure=JSON.stringify({workOrders,payments,issues});
  _sigOrderId='wo_sig_test'; alerts.length=0;
  await finalizeAcceptance();
  out.pdfRpcFailure={rpcCalls:failedRpcCalls,stateUnchanged:JSON.stringify({workOrders,payments,issues})===beforeFailure,status:workOrders[0].status,alert:alerts.at(-1)||''};
  window.getSupabase=originalGetSupabase;

  // 9) CSV export neutralizer only changes export representation.
  out.csv={eq:_csvSafeCell('=1+1'),plus:_csvSafeCell('+SUM(A1:A2)'),safe:_csvSafeCell('κανονικό κείμενο')};

  window.alert=originalAlert;
  window.toast=originalToast;
  return out;
});

assert.equal(result.issueBlocked.numberingCalls,0,'failed attachment burned/asked for issue number');
assert.equal(result.issueBlocked.issuesDelta,0,'failed attachment allowed issue persistence');
assert.match(result.issueBlocked.alert,/Retry|μεταφορτωθεί/i,`failed attachment did not show retry/block message; alert=${result.issueBlocked.alert}`);
assert.equal(result.retryFunction,'function','retryIssueAttachment is missing');
assert.equal(result.orderBlocked.ordersDelta,0,'unresolved order media allowed save');
assert.match(result.orderBlocked.toast,/Retry|δεν μεταφορτώθηκαν/i,'unresolved order media did not block save');
assert.equal(result.emailBlocked.threw,true,'unresolved order media allowed email payload');
assert.match(result.emailBlocked.message,/ακυρώθηκε|δεν μεταφορτώθηκαν/i,'email media failure message missing');
assert.equal(result.manageUserBlocked.threw,true,'manager could call manageAppUser');
assert.equal(result.manageUserBlocked.supabaseRequested,false,'manager reached Supabase before client guard');
assert.match(result.manageUserBlocked.message,/Administrator/i,'manager user-management denial message missing');
assert.equal(result.atomicSync.expected,'2026-08-10T12:34:56.123456+00:00','atomic sync changed/lost the exact expected DB version');
assert.equal(result.atomicSync.capturedBundle.name,'rodios_save_bundle','browser did not use the atomic save RPC');
assert.equal(result.atomicSync.capturedBundle.args.p_bundle.issues.upserts[0].expectedUpdatedAt,result.atomicSync.expected,'atomic RPC bundle omitted the expected version');
assert.equal(result.atomicSync.committed.ok,true,'atomic save success response was rejected');
assert.equal(result.atomicSync.conflict.code,'RODIOS_SYNC_CONFLICT','stale atomic write was not mapped to the concurrency error');
assert.deepEqual(result.atomicSync.conflict.ids,['sync_contract_row'],'stale atomic write lost the conflicting row id');
assert.equal(result.atomicSync.deleteCalls,1,'related deletes did not use one atomic RPC');
assert.equal(result.atomicSync.deleteBundle.issues.deletes.length,1,'atomic delete bundle omitted the issue');
assert.equal(result.atomicSync.deleteBundle.payments.deletes.length,1,'atomic delete bundle omitted the payment');
assert.equal(result.atomicSync.deletedBaselinesAbsent,true,'committed atomic deletes remained in the local baseline');
assert.notEqual(result.pdfNoServer.status,'Παραλήφθηκε','PDF without server verification was accepted');
assert.equal(result.pdfNoServer.protocolReady,false,'PDF without server verification set protocolReady');
assert.match(result.pdfNoServer.alert,/κρυπτογραφική επαλήθευση/i,'missing-verifier rejection absent');
assert.notEqual(result.pdfVerifiedFalse.status,'Παραλήφθηκε','verified:false PDF was accepted');
assert.equal(result.pdfVerifiedFalse.protocolReady,false,'verified:false PDF set protocolReady');
assert.equal(result.pdfNoProof.rpcCalls,0,'verified:true without proof reached acceptance RPC');
assert.equal(result.pdfNoProof.status,'Σε εξέλιξη','verified:true without proof changed status');
assert.equal(result.pdfNoProof.paymentCount,0,'verified:true without proof created payment');
assert.match(result.pdfNoProof.alert,/server proof|επαλήθευση είναι παλαιού τύπου/i,'missing proof rejection absent');
assert.equal(result.pdfRpcFailure.rpcCalls,1,'valid proof did not attempt exactly one transactional RPC');
assert.equal(result.pdfRpcFailure.stateUnchanged,true,'failed transactional RPC mutated local business state');
assert.equal(result.pdfRpcFailure.status,'Σε εξέλιξη','failed transactional RPC changed work-order status');
assert.match(result.pdfRpcFailure.alert,/ΔΕΝ ολοκληρώθηκε|δεν έγινε τοπική αλλαγή/i,'transaction failure message missing');
assert.match(result.csv.eq,/^"'/,'formula starting = was not neutralized');
assert.match(result.csv.plus,/^"'/,'formula starting + was not neutralized');
assert.equal(result.csv.safe,'"κανονικό κείμενο"','safe CSV text was unexpectedly altered');
assert.equal(prod.length,0,'failure-path test attempted production Supabase: '+prod.join(', '));
console.log('PASS issue attachment fail-closed + Retry contract');
console.log('PASS order media save/email fail-closed contract');
console.log('PASS non-admin manage-user client guard');
console.log('PASS atomic synchronization exact-version + stale-write contract');
console.log('PASS PDF no/false verification fail-closed contract');
console.log('PASS PDF verified:true without proof blocked before RPC');
console.log('PASS transactional RPC failure leaves local state unchanged');
console.log('PASS CSV formula neutralization');
console.log('FAILURE_PATH_SMOKE_PASS');
await browser.close();
