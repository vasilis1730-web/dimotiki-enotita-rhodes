from pathlib import Path
import re

p = Path('supabase/functions/citizen-attachments/index.ts')
s = p.read_text(encoding='utf-8')
orig = s


def once(old: str, new: str, label: str):
    global s
    n = s.count(old)
    if n != 1:
        raise SystemExit(f'{label}: expected exactly 1 match, found {n}')
    s = s.replace(old, new, 1)

once(
    "import { decodeProtectedHeader, importJWK, importX509, jwtVerify, type JWTPayload } from 'npm:jose@6.2.3'",
    "import { createRemoteJWKSet, decodeProtectedHeader, importX509, jwtVerify, type JWTPayload } from 'npm:jose@6.2.3'",
    'jose import',
)

once(
    "const APP_CHECK_JWKS_URL = 'https://firebaseappcheck.googleapis.com/v1/jwks'",
    "const APP_CHECK_JWKS_URL = 'https://firebaseappcheck.googleapis.com/v1/jwks'\nconst APP_CHECK_JWKS = createRemoteJWKSet(new URL(APP_CHECK_JWKS_URL))",
    'remote JWKS constant',
)

once(
    "let cachedAppCheckJwks: Array<Record<string, unknown>> | null = null\nlet appCheckJwksExpireAt = 0\n",
    "",
    'manual JWK cache variables',
)

pattern = re.compile(
    r"async function getAppCheckJwks\(\): Promise<Array<Record<string, unknown>>> \{.*?\n\}\n\n(?=type FirebasePayload)",
    re.S,
)
s, n = pattern.subn('', s, count=1)
if n != 1:
    raise SystemExit(f'manual getAppCheckJwks block: expected exactly 1 match, found {n}')

old_verify = """async function verifyAppCheckToken(token: string): Promise<JWTPayload> {
  if (!token || token.length > 20000) throw new Error('Missing or malformed Firebase App Check token')
  const header = decodeProtectedHeader(token)
  if (header.alg !== 'RS256' || header.typ !== 'JWT' || !header.kid) throw new Error('Invalid Firebase App Check header')
  const jwks = await getAppCheckJwks()
  const jwk = jwks.find((x) => String(x?.kid || '') === String(header.kid))
  if (!jwk) throw new Error('Firebase App Check signing key is unknown or expired')
  const key = await importJWK(jwk as any, 'RS256')
  const { payload } = await jwtVerify(token, key, {
    algorithms: ['RS256'],
    audience: APP_CHECK_AUDIENCE,
    issuer: APP_CHECK_ISSUER,
    subject: FIREBASE_WEB_APP_ID,
  })
  return payload
}"""
new_verify = """async function verifyAppCheckToken(token: string): Promise<JWTPayload> {
  if (!token || token.length > 20000) throw new Error('Missing or malformed Firebase App Check token')
  const header = decodeProtectedHeader(token)
  if (header.alg !== 'RS256' || header.typ !== 'JWT' || !header.kid) throw new Error('Invalid Firebase App Check header')
  const { payload } = await jwtVerify(token, APP_CHECK_JWKS, {
    algorithms: ['RS256'],
    audience: APP_CHECK_AUDIENCE,
    issuer: APP_CHECK_ISSUER,
  })
  if (payload.sub !== FIREBASE_WEB_APP_ID) throw new Error('Firebase App Check app ID is not authorized')
  return payload
}"""
once(old_verify, new_verify, 'App Check verifier')

for forbidden in ('importJWK', 'getAppCheckJwks', 'cachedAppCheckJwks', 'appCheckJwksExpireAt'):
    if forbidden in s:
        raise SystemExit(f'forbidden manual-JWK pattern remains: {forbidden}')

for required in (
    'createRemoteJWKSet',
    'const APP_CHECK_JWKS = createRemoteJWKSet(new URL(APP_CHECK_JWKS_URL))',
    'jwtVerify(token, APP_CHECK_JWKS',
    'payload.sub !== FIREBASE_WEB_APP_ID',
):
    if required not in s:
        raise SystemExit(f'required remote-JWKS invariant missing: {required}')

if s == orig:
    raise SystemExit('patch made no changes')

p.write_text(s, encoding='utf-8')
print('Gate G remote JWKS patch applied successfully.')
