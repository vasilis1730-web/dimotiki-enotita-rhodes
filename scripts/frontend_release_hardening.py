from pathlib import Path

CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://www.gstatic.com https://www.google.com https://www.recaptcha.net; style-src 'self' 'unsafe-inline'; connect-src 'self' https://*.supabase.co https://*.googleapis.com https://securetoken.googleapis.com https://identitytoolkit.googleapis.com https://firebaseappcheck.googleapis.com https://www.google.com https://www.recaptcha.net; img-src 'self' data: blob: https:; media-src 'self' data: blob: https:; frame-src 'self' data: blob: https://*.supabase.co https://www.google.com https://www.recaptcha.net; worker-src 'self' blob:; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'"
PINNED = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.110.9'
UNPINNED = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'


def patch(path, manifest):
    p=Path(path)
    s=p.read_text(encoding='utf-8')
    orig=s
    if s.count(UNPINNED) != 1:
        raise SystemExit(f'{path}: expected exactly one unpinned Supabase script, found {s.count(UNPINNED)}')
    s=s.replace(UNPINNED,PINNED,1)

    viewport='<meta name="viewport" content="width=device-width, initial-scale=1.0">'
    if viewport not in s:
        # ACK uses integer value without .0
        viewport='<meta name="viewport" content="width=device-width, initial-scale=1">'
    if s.count(viewport) != 1:
        raise SystemExit(f'{path}: viewport marker missing/ambiguous')
    insert=viewport+f'\n<meta http-equiv="Content-Security-Policy" content="{CSP}">\n<meta name="theme-color" content="#1a3a5c">'
    if manifest:
        insert += f'\n<link rel="manifest" href="{manifest}">' 
    s=s.replace(viewport,insert,1)

    if PINNED not in s:
        raise SystemExit(f'{path}: pinned Supabase dependency missing')
    if UNPINNED in s:
        raise SystemExit(f'{path}: unpinned Supabase dependency remains')
    if 'Content-Security-Policy' not in s:
        raise SystemExit(f'{path}: CSP missing')
    if manifest and f'href="{manifest}"' not in s:
        raise SystemExit(f'{path}: manifest link missing')
    if s == orig:
        raise SystemExit(f'{path}: no changes')
    p.write_text(s,encoding='utf-8')

patch('index.html','manifest.json')
patch('aftepistasia.html','manifest-staff.json')
patch('ack.html',None)
print('frontend release hardening applied')
