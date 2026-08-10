import { ContentInfo, SignedData, type Certificate } from "npm:pkijs@3.4.0";
import {
  assertAllowedOrigin,
  consumeHourlyQuota,
  corsHeaders,
  handleError,
  HttpError,
  json,
  requireActiveStaff,
} from "../_shared/rodios-staff-auth.ts";

const MAX_PDF_BYTES = 25 * 1024 * 1024;
const MAX_BASE64_CHARS = Math.ceil(MAX_PDF_BYTES / 3) * 4 + 4096;
const MAX_SIGNATURES = 20;
const MAX_ORDER_IDS = 100;
const PROOF_TTL_MS = 15 * 60 * 1000;

type ByteRange = { a: number; b: number; c: number; d: number; end1: number; end2: number };
type SignatureDetail = {
  index: number;
  cryptographicValid: boolean;
  coversFinalRevision: boolean;
  signer: string;
  certificatePresent: boolean;
  reason?: string;
};

function decodePdfBase64(input: string): Uint8Array {
  const raw = String(input || "").trim();
  if (!raw) throw new HttpError(400, "Λείπει το PDF.");
  if (raw.length > MAX_BASE64_CHARS) throw new HttpError(413, "Το PDF ξεπερνά το επιτρεπτό μέγεθος.");
  const b64 = (raw.includes(",") ? raw.slice(raw.indexOf(",") + 1) : raw).replace(/\s+/g, "");
  if (!b64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new HttpError(400, "Μη έγκυρη κωδικοποίηση PDF.");
  const estimated = Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
  if (estimated <= 0 || estimated > MAX_PDF_BYTES) throw new HttpError(413, "Το PDF ξεπερνά το επιτρεπτό μέγεθος.");
  let bin: string;
  try { bin = atob(b64); } catch { throw new HttpError(400, "Μη έγκυρη κωδικοποίηση PDF."); }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  if (out.length < 5 || String.fromCharCode(...out.slice(0, 5)) !== "%PDF-") throw new HttpError(400, "Το αρχείο δεν είναι έγκυρο PDF.");
  return out;
}

function latin1(bytes: Uint8Array) { return new TextDecoder("windows-1252").decode(bytes); }

function findByteRanges(bytes: Uint8Array): ByteRange[] {
  const text = latin1(bytes);
  const re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  const out: ByteRange[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && out.length < MAX_SIGNATURES) {
    const [a, b, c, d] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    if (![a, b, c, d].every(Number.isSafeInteger) || a < 0 || b < 0 || c < 0 || d < 0) continue;
    const end1 = a + b, end2 = c + d;
    if (end1 < a || end2 < c || end1 > c || end2 > bytes.length) continue;
    const key = `${a}:${b}:${c}:${d}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ a, b, c, d, end1, end2 });
  }
  return out.sort((x, y) => x.end2 - y.end2);
}

function concatRanges(bytes: Uint8Array, r: ByteRange): ArrayBuffer {
  const first = bytes.subarray(r.a, r.end1), second = bytes.subarray(r.c, r.end2);
  const out = new Uint8Array(first.length + second.length);
  out.set(first, 0); out.set(second, first.length);
  return out.buffer;
}

function hexToBytes(hex: string): Uint8Array {
  if (!hex || hex.length % 2) throw new Error("CMS hex is malformed");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const v = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (!Number.isFinite(v)) throw new Error("CMS hex is malformed");
    out[i] = v;
  }
  return out;
}

function derObjectLength(bytes: Uint8Array): number {
  if (bytes.length < 2 || bytes[0] !== 0x30) throw new Error("CMS is not a DER SEQUENCE");
  const first = bytes[1];
  if ((first & 0x80) === 0) {
    const total = 2 + first;
    if (total > bytes.length) throw new Error("CMS DER length exceeds Contents");
    return total;
  }
  const n = first & 0x7f;
  if (n < 1 || n > 4 || bytes.length < 2 + n) throw new Error("CMS DER length is invalid");
  let len = 0;
  for (let i = 0; i < n; i++) len = len * 256 + bytes[2 + i];
  const total = 2 + n + len;
  if (total > bytes.length) throw new Error("CMS DER length exceeds Contents");
  return total;
}

function extractCms(bytes: Uint8Array, r: ByteRange): Uint8Array {
  const gap = bytes.subarray(r.end1, r.c), text = latin1(gap);
  const lt = text.indexOf("<"), gt = lt >= 0 ? text.indexOf(">", lt + 1) : -1;
  if (lt < 0 || gt < 0) throw new Error("PDF signature Contents not found");
  const hex = text.slice(lt + 1, gt).replace(/\s+/g, "");
  if (!/^[0-9A-Fa-f]+$/.test(hex)) throw new Error("PDF signature Contents is not hexadecimal CMS");
  const padded = hexToBytes(hex), len = derObjectLength(padded);
  return padded.slice(0, len);
}

function certCommonName(cert: any): string {
  try {
    const vals = cert?.subject?.typesAndValues || [];
    const cn = vals.find((x: any) => x?.type === "2.5.4.3");
    const v = cn?.value?.valueBlock?.value;
    if (typeof v === "string") return v.trim().slice(0, 160);
  } catch (_) {}
  return "";
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function verifyOne(bytes: Uint8Array, r: ByteRange, index: number): Promise<SignatureDetail> {
  const coversFinalRevision = r.end2 === bytes.length;
  try {
    const cmsBytes = extractCms(bytes, r);
    const contentInfo = ContentInfo.fromBER(ownedArrayBuffer(cmsBytes));
    if (contentInfo.contentType !== ContentInfo.SIGNED_DATA) throw new Error("Contents is not CMS SignedData");
    const signedData = new SignedData({ schema: contentInfo.content });
    if (!signedData.signerInfos?.length) throw new Error("CMS has no signer");
    if (signedData.signerInfos.length > 4) throw new Error("Unexpected signer count in one PDF signature container");
    const detached = concatRanges(bytes, r);
    let allValid = true, signer = "", certificatePresent = false;
    for (let signerIndex = 0; signerIndex < signedData.signerInfos.length; signerIndex++) {
      const result: any = await signedData.verify({ signer: signerIndex, data: detached, checkChain: false, extendedMode: true });
      const ok = result === true || result?.signatureVerified === true;
      if (!ok) allValid = false;
      const cert = result?.signerCertificate as Certificate | null | undefined;
      if (cert) { certificatePresent = true; if (!signer) signer = certCommonName(cert); }
    }
    return { index, cryptographicValid: allValid, coversFinalRevision, signer, certificatePresent, ...(!allValid ? { reason: "CMS signature verification failed" } : {}) };
  } catch (e) {
    return { index, cryptographicValid: false, coversFinalRevision, signer: "", certificatePresent: false, reason: e instanceof Error ? e.message.slice(0, 240) : "Signature verification failed" };
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", ownedArrayBuffer(bytes)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function normalizeOrderIds(body: any): string[] {
  const raw: unknown[] = Array.isArray(body?.workOrderIds) ? body.workOrderIds : body?.workOrderId ? [body.workOrderId] : [];
  const normalized: string[] = raw.map((x: unknown) => String(x || "").trim()).filter((x: string) => x.length > 0);
  const ids: string[] = [...new Set<string>(normalized)].sort();
  if (!ids.length || ids.length > MAX_ORDER_IDS || ids.some((x: string) => x.length > 180 || /[\u0000-\u001f]/.test(x))) {
    throw new HttpError(400, "Μη έγκυρο σύνολο εντολών.");
  }
  if (ids.length !== raw.length) throw new HttpError(400, "Οι εντολές πρέπει να είναι μοναδικές.");
  return ids;
}

function safePdfName(input: unknown): string {
  const s = String(input || "verified-protocol.pdf").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 180);
  return s || "verified-protocol.pdf";
}

function acceptanceSnapshot(row: any): Record<string, unknown> {
  const d = row?.data && typeof row.data === "object" ? row.data : {};
  return {
    id: String(row.id),
    issueId: row.issue_id ?? null,
    items: Array.isArray(d.items) ? d.items : [],
    discountPct: d.discountPct ?? null,
    penaltyAmount: d.penaltyAmount ?? 0,
    orderNum: d.orderNum ?? "",
    orderType: d.orderType ?? "",
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    try { assertAllowedOrigin(req); return new Response(null, { status: 204, headers: corsHeaders(req) }); }
    catch (e) { return handleError(req, "verify-pdf-signatures", e); }
  }
  if (req.method !== "POST") return json(req, { valid: false, verified: false, error: "Method not allowed" }, 405);

  try {
    const ctx = await requireActiveStaff(req, { requireOrders: true });
    await consumeHourlyQuota(ctx.admin, "verify-pdf-signatures", ctx.user.id, 60);
    let body: any;
    try { body = await req.json(); } catch { throw new HttpError(400, "Invalid JSON"); }

    const orderIds = normalizeOrderIds(body);
    const { data: orderRows, error: orderError } = await ctx.admin
      .from("rodios_work_orders")
      .select("id, issue_id, data, deleted_at")
      .in("id", orderIds)
      .is("deleted_at", null);
    if (orderError) throw new Error(`Work-order lookup failed: ${orderError.message}`);
    if (!orderRows || orderRows.length !== orderIds.length) throw new HttpError(404, "Μία ή περισσότερες εντολές δεν βρέθηκαν.");

    const byId = new Map(orderRows.map((r: any) => [String(r.id), r]));
    const orderSnapshot: Record<string, unknown> = {};
    for (const id of orderIds) orderSnapshot[id] = acceptanceSnapshot(byId.get(id));

    const bytes = decodePdfBase64(body?.pdfBase64 || "");
    const ranges = findByteRanges(bytes);
    if (!ranges.length) {
      return json(req, { valid: false, verified: false, source: "edge-cms-crypto", count: 0, detectedCount: 0, signers: [], integrityOk: false, certificatesOk: false, trustedChainConfigured: false, trustMode: "cryptographic-integrity-only", message: "Δεν βρέθηκε επαληθεύσιμη ψηφιακή υπογραφή PDF.", details: [] });
    }

    const details: SignatureDetail[] = [];
    for (let i = 0; i < ranges.length; i++) details.push(await verifyOne(bytes, ranges[i], i + 1));
    const cryptoValidCount = details.filter((x) => x.cryptographicValid).length;
    const last = details[details.length - 1];
    const allCryptoValid = cryptoValidCount === details.length;
    const finalRevisionCovered = !!last?.coversFinalRevision;
    const verified = allCryptoValid && finalRevisionCovered;
    const signers = [...new Set(details.map((x) => x.signer).filter(Boolean))];
    const certificatesOk = details.every((x) => x.certificatePresent);

    const baseResult: any = {
      valid: verified,
      verified,
      source: "edge-cms-crypto",
      count: cryptoValidCount,
      detectedCount: details.length,
      signers,
      integrityOk: verified,
      certificatesOk,
      trustedChainConfigured: false,
      trustMode: "cryptographic-integrity-only",
      message: verified ? `Επαληθεύτηκαν κρυπτογραφικά ${cryptoValidCount} ψηφιακές υπογραφές.` : "Η κρυπτογραφική επαλήθευση του PDF απέτυχε ή το τελικό αρχείο περιέχει μη υπογεγραμμένες μεταγενέστερες αλλαγές.",
      details,
    };
    if (!verified) return json(req, baseResult);

    const pdfSha256 = await sha256Hex(bytes);
    const pdfName = safePdfName(body?.pdfName);
    let protocolPath = String(body?.signedPdfPath || "").trim();
    if (protocolPath) {
      if (orderIds.length !== 1 || protocolPath.length > 500 || protocolPath.startsWith("/") || protocolPath.includes("..") || /[\u0000-\u001f]/.test(protocolPath)) {
        throw new HttpError(400, "Μη έγκυρη διαδρομή πρωτοκόλλου.");
      }
      const { data: storedBlob, error: storedError } = await ctx.admin.storage.from("protocols").download(protocolPath);
      if (storedError || !storedBlob) throw new HttpError(409, "Το private πρωτόκολλο δεν βρέθηκε στο Storage. Ανεβάστε το ξανά.");
      const storedBytes = new Uint8Array(await storedBlob.arrayBuffer());
      if (await sha256Hex(storedBytes) !== pdfSha256) throw new HttpError(409, "Το αποθηκευμένο πρωτόκολλο δεν αντιστοιχεί στο επαληθευμένο PDF.");
    } else {
      protocolPath = `verified/${pdfSha256}.pdf`;
      const { error: uploadError } = await ctx.admin.storage.from("protocols").upload(
        protocolPath,
        new Blob([ownedArrayBuffer(bytes)], { type: "application/pdf" }),
        { contentType: "application/pdf", cacheControl: "3600", upsert: true },
      );
      if (uploadError) throw new Error(`Verified protocol upload failed: ${uploadError.message}`);
    }

    const proofId = crypto.randomUUID();
    const verifiedAt = new Date();
    const expiresAt = new Date(verifiedAt.getTime() + PROOF_TTL_MS);
    const verificationSummary = { ...baseResult, verificationProofId: proofId, pdfSha256, protocolPath };
    const { error: proofError } = await ctx.admin.from("rodios_pdf_verification_proofs").insert({
      id: proofId,
      order_ids: orderIds,
      pdf_sha256: pdfSha256,
      protocol_path: protocolPath,
      pdf_name: pdfName,
      signature_count: cryptoValidCount,
      verified_by: ctx.user.id,
      order_snapshot: orderSnapshot,
      verification_summary: verificationSummary,
      verified_at: verifiedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
    });
    if (proofError) throw new Error(`Verification proof insert failed: ${proofError.message}`);

    return json(req, { ...baseResult, verificationProofId: proofId, pdfSha256, protocolPath, proofExpiresAt: expiresAt.toISOString() });
  } catch (e) {
    return handleError(req, "verify-pdf-signatures", e);
  }
});
