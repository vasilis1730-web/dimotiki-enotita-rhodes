// Gate H localhost smoke — rerun after Gate E syntax repair.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const ORIGIN='http://127.0.0.1:4173';
const PROD_SUPABASE_REF='nzrdcgmrsfdmocyhfrod';
const allowedStaticHosts=new Set(['cdn.jsdelivr.net','www.gstatic.com']);

async function smoke(path, checks=[], allowedPageErrors=[]) {
  const browser=await chromium.launch({headless:true});
  const context=await browser.newContext({serviceWorkers:'block'});
  const page=await context.newPage();
  const pageErrors=[];
  const productionRequests=[];
  const blocked=[];

  page.on('pageerror', err=>pageErrors.push(String(err?.stack||err?.message||err)));
  page.on('request', req=>{
    if(req.url().includes(PROD_SUPABASE_REF)) productionRequests.push(req.url());
  });

  await page.route('**/*', async route=>{
    const u=new URL(route.request().url());
    if(u.origin===ORIGIN || allowedStaticHosts.has(u.hostname)) return route.continue();
    blocked.push(u.href);
    return route.abort('blockedbyclient');
  });

  const response=await page.goto(ORIGIN+path,{waitUntil:'domcontentloaded',timeout:45000});
  assert(response && response.ok(), `${path}: HTTP load failed`);
  await page.waitForTimeout(1800);

  const title=await page.title();
  assert(title && title.trim().length>0, `${path}: empty title`);
  const bodyText=(await page.locator('body').innerText()).trim();
  assert(bodyText.length>20, `${path}: body did not render`);

  for(const check of checks) await check(page);

  assert.equal(productionRequests.length,0,`${path}: attempted production Supabase request(s): ${productionRequests.join(', ')}`);
  const unexpectedErrors=pageErrors.filter(msg=>!allowedPageErrors.some(re=>re.test(msg)));
  assert.equal(unexpectedErrors.length,0,`${path}: unexpected pageerror(s): ${unexpectedErrors.join(' | ')}`);

  console.log(`PASS ${path} | title=${JSON.stringify(title)} | blockedExternal=${blocked.length} | expectedBlockedErrors=${pageErrors.length-unexpectedErrors.length}`);
  await browser.close();
}

await smoke('/index.html',[
  async p=>assert.equal(await p.locator('#loginScreen').count(),1,'citizen login screen missing'),
  async p=>assert.match(await p.locator('body').innerText(),/ΡΟΔΙΟΣ/,'citizen branding missing')
],[/Firebase: Error \(auth\/internal-error\)/]);

await smoke('/aftepistasia.html',[
  async p=>assert.match(await p.locator('body').innerText(),/ΡΟΔΙΟΣ|Αυτεπιστασία|Αιτήματα/,'staff shell did not render')
]);

await smoke('/ack.html',[
  async p=>assert.match(await p.locator('body').innerText(),/Δήλωση|Ολοκλήρωση|εργασ/i,'ACK shell did not render')
]);

for(const file of ['manifest.json','manifest-staff.json']) {
  const r=await fetch(`${ORIGIN}/${file}`);
  assert(r.ok,`${file}: fetch failed`);
  const m=await r.json();
  assert(m.start_url && m.scope && m.id,`${file}: required PWA fields missing`);
  assert(!String(m.start_url).includes('dimotiki-enotita-rhodes'),`${file}: staging manifest still hardcodes production project path`);
  console.log(`PASS ${file} | start_url=${m.start_url}`);
}

console.log('BROWSER_SMOKE_PASS');
