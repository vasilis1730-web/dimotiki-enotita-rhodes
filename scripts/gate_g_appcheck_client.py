from pathlib import Path

p=Path('index.html')
s=p.read_text(encoding='utf-8')
orig=s

def replace_once(old,new,label):
    global s
    n=s.count(old)
    if n!=1:
        raise SystemExit(f'{label}: expected 1 match, found {n}')
    s=s.replace(old,new,1)

replace_once(
"  import { initializeAppCheck, ReCaptchaV3Provider } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app-check.js';",
"  import { initializeAppCheck, ReCaptchaV3Provider, getToken as getAppCheckToken } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app-check.js';",
'App Check getToken import')

replace_once(
"""  } else {
    console.info('Firebase App Check not enabled: missing reCAPTCHA site key.');
  }

  const _fbAuthInst = getAuth(_fbApp);""",
"""  } else {
    console.info('Firebase App Check not enabled: missing reCAPTCHA site key.');
  }

  // Gate G: custom Supabase citizen backends require a valid Firebase App Check token.
  window._getAppCheckToken = async function(){
    if(!window._appCheck) throw new Error('Firebase App Check is not available');
    const r = await getAppCheckToken(window._appCheck, false);
    if(!r || !r.token) throw new Error('Firebase App Check token is unavailable');
    return r.token;
  };

  const _fbAuthInst = getAuth(_fbApp);""",
'App Check token bridge')

replace_once(
"""async function callCitizenAttachmentsJson(action, payload){
  const idToken = await getIdToken();
  if(!idToken) return {ok:false,noAuth:true};
  try{
    const res = await fetch(CITIZEN_ATTACHMENTS_URL, {
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'apikey':SUPABASE_KEY,
        'x-firebase-id-token':idToken
      },""",
"""async function callCitizenAttachmentsJson(action, payload){
  const idToken = await getIdToken();
  if(!idToken) return {ok:false,noAuth:true};
  let appCheckToken='';
  try{ appCheckToken = window._getAppCheckToken ? await window._getAppCheckToken() : ''; }
  catch(e){ console.warn('App Check token failed:',e); }
  if(!appCheckToken) return {ok:false,status:401,error:'Η ασφαλής επαλήθευση της εφαρμογής δεν είναι διαθέσιμη.'};
  try{
    const res = await fetch(CITIZEN_ATTACHMENTS_URL, {
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'apikey':SUPABASE_KEY,
        'x-firebase-id-token':idToken,
        'x-firebase-appcheck':appCheckToken
      },""",
'JSON attachment App Check header')

replace_once(
"""      const fd=new FormData();
      fd.append('action','upload');
      fd.append('file',f,f.name);
      const res=await fetch(CITIZEN_ATTACHMENTS_URL,{
        method:'POST',
        headers:{'apikey':SUPABASE_KEY,'x-firebase-id-token':idToken},
        body:fd
      });""",
"""      const appCheckToken = window._getAppCheckToken ? await window._getAppCheckToken() : '';
      if(!appCheckToken) throw new Error('Η ασφαλής επαλήθευση της εφαρμογής δεν είναι διαθέσιμη.');
      const fd=new FormData();
      fd.append('action','upload');
      fd.append('file',f,f.name);
      const res=await fetch(CITIZEN_ATTACHMENTS_URL,{
        method:'POST',
        headers:{'apikey':SUPABASE_KEY,'x-firebase-id-token':idToken,'x-firebase-appcheck':appCheckToken},
        body:fd
      });""",
'multipart attachment App Check header')

for required in [
    'getToken as getAppCheckToken',
    'window._getAppCheckToken = async function()',
    "'x-firebase-appcheck':appCheckToken",
]:
    if required not in s:
        raise SystemExit(f'missing invariant: {required}')

# Both attachment transports must send App Check.
if s.count("'x-firebase-appcheck':appCheckToken") != 2:
    raise SystemExit('expected App Check header on exactly two citizen-attachments transport paths')

if s==orig:
    raise SystemExit('patch made no changes')
p.write_text(s,encoding='utf-8')
print('Gate G App Check client patch applied successfully.')
