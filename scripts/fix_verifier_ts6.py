from pathlib import Path

p=Path('supabase/functions/verify-pdf-signatures/index.ts')
s=p.read_text(encoding='utf-8')
orig=s

marker='''async function verifyOne(bytes: Uint8Array, r: ByteRange, index: number): Promise<SignatureDetail> {'''
helper='''function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {\n  const copy = new Uint8Array(bytes.byteLength);\n  copy.set(bytes);\n  return copy.buffer;\n}\n\n'''
if s.count(marker)!=1: raise SystemExit('verifyOne marker missing/ambiguous')
if 'function ownedArrayBuffer(' in s: raise SystemExit('ownedArrayBuffer already exists')
s=s.replace(marker,helper+marker,1)

repls={
  'ContentInfo.fromBER(cmsBytes.buffer)':'ContentInfo.fromBER(ownedArrayBuffer(cmsBytes))',
  'crypto.subtle.digest("SHA-256", bytes)':'crypto.subtle.digest("SHA-256", ownedArrayBuffer(bytes))',
  'new Blob([bytes], { type: "application/pdf" })':'new Blob([ownedArrayBuffer(bytes)], { type: "application/pdf" })',
}
for old,new in repls.items():
    if s.count(old)!=1: raise SystemExit(f'expected once: {old!r}, found {s.count(old)}')
    s=s.replace(old,new,1)

old_norm='''function normalizeOrderIds(body: any): string[] {\n  const raw = Array.isArray(body?.workOrderIds) ? body.workOrderIds : body?.workOrderId ? [body.workOrderId] : [];\n  const ids = [...new Set(raw.map((x: unknown) => String(x || "").trim()).filter(Boolean))].sort();\n  if (!ids.length || ids.length > MAX_ORDER_IDS || ids.some((x) => x.length > 180 || /[\\u0000-\\u001f]/.test(x))) {\n    throw new HttpError(400, "Μη έγκυρο σύνολο εντολών.");\n  }\n  if (ids.length !== raw.length) throw new HttpError(400, "Οι εντολές πρέπει να είναι μοναδικές.");\n  return ids;\n}'''
new_norm='''function normalizeOrderIds(body: any): string[] {\n  const raw: unknown[] = Array.isArray(body?.workOrderIds) ? body.workOrderIds : body?.workOrderId ? [body.workOrderId] : [];\n  const normalized: string[] = raw.map((x: unknown) => String(x || "").trim()).filter((x: string) => x.length > 0);\n  const ids: string[] = [...new Set<string>(normalized)].sort();\n  if (!ids.length || ids.length > MAX_ORDER_IDS || ids.some((x: string) => x.length > 180 || /[\\u0000-\\u001f]/.test(x))) {\n    throw new HttpError(400, "Μη έγκυρο σύνολο εντολών.");\n  }\n  if (ids.length !== raw.length) throw new HttpError(400, "Οι εντολές πρέπει να είναι μοναδικές.");\n  return ids;\n}'''
if s.count(old_norm)!=1: raise SystemExit('normalizeOrderIds block missing/ambiguous')
s=s.replace(old_norm,new_norm,1)

for bad in ['cmsBytes.buffer);','digest("SHA-256", bytes)','new Blob([bytes]']:
    if bad in s: raise SystemExit('old typed-array pattern remains: '+bad)
if s==orig: raise SystemExit('no TS6 changes produced')
p.write_text(s,encoding='utf-8')
print('verifier TS6 compatibility patch applied')
