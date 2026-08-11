import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const ORIGIN='http://127.0.0.1:4173';
const PROD_SUPABASE_REF='nzrdcgmrsfdmocyhfrod';
const launchOptions={headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})};
const CDN_HOSTS=new Set(['cdn.jsdelivr.net','www.gstatic.com']);

async function addSafeRouting(page, productionRequests){
  page.on('request',req=>{ if(req.url().includes(PROD_SUPABASE_REF)) productionRequests.push(req.url()); });
  await page.route('**/*', async route=>{
    const u=new URL(route.request().url());
    if(u.origin===ORIGIN || CDN_HOSTS.has(u.hostname)) return route.continue();
    return route.abort('blockedbyclient');
  });
}

async function mobileCheck(path){
  const browser=await chromium.launch(launchOptions);
  const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
  const page=await context.newPage();
  const productionRequests=[];
  await addSafeRouting(page,productionRequests);
  const r=await page.goto(ORIGIN+path,{waitUntil:'domcontentloaded',timeout:45000});
  assert(r&&r.ok(),`${path}: mobile load failed`);
  await page.waitForTimeout(1200);
  const dims=await page.evaluate(()=>({
    width:innerWidth,
    doc:document.documentElement.scrollWidth,
    body:document.body.scrollWidth,
    text:document.body.innerText.trim().length
  }));
  assert(dims.text>20,`${path}: mobile body empty`);
  assert(dims.doc<=dims.width+2,`${path}: document horizontal overflow ${dims.doc}>${dims.width}`);
  assert(dims.body<=dims.width+2,`${path}: body horizontal overflow ${dims.body}>${dims.width}`);
  assert.equal(productionRequests.length,0,`${path}: mobile test attempted production Supabase`);
  console.log(`PASS mobile ${path} | viewport=${dims.width} | docWidth=${dims.doc}`);
  await browser.close();
}

async function offlineShell(path){
  const browser=await chromium.launch(launchOptions);
  const context=await browser.newContext({serviceWorkers:'allow'});
  const page=await context.newPage();
  const productionRequests=[];
  await addSafeRouting(page,productionRequests);

  let r=await page.goto(ORIGIN+path,{waitUntil:'domcontentloaded',timeout:45000});
  assert(r&&r.ok(),`${path}: initial online shell load failed`);
  await page.evaluate(async()=>{ if('serviceWorker' in navigator) await navigator.serviceWorker.ready; });
  // Reload once while online so the active Network-First worker caches this navigation.
  r=await page.reload({waitUntil:'domcontentloaded',timeout:45000});
  assert(r&&r.ok(),`${path}: service-worker controlled online reload failed`);
  const onlineTitle=await page.title();

  await context.setOffline(true);
  await page.reload({waitUntil:'domcontentloaded',timeout:45000});
  const offlineTitle=await page.title();
  const offlineBody=(await page.locator('body').innerText()).trim();
  assert(offlineBody.length>20,`${path}: cached offline shell did not render`);
  assert.equal(offlineTitle,onlineTitle,`${path}: offline shell title changed unexpectedly`);

  await context.setOffline(false);
  r=await page.reload({waitUntil:'domcontentloaded',timeout:45000});
  assert(r&&r.ok(),`${path}: reconnect reload failed`);
  assert.equal(productionRequests.length,0,`${path}: offline/reconnect test attempted production Supabase`);
  console.log(`PASS offline/reconnect ${path}`);
  await browser.close();
}

await mobileCheck('/index.html');
await mobileCheck('/aftepistasia.html');
await offlineShell('/index.html');
await offlineShell('/aftepistasia.html');
console.log('MOBILE_OFFLINE_SMOKE_PASS');
