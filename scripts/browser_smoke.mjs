// Gate H localhost smoke — production-network isolated.
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
  async p=>assert.match(await p.locator('body').innerText(),/ΡΟΔΙΟΣ/,'citizen branding missing'),
  async p=>{
    await p.waitForFunction(()=>window._fbReady===true,null,{timeout:15000});
    const firebaseSurface=await p.evaluate(()=>({
      auth:!!window._fbAuth,
      recaptcha:typeof window._RecaptchaVerifier,
      signIn:typeof window._signInWithPhoneNumber,
      appCheck:typeof window._getAppCheckToken,
    }));
    assert.equal(firebaseSurface.auth,true,'Firebase 12 Auth did not initialize');
    assert.equal(firebaseSurface.recaptcha,'function','Firebase 12 RecaptchaVerifier missing');
    assert.equal(firebaseSurface.signIn,'function','Firebase 12 phone sign-in API missing');
    assert.equal(firebaseSurface.appCheck,'function','Firebase 12 App Check API missing');
    console.log('PASS Firebase 12 browser API initialization');
  }
],[/Firebase: Error \(auth\/internal-error\)/]);

await smoke('/aftepistasia.html',[
  async p=>assert.match(await p.locator('body').innerText(),/ΡΟΔΙΟΣ|Αυτεπιστασία|Αιτήματα/,'staff shell did not render'),
  async p=>{
    const roles=await p.evaluate(async()=>{
      const settingsBtn=()=>Array.from(document.querySelectorAll('nav button')).find(b=>b.textContent.includes('Ρυθμίσεις'));
      const probe=(u)=>{
        currentUser=u;
        updateHeader();
        const btn=settingsBtn();
        return {tier:userTier(u),perm:permSettings(),display:btn?getComputedStyle(btn).display:'missing'};
      };
      const admin=probe({id:'admin',email:'rodios-admin-staging@rhodes.gr',tier:'admin',canOrders:true});
      const manager=probe({id:'stg_manager',email:'manager@example.invalid',tier:'manager',canOrders:true});
      const user=probe({id:'stg_user',email:'user@example.invalid',tier:'user',canOrders:true});

      currentUser={id:'stg_manager',email:'manager@example.invalid',tier:'manager',canOrders:true};
      currentTab='dashboard';
      showTab('settings');
      const managerTabAfterAttempt=currentTab;

      currentUser={id:'admin',email:'rodios-admin-staging@rhodes.gr',tier:'admin',canOrders:true};
      currentTab='dashboard';
      showTab('settings');
      const adminTabAfterAttempt=currentTab;

      localStorage.setItem('rodios_v9_light_cache','sensitive');
      localStorage.setItem('rodios_v9_last_counts','sensitive');
      localStorage.setItem('serviceStaff','sensitive');
      localStorage.setItem('sb_url','legacy-override');
      localStorage.setItem('sb_key','legacy-override');
      await _purgeOperationalBrowserState();
      const purge={};
      for(const k of ['rodios_v9_light_cache','rodios_v9_last_counts','serviceStaff','sb_url','sb_key']) purge[k]=localStorage.getItem(k);

      return {admin,manager,user,managerTabAfterAttempt,adminTabAfterAttempt,purge};
    });

    assert.equal(roles.admin.tier,'admin','admin tier resolution failed');
    assert.equal(roles.admin.perm,true,'admin Settings permission denied');
    assert.notEqual(roles.admin.display,'none','admin Settings nav hidden');
    assert.equal(roles.manager.tier,'manager','manager tier resolution failed');
    assert.equal(roles.manager.perm,false,'manager gained Settings permission');
    assert.equal(roles.manager.display,'none','manager Settings nav visible');
    assert.equal(roles.user.tier,'user','user tier resolution failed');
    assert.equal(roles.user.perm,false,'user gained Settings permission');
    assert.equal(roles.user.display,'none','user Settings nav visible');
    assert.equal(roles.managerTabAfterAttempt,'dashboard','manager opened Settings tab');
    assert.equal(roles.adminTabAfterAttempt,'settings','admin could not open Settings tab');
    for(const [k,v] of Object.entries(roles.purge)) assert.equal(v,null,`logout purge left ${k}`);
    console.log('PASS staff role/UI/cache invariants');
  }
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
