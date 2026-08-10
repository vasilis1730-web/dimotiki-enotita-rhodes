from pathlib import Path
import re

CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://www.gstatic.com https://www.google.com https://www.recaptcha.net; style-src 'self' 'unsafe-inline'; connect-src 'self' https://*.supabase.co https://*.googleapis.com https://securetoken.googleapis.com https://identitytoolkit.googleapis.com https://firebaseappcheck.googleapis.com https://www.google.com https://www.recaptcha.net; img-src 'self' data: blob: https:; media-src 'self' data: blob: https:; frame-src 'self' data: blob: https://*.supabase.co https://www.google.com https://www.recaptcha.net; worker-src 'self' blob:; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'"
UNPINNED_TAG = '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>'
PINNED_TAG = '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.110.9"></script>'


def patch(path, manifest):
    p=Path(path)
    s=p.read_text(encoding='utf-8')
    orig=s
    if s.count(UNPINNED_TAG) != 1:
        raise SystemExit(f'{path}: expected exactly one unpinned Supabase script tag, found {s.count(UNPINNED_TAG)}')
    s=s.replace(UNPINNED_TAG,PINNED_TAG,1)

    viewports=list(re.finditer(r'<meta\s+name=["\']viewport["\'][^>]*>',s,re.I))
    if len(viewports)!=1:
        raise SystemExit(f'{path}: expected one viewport tag, found {len(viewports)}')
    viewport=viewports[0].group(0)
    csp_tag=f'<meta http-equiv="Content-Security-Policy" content="{CSP}">'
    s=s[:viewports[0].end()]+'\n'+csp_tag+s[viewports[0].end():]

    # Normalize theme-color to one release value rather than duplicating existing metadata.
    theme_re=re.compile(r'<meta\s+name=["\']theme-color["\'][^>]*>',re.I)
    themes=list(theme_re.finditer(s))
    if len(themes)>1:
        raise SystemExit(f'{path}: multiple theme-color tags already exist')
    theme='<meta name="theme-color" content="#1a3a5c">'
    if themes:
        s=s[:themes[0].start()]+theme+s[themes[0].end():]
    else:
        pos=s.find(csp_tag)+len(csp_tag)
        s=s[:pos]+'\n'+theme+s[pos:]

    manifests=list(re.finditer(r'<link\s+rel=["\']manifest["\'][^>]*>',s,re.I))
    if manifest:
        desired=f'<link rel="manifest" href="{manifest}">'
        if len(manifests)>1:
            raise SystemExit(f'{path}: multiple manifest links already exist')
        if manifests:
            current=manifests[0].group(0)
            href=re.search(r'href=["\']([^"\']+)["\']',current,re.I)
            if not href or href.group(1)!=manifest:
                raise SystemExit(f'{path}: unexpected existing manifest {href.group(1) if href else current}')
        else:
            pos=s.find(theme)+len(theme)
            s=s[:pos]+'\n'+desired+s[pos:]
    elif manifests:
        raise SystemExit(f'{path}: ACK page unexpectedly contains a manifest')

    if s.count(PINNED_TAG) != 1 or UNPINNED_TAG in s:
        raise SystemExit(f'{path}: dependency pin invariant failed')
    if s.count('Content-Security-Policy') != 1:
        raise SystemExit(f'{path}: CSP missing or duplicated')
    if s.count('name="theme-color"') != 1:
        raise SystemExit(f'{path}: theme-color invariant failed')
    if manifest and len(list(re.finditer(r'<link\s+rel=["\']manifest["\'][^>]*>',s,re.I))) != 1:
        raise SystemExit(f'{path}: manifest invariant failed')
    if s == orig:
        raise SystemExit(f'{path}: no changes')
    p.write_text(s,encoding='utf-8')

patch('index.html','manifest.json')
patch('aftepistasia.html','manifest-staff.json')
patch('ack.html',None)
print('frontend release hardening applied')
