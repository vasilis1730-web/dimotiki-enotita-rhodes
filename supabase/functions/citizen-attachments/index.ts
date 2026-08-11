import { createClient } from 'npm:@supabase/supabase-js@2.110.9'
import { createRemoteJWKSet, decodeProtectedHeader, importX509, jwtVerify, type JWTPayload } from 'npm:jose@6.2.3'

const FIREBASE_PROJECT_ID = 'dimosrodou-otp'
const FIREBASE_PROJECT_NUMBER = '315292350668'
const FIREBASE_WEB_APP_ID = '1:315292350668:web:8288883847d24ac33e2a69'
const FIREBASE_ISSUER = `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`
const FIREBASE_CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com'
const APP_CHECK_ISSUER = `https://firebaseappcheck.googleapis.com/${FIREBASE_PROJECT_NUMBER}`
const APP_CHECK_AUDIENCE = `projects/${FIREBASE_PROJECT_NUMBER}`
const APP_CHECK_JWKS_URL = 'https://firebaseappcheck.googleapis.com/v1/jwks'
const APP_CHECK_JWKS = createRemoteJWKSet(new URL(APP_CHECK_JWKS_URL))

const BUCKET = 'attachments'
const MAX_FILE_BYTES = 50 * 1024 * 1024
const MAX_MULTIPART_BYTES = MAX_FILE_BYTES + (2 * 1024 * 1024)
const SIGNED_URL_TTL_SECONDS = 15 * 60
const MAX_UPLOADS_PER_HOUR = 20
const MAX_UPLOAD_BYTES_PER_HOUR = 200 * 1024 * 1024

const ALLOWED_ORIGINS = new Set([
  'https://vasilis1730-web.github.io',
])

type FileRule = { contentType: string, acceptedMime: string[] }
const FILE_RULES: Record<string, FileRule> = {
  jpg:  { contentType: 'image/jpeg', acceptedMime: ['image/jpeg', 'image/jpg'] },
  jpeg: { contentType: 'image/jpeg', acceptedMime: ['image/jpeg', 'image/jpg'] },
  png:  { contentType: 'image/png', acceptedMime: ['image/png'] },
  gif:  { contentType: 'image/gif', acceptedMime: ['image/gif'] },
  webp: { contentType: 'image/webp', acceptedMime: ['image/webp'] },
  heic: { contentType: 'image/heic', acceptedMime: ['image/heic', 'image/heif'] },
  heif: { contentType: 'image/heif', acceptedMime: ['image/heif', 'image/heic'] },
  bmp:  { contentType: 'image/bmp', acceptedMime: ['image/bmp', 'image/x-ms-bmp'] },
  tif:  { contentType: 'image/tiff', acceptedMime: ['image/tiff'] },
  tiff: { contentType: 'image/tiff', acceptedMime: ['image/tiff'] },
  pdf:  { contentType: 'application/pdf', acceptedMime: ['application/pdf'] },
  doc:  { contentType: 'application/msword', acceptedMime: ['application/msword'] },
  docx: { contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', acceptedMime: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'] },
  xls:  { contentType: 'application/vnd.ms-excel', acceptedMime: ['application/vnd.ms-excel'] },
  xlsx: { contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', acceptedMime: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'] },
  txt:  { contentType: 'text/plain', acceptedMime: ['text/plain'] },
  zip:  { contentType: 'application/zip', acceptedMime: ['application/zip', 'application/x-zip-compressed'] },
}

let cachedCerts: Record<string, string> | null = null
let certsExpireAt = 0

class HttpError extends Error {
  status: number
  publicMessage: string
  constructor(status: number, publicMessage: string, internalMessage?: string) {
    super(internalMessage || publicMessage)
    this.status = status
    this.publicMessage = publicMessage
  }
}

class UpstreamError extends Error {}

function corsHeaders(req: Request) {
  const origin = req.headers.get('origin') || ''
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': 'content-type, apikey, x-firebase-id-token, x-firebase-appcheck',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  }
  if (ALLOWED_ORIGINS.has(origin)) headers['Access-Control-Allow-Origin'] = origin
  return headers
}

function json(req: Request, status: number, payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

function getAdminClient() {
  const url = Deno.env.get('SUPABASE_URL')
  let key = Deno.env.get('SUPABASE_SECRET_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
  if (!key) {
    try {
      const named = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}')
      key = String(named.default || Object.values(named)[0] || '')
    } catch (_) {}
  }
  if (!url || !key) throw new Error('Server Storage credentials are not configured')
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

function parseMaxAge(value: string | null): number {
  const m = String(value || '').match(/(?:^|,)\s*max-age=(\d+)/i)
  return m ? Math.max(60, Number(m[1]) || 300) : 300
}

async function getFirebaseCerts(): Promise<Record<string, string>> {
  const now = Date.now()
  if (cachedCerts && now < certsExpireAt) return cachedCerts
  const res = await fetch(FIREBASE_CERTS_URL, { headers: { 'Accept': 'application/json' } })
  if (!res.ok) throw new UpstreamError(`Firebase certificate endpoint returned ${res.status}`)
  const certs = await res.json()
  if (!certs || typeof certs !== 'object') throw new UpstreamError('Firebase certificate response is invalid')
  cachedCerts = certs as Record<string, string>
  certsExpireAt = now + parseMaxAge(res.headers.get('cache-control')) * 1000
  return cachedCerts
}

type FirebasePayload = JWTPayload & {
  phone_number?: string
  firebase?: { sign_in_provider?: string, identities?: Record<string, unknown> }
  auth_time?: number
}

async function verifyFirebaseIdToken(token: string): Promise<FirebasePayload> {
  if (!token || token.length > 20000) throw new Error('Missing or malformed Firebase ID token')
  const header = decodeProtectedHeader(token)
  if (header.alg !== 'RS256' || !header.kid) throw new Error('Invalid Firebase token header')

  const certs = await getFirebaseCerts()
  const cert = certs[String(header.kid)]
  if (!cert) throw new Error('Firebase signing key is unknown or expired')
  const key = await importX509(cert, 'RS256')
  const { payload } = await jwtVerify(token, key, {
    algorithms: ['RS256'],
    audience: FIREBASE_PROJECT_ID,
    issuer: FIREBASE_ISSUER,
  })
  const p = payload as FirebasePayload
  const now = Math.floor(Date.now() / 1000)
  if (!p.sub || typeof p.sub !== 'string' || p.sub.length > 128) throw new Error('Firebase subject is invalid')
  if (!p.iat || p.iat > now + 60) throw new Error('Firebase issued-at time is invalid')
  if (!p.auth_time || p.auth_time > now + 60) throw new Error('Firebase authentication time is invalid')
  if (p.firebase?.sign_in_provider !== 'phone') throw new Error('Firebase phone authentication is required')
  if (!p.phone_number) throw new Error('Verified phone number is missing from Firebase token')
  return p
}

async function verifyAppCheckToken(token: string): Promise<JWTPayload> {
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
}

function normalizePhone(phone: string): string {
  return String(phone || '').replace(/\D/g, '')
}

function safeFileName(name: string): string {
  const cleaned = String(name || 'file')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120)
  return cleaned || 'file'
}

function extensionOf(name: string): string {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/)
  return m ? m[1] : ''
}

function assertAllowedFile(file: File): { ext: string, rule: FileRule } {
  if (!(file instanceof File)) throw new HttpError(400, 'Δεν βρέθηκε αρχείο.')
  if (file.size <= 0) throw new HttpError(400, 'Δεν επιτρέπονται κενά αρχεία.')
  if (file.size > MAX_FILE_BYTES) throw new HttpError(413, 'Το αρχείο ξεπερνά το όριο των 50 MB.')

  const ext = extensionOf(file.name)
  const rule = FILE_RULES[ext]
  if (!rule) throw new HttpError(400, 'Ο τύπος αρχείου δεν επιτρέπεται.')

  const declared = String(file.type || '').toLowerCase().trim()
  if (declared && declared !== 'application/octet-stream' && !rule.acceptedMime.includes(declared)) {
    throw new HttpError(400, 'Ο τύπος του αρχείου δεν συμφωνεί με την επέκτασή του.')
  }
  return { ext, rule }
}

function startsWith(bytes: Uint8Array, sig: number[]): boolean {
  return bytes.length >= sig.length && sig.every((b, i) => bytes[i] === b)
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  if (bytes.length < start + length) return ''
  return String.fromCharCode(...bytes.slice(start, start + length))
}

function assertFileSignature(bytes: Uint8Array, ext: string) {
  let ok = false
  if (ext === 'jpg' || ext === 'jpeg') ok = startsWith(bytes, [0xff, 0xd8, 0xff])
  else if (ext === 'png') ok = startsWith(bytes, [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])
  else if (ext === 'gif') ok = ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a'
  else if (ext === 'webp') ok = ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP'
  else if (ext === 'bmp') ok = ascii(bytes, 0, 2) === 'BM'
  else if (ext === 'tif' || ext === 'tiff') ok = startsWith(bytes, [0x49,0x49,0x2a,0x00]) || startsWith(bytes, [0x4d,0x4d,0x00,0x2a])
  else if (ext === 'heic' || ext === 'heif') ok = ascii(bytes, 4, 4) === 'ftyp'
  else if (ext === 'pdf') ok = ascii(bytes, 0, 5) === '%PDF-'
  else if (ext === 'doc' || ext === 'xls') ok = startsWith(bytes, [0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1])
  else if (ext === 'docx' || ext === 'xlsx' || ext === 'zip') {
    ok = startsWith(bytes, [0x50,0x4b,0x03,0x04]) || startsWith(bytes, [0x50,0x4b,0x05,0x06]) || startsWith(bytes, [0x50,0x4b,0x07,0x08])
  } else if (ext === 'txt') {
    const sample = bytes.slice(0, Math.min(bytes.length, 8192))
    ok = !sample.includes(0)
  }
  if (!ok) throw new HttpError(400, 'Το περιεχόμενο του αρχείου δεν συμφωνεί με τον δηλωμένο τύπο.')
}

function pathBelongsToPhone(path: string, phoneDigits: string): boolean {
  const normalized = String(path || '').replace(/^\/+/, '')
  if (!normalized || normalized.split('/').some((part) => part === '.' || part === '..')) return false
  const legacyPhoneDigits = phoneDigits.startsWith('30') ? phoneDigits.slice(2) : phoneDigits
  return normalized.startsWith(`citizen/${phoneDigits}/`) || normalized.startsWith(`citizen/${legacyPhoneDigits}/`)
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function authenticate(req: Request) {
  const idToken = req.headers.get('x-firebase-id-token') || ''
  const appCheckToken = req.headers.get('x-firebase-appcheck') || ''
  if (!idToken || !appCheckToken) throw new HttpError(401, 'Η ασφαλής ταυτοποίηση της εφαρμογής απέτυχε.')

  try {
    const [claims] = await Promise.all([
      verifyFirebaseIdToken(idToken),
      verifyAppCheckToken(appCheckToken),
    ])
    const phoneDigits = normalizePhone(claims.phone_number || '')
    if (!/^3069\d{8}$/.test(phoneDigits)) throw new Error('Verified Greek mobile phone is invalid')
    const identityHash = await sha256Hex(claims.sub || '')
    return { claims, phoneDigits, identityHash }
  } catch (err) {
    if (err instanceof UpstreamError) throw err
    throw new HttpError(401, 'Η ασφαλής ταυτοποίηση της εφαρμογής απέτυχε.', err instanceof Error ? err.message : 'Authentication failed')
  }
}

async function consumeUploadQuota(admin: ReturnType<typeof getAdminClient>, identityHash: string, bytes: number) {
  const { data, error } = await admin.rpc('rodios_consume_citizen_upload_quota', {
    p_identity_hash: identityHash,
    p_bytes: bytes,
    p_max_count: MAX_UPLOADS_PER_HOUR,
    p_max_bytes: MAX_UPLOAD_BYTES_PER_HOUR,
  })
  if (error) throw new Error(`Citizen upload quota RPC failed: ${error.code || 'unknown'}`)
  if (!data || data.allowed !== true) {
    throw new HttpError(429, 'Έχει ξεπεραστεί προσωρινά το όριο μεταφόρτωσης αρχείων. Δοκιμάστε ξανά αργότερα.')
  }
}

async function consumeActionQuota(admin: ReturnType<typeof getAdminClient>, identityHash: string, action: 'sign' | 'remove') {
  const limits = { sign: 240, remove: 120 }
  const { data, error } = await admin.rpc('rodios_consume_edge_quota', {
    p_scope: `citizen-attachments:${action}`,
    p_actor_key: identityHash,
    p_limit: limits[action],
  })
  if (error) throw new Error(`Attachment action quota RPC failed: ${error.message}`)
  if (data !== true) throw new HttpError(429, 'Πάρα πολλές αιτήσεις. Δοκιμάστε ξανά αργότερα.')
}

async function assertAttachmentIsUnreferenced(admin: ReturnType<typeof getAdminClient>, path: string) {
  const { data, error } = await admin
    .from('rodios_issues')
    .select('id')
    .is('deleted_at', null)
    .contains('data', { attachments: [{ path }] })
    .limit(1)
  if (error) throw new Error(`Attachment reference check failed: ${error.message}`)
  if ((data || []).length) {
    throw new HttpError(409, 'Το συνημμένο εξακολουθεί να χρησιμοποιείται από καταχωρισμένο αίτημα.')
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req) })
  if (req.method !== 'POST') return json(req, 405, { ok: false, error: 'Method not allowed' })

  const origin = req.headers.get('origin') || ''
  if (origin && !ALLOWED_ORIGINS.has(origin)) return json(req, 403, { ok: false, error: 'Origin not allowed' })

  const declaredLength = Number(req.headers.get('content-length') || '0')
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MULTIPART_BYTES) {
    return json(req, 413, { ok: false, error: 'Το αίτημα μεταφόρτωσης είναι υπερβολικά μεγάλο.' })
  }

  try {
    const { phoneDigits, identityHash } = await authenticate(req)
    const admin = getAdminClient()
    const contentType = req.headers.get('content-type') || ''

    if (contentType.includes('multipart/form-data')) {
      let form: FormData
      try { form = await req.formData() } catch (_) { throw new HttpError(400, 'Μη έγκυρη μεταφόρτωση αρχείου.') }
      const action = String(form.get('action') || 'upload')
      if (action !== 'upload') throw new HttpError(400, 'Μη έγκυρη ενέργεια μεταφόρτωσης.')
      const file = form.get('file')
      if (!(file instanceof File)) throw new HttpError(400, 'Δεν βρέθηκε αρχείο.')
      const { ext, rule } = assertAllowedFile(file)

      const bytes = new Uint8Array(await file.arrayBuffer())
      assertFileSignature(bytes, ext)
      await consumeUploadQuota(admin, identityHash, file.size)

      const safe = safeFileName(file.name)
      const random = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
      const path = `citizen/${phoneDigits}/${Date.now()}_${random}_${safe}`
      const { error } = await admin.storage.from(BUCKET).upload(path, bytes, {
        upsert: false,
        cacheControl: '3600',
        contentType: rule.contentType,
      })
      if (error) throw new Error(`Storage upload failed: ${error.message}`)

      return json(req, 200, {
        ok: true,
        attachment: { name: file.name, type: rule.contentType, size: file.size, path },
      })
    }

    if (!contentType.includes('application/json')) throw new HttpError(415, 'Μη υποστηριζόμενος τύπος αιτήματος.')
    let body: Record<string, unknown>
    try { body = await req.json() } catch (_) { throw new HttpError(400, 'Μη έγκυρο αίτημα.') }
    const action = String(body?.action || '')
    if (action !== 'sign' && action !== 'remove') throw new HttpError(400, 'Άγνωστη ενέργεια.')
    await consumeActionQuota(admin, identityHash, action)

    if (action === 'sign') {
      const rawPaths = Array.isArray(body?.paths) ? body.paths : []
      const paths = [...new Set(rawPaths.map((x: unknown) => String(x || '')).filter(Boolean))].slice(0, 50)
      if (!paths.length) return json(req, 200, { ok: true, urls: {} })
      for (const path of paths) {
        if (!pathBelongsToPhone(path, phoneDigits)) throw new HttpError(403, 'Δεν επιτρέπεται πρόσβαση στο συγκεκριμένο συνημμένο.')
      }
      const urls: Record<string, string> = {}
      for (const path of paths) {
        const { data, error } = await admin.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_TTL_SECONDS)
        if (!error && data?.signedUrl) urls[path] = data.signedUrl
      }
      return json(req, 200, { ok: true, urls, expiresIn: SIGNED_URL_TTL_SECONDS })
    }

    if (action === 'remove') {
      const path = String(body?.path || '')
      if (!pathBelongsToPhone(path, phoneDigits)) throw new HttpError(403, 'Δεν επιτρέπεται διαγραφή του συγκεκριμένου συνημμένου.')
      await assertAttachmentIsUnreferenced(admin, path)
      const { error } = await admin.storage.from(BUCKET).remove([path])
      if (error) throw new Error(`Storage delete failed: ${error.message}`)
      return json(req, 200, { ok: true })
    }

    throw new HttpError(400, 'Άγνωστη ενέργεια.')
  } catch (err) {
    const internalMessage = err instanceof Error ? err.message : 'Request failed'
    console.warn('[citizen-attachments]', internalMessage)

    if (err instanceof HttpError) {
      return json(req, err.status, { ok: false, error: err.publicMessage })
    }
    if (err instanceof UpstreamError) {
      return json(req, 503, { ok: false, error: 'Η υπηρεσία ασφαλούς ταυτοποίησης δεν είναι προσωρινά διαθέσιμη.' })
    }
    return json(req, 500, { ok: false, error: 'Η μεταφόρτωση δεν ολοκληρώθηκε λόγω εσωτερικού σφάλματος.' })
  }
})
