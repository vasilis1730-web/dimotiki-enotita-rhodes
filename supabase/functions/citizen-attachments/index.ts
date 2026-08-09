import { createClient } from 'npm:@supabase/supabase-js@2.110.9'
import { decodeProtectedHeader, importX509, jwtVerify, type JWTPayload } from 'npm:jose@6.2.3'

const FIREBASE_PROJECT_ID = 'dimosrodou-otp'
const FIREBASE_ISSUER = `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`
const FIREBASE_CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com'
const BUCKET = 'attachments'
const MAX_FILE_BYTES = 50 * 1024 * 1024
const SIGNED_URL_TTL_SECONDS = 15 * 60

const ALLOWED_ORIGINS = new Set([
  'https://vasilis1730-web.github.io',
])

const ALLOWED_EXTENSIONS = new Set([
  'jpg','jpeg','png','gif','webp','heic','heif','bmp','tif','tiff',
  'pdf','doc','docx','xls','xlsx','txt','zip'
])

let cachedCerts: Record<string, string> | null = null
let certsExpireAt = 0

function corsHeaders(req: Request) {
  const origin = req.headers.get('origin') || ''
  const allowOrigin = ALLOWED_ORIGINS.has(origin) ? origin : 'https://vasilis1730-web.github.io'
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'content-type, apikey, x-firebase-id-token',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  }
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
  if (!res.ok) throw new Error(`Firebase certificate endpoint returned ${res.status}`)
  const certs = await res.json()
  if (!certs || typeof certs !== 'object') throw new Error('Firebase certificate response is invalid')
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

function assertAllowedFile(file: File) {
  if (!(file instanceof File)) throw new Error('Missing file')
  if (file.size <= 0) throw new Error('Empty files are not allowed')
  if (file.size > MAX_FILE_BYTES) throw new Error('File exceeds 50 MB limit')
  const ext = extensionOf(file.name)
  const imageType = String(file.type || '').toLowerCase().startsWith('image/')
  if (!imageType && !ALLOWED_EXTENSIONS.has(ext)) throw new Error('File type is not allowed')
}

function pathBelongsToPhone(path: string, phoneDigits: string): boolean {
  const normalized = String(path || '').replace(/^\/+/, '')
  return normalized.startsWith(`citizen/${phoneDigits}/`) && !normalized.includes('..')
}

async function authenticate(req: Request) {
  const token = req.headers.get('x-firebase-id-token') || ''
  const claims = await verifyFirebaseIdToken(token)
  const phoneDigits = normalizePhone(claims.phone_number || '')
  if (phoneDigits.length < 10 || phoneDigits.length > 15) throw new Error('Verified phone number is invalid')
  return { claims, phoneDigits }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req) })
  if (req.method !== 'POST') return json(req, 405, { ok: false, error: 'Method not allowed' })

  const origin = req.headers.get('origin') || ''
  if (origin && !ALLOWED_ORIGINS.has(origin)) return json(req, 403, { ok: false, error: 'Origin not allowed' })

  try {
    const { phoneDigits } = await authenticate(req)
    const admin = getAdminClient()
    const contentType = req.headers.get('content-type') || ''

    if (contentType.includes('multipart/form-data')) {
      const form = await req.formData()
      const action = String(form.get('action') || 'upload')
      if (action !== 'upload') return json(req, 400, { ok: false, error: 'Invalid multipart action' })
      const file = form.get('file')
      if (!(file instanceof File)) return json(req, 400, { ok: false, error: 'Missing file' })
      assertAllowedFile(file)

      const safe = safeFileName(file.name)
      const random = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
      const path = `citizen/${phoneDigits}/${Date.now()}_${random}_${safe}`
      const bytes = new Uint8Array(await file.arrayBuffer())
      const { error } = await admin.storage.from(BUCKET).upload(path, bytes, {
        upsert: false,
        cacheControl: '3600',
        contentType: file.type || 'application/octet-stream',
      })
      if (error) throw new Error(`Storage upload failed: ${error.message}`)

      return json(req, 200, {
        ok: true,
        attachment: { name: file.name, type: file.type || '', size: file.size, path },
      })
    }

    if (!contentType.includes('application/json')) return json(req, 415, { ok: false, error: 'Unsupported content type' })
    const body = await req.json()
    const action = String(body?.action || '')

    if (action === 'sign') {
      const rawPaths = Array.isArray(body?.paths) ? body.paths : []
      const paths = [...new Set(rawPaths.map((x: unknown) => String(x || '')).filter(Boolean))].slice(0, 50)
      if (!paths.length) return json(req, 200, { ok: true, urls: {} })
      for (const path of paths) {
        if (!pathBelongsToPhone(path, phoneDigits)) return json(req, 403, { ok: false, error: 'Attachment path not authorized' })
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
      if (!pathBelongsToPhone(path, phoneDigits)) return json(req, 403, { ok: false, error: 'Attachment path not authorized' })
      const { error } = await admin.storage.from(BUCKET).remove([path])
      if (error) throw new Error(`Storage delete failed: ${error.message}`)
      return json(req, 200, { ok: true })
    }

    return json(req, 400, { ok: false, error: 'Unknown action' })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Request failed'
    const authFailure = /Firebase|phone|token|subject|issued-at|authentication time/i.test(message)
    console.warn('[citizen-attachments]', message)
    return json(req, authFailure ? 401 : 400, { ok: false, error: message })
  }
})
