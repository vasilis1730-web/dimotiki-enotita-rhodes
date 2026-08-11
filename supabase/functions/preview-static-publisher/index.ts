import { createClient } from "npm:@supabase/supabase-js@2.110.9";

const EXPECTED_PROJECT_REF = "opfazboecycanfxiiaqh";
const EXPECTED_PROJECT_URL = `https://${EXPECTED_PROJECT_REF}.supabase.co`;
const PRODUCTION_PROJECT_URL = "https://nzrdcgmrsfdmocyhfrod.supabase.co";
const PRODUCTION_PAGES_BASE = "https://vasilis1730-web.github.io/dimotiki-enotita-rhodes";
const SOURCE_COMMIT = "daa6b876c84d7e31ae0f8db3951e67fe5a6833c6";
const SOURCE_BASE = `https://raw.githubusercontent.com/vasilis1730-web/dimotiki-enotita-rhodes/${SOURCE_COMMIT}`;
const BUCKET = "rodios-v920-preview";
const PUBLIC_BASE = `${EXPECTED_PROJECT_URL}/storage/v1/object/public/${BUCKET}`;

type Asset = {
  path: string;
  sha256: string;
  contentType: string;
  patchHtml?: boolean;
  patchSupabase?: boolean;
};

const ASSETS: Asset[] = [
  { path: "index.html", sha256: "699b4e0725e29fe62e819dee72a9ef388e36784962c8799b08f38b74538d125f", contentType: "text/html; charset=utf-8", patchHtml: true, patchSupabase: true },
  { path: "aftepistasia.html", sha256: "464b2df0e4452c1a9893fe0714222dc96b482191a35ca240509d59ce5841568e", contentType: "text/html; charset=utf-8", patchHtml: true, patchSupabase: true },
  { path: "ack.html", sha256: "43b95570d039c7f63042e9cc15ecac2dbc072571f5d5253ef2e4d501e78ebdca", contentType: "text/html; charset=utf-8", patchHtml: true, patchSupabase: true },
  { path: "privacy.html", sha256: "497af65d83387c254ca8515a3b58a41ef409bf01136e2918e073496f432311d4", contentType: "text/html; charset=utf-8", patchHtml: true },
  { path: "manifest.json", sha256: "435631e57ddaf8e8f697439801e1aa428e2d59cb3d39d173721f529052c2c578", contentType: "application/manifest+json" },
  { path: "manifest-staff.json", sha256: "72ab104de974411087b88af3aa0f00517faff962ccb84a343cddd18fcaf2f1db", contentType: "application/manifest+json" },
  { path: "sw.js", sha256: "dea4960d39da9fcf19c8f88dec61c903d55c052698a7a5d9af4690edd4547934", contentType: "application/javascript; charset=utf-8" },
  { path: "icon-192.png", sha256: "c51ceb4617698cea1903d0c6d84a3dd262dc3dfb8cd4f2f66e2a9995d3c1bae4", contentType: "image/png" },
  { path: "icon-512.png", sha256: "62dd48999c0e4225afb9a83179b1594eb28c12b9e677cf5864dcf29ba3183a3b", contentType: "image/png" },
];

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function secretKey(): string {
  const direct = String(
    Deno.env.get("SUPABASE_SECRET_KEY") ||
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
    "",
  ).trim();
  if (direct) return direct;
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
    return String(keys.default || Object.values(keys)[0] || "").trim();
  } catch (_) {
    return "";
  }
}

function browserKey(): string {
  const legacy = String(Deno.env.get("SUPABASE_ANON_KEY") || "").trim();
  if (legacy.startsWith("eyJ")) return legacy;
  throw new Error("Preview legacy anon key is unavailable");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function patchHtml(path: string, source: string, anonKey: string, patchSupabase: boolean): string {
  let html = source;
  if (patchSupabase) {
    const urlMatch = html.match(/const\s+SUPABASE_URL\s*=\s*['"]([^'"]+)['"]\s*;/);
    const keyMatch = html.match(/const\s+SUPABASE_KEY\s*=\s*['"]([^'"]+)['"]\s*;/);
    if (!urlMatch || urlMatch[1] !== PRODUCTION_PROJECT_URL || !keyMatch || !keyMatch[1].startsWith("eyJ")) {
      throw new Error(`Unexpected Supabase constants in ${path}`);
    }
    html = html.split(PRODUCTION_PROJECT_URL).join(EXPECTED_PROJECT_URL);
    html = html.split(keyMatch[1]).join(anonKey);
  }
  html = html.split(PRODUCTION_PAGES_BASE).join(PUBLIC_BASE);
  html = html.replace(/<head([^>]*)>/i, '<head$1>\n<meta name="robots" content="noindex,nofollow">\n<meta name="rodios-environment" content="preview-v9.20">');
  html = html.replace(/<title>([\s\S]*?)<\/title>/i, "<title>[PREVIEW v9.20] $1</title>");
  if (html.includes(PRODUCTION_PROJECT_URL) || html.includes(PRODUCTION_PAGES_BASE)) {
    throw new Error(`Production endpoint remains in ${path}`);
  }
  return html;
}

async function fetchVerified(asset: Asset): Promise<Uint8Array> {
  const response = await fetch(`${SOURCE_BASE}/${asset.path}`, {
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Source fetch failed for ${asset.path}: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (await sha256Hex(bytes) !== asset.sha256) throw new Error(`Source hash mismatch for ${asset.path}`);
  return bytes;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const projectUrl = String(Deno.env.get("SUPABASE_URL") || "").replace(/\/+$/, "");
    if (projectUrl !== EXPECTED_PROJECT_URL) return json({ error: "Preview-only function" }, 404);
    const adminKey = secretKey();
    const anonKey = browserKey();
    if (!adminKey) throw new Error("Preview secret key is unavailable");

    const admin = createClient(projectUrl, adminKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: buckets, error: listError } = await admin.storage.listBuckets();
    if (listError) throw listError;
    if (!buckets?.some((bucket) => bucket.id === BUCKET)) {
      const { error } = await admin.storage.createBucket(BUCKET, {
        public: true,
        fileSizeLimit: 2 * 1024 * 1024,
        allowedMimeTypes: ["text/html", "application/manifest+json", "application/javascript", "image/png"],
      });
      if (error) throw error;
    } else {
      const { error } = await admin.storage.updateBucket(BUCKET, {
        public: true,
        fileSizeLimit: 2 * 1024 * 1024,
        allowedMimeTypes: ["text/html", "application/manifest+json", "application/javascript", "image/png"],
      });
      if (error) throw error;
    }

    const uploaded: string[] = [];
    for (const asset of ASSETS) {
      let bytes = await fetchVerified(asset);
      if (asset.patchHtml) {
        const source = new TextDecoder().decode(bytes);
        bytes = new TextEncoder().encode(patchHtml(asset.path, source, anonKey, !!asset.patchSupabase));
      }
      const { error } = await admin.storage.from(BUCKET).upload(
        asset.path,
        new Blob([ownedArrayBuffer(bytes)], { type: asset.contentType }),
        { upsert: true, contentType: asset.contentType, cacheControl: "60" },
      );
      if (error) throw new Error(`Upload failed for ${asset.path}: ${error.message}`);
      uploaded.push(asset.path);
    }

    return json({
      ok: true,
      environment: "preview-v9.20",
      sourceCommit: SOURCE_COMMIT,
      uploaded,
      citizenUrl: `${PUBLIC_BASE}/index.html`,
      staffUrl: `${PUBLIC_BASE}/aftepistasia.html`,
    });
  } catch (error) {
    console.error("[preview-static-publisher]", error);
    const detail = (error instanceof Error ? error.message : String(error || "Unknown error"))
      .replace(/[\r\n\t]+/g, " ")
      .slice(0, 240);
    return json({ error: "Preview publishing failed", detail }, 500);
  }
});
