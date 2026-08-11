#!/usr/bin/env python3
"""Fast source-level regression checks for release security boundaries."""

from pathlib import Path
import json
import sys

ROOT = Path(__file__).resolve().parents[1]
staff = (ROOT / "aftepistasia.html").read_text(encoding="utf-8")
ack = (ROOT / "ack.html").read_text(encoding="utf-8")
manage = (ROOT / "supabase/functions/manage-app-user/index.ts").read_text(encoding="utf-8")
migration = (ROOT / "supabase/migrations/20260810150000_remove_legacy_profile_credentials.sql").read_text(encoding="utf-8")
atomic_sync = (ROOT / "supabase/migrations/20260810170000_atomic_optimistic_sync.sql").read_text(encoding="utf-8")
acceptance_sync = (ROOT / "supabase/migrations/20260810114000_verified_pdf_acceptance_transaction.sql").read_text(encoding="utf-8")
conflict_correction = (ROOT / "supabase/migrations/20260811050000_nonretryable_conflict_codes.sql").read_text(encoding="utf-8")
citizen = (ROOT / "index.html").read_text(encoding="utf-8")
bridge = (ROOT / "supabase/functions/citizen-bridge/index.ts").read_text(encoding="utf-8")
citizen_attachments = (ROOT / "supabase/functions/citizen-attachments/index.ts").read_text(encoding="utf-8")
send_email = (ROOT / "supabase/functions/send-order-email/index.ts").read_text(encoding="utf-8")
verify_pdf = (ROOT / "supabase/functions/verify-pdf-signatures/index.ts").read_text(encoding="utf-8")
audit_dependencies = json.loads((ROOT / "audit/dependencies/package.json").read_text(encoding="utf-8"))["dependencies"]

required = {
    "profile credential stripping": "delete out.password;" in staff and "delete out.pin;" in staff,
    "user lifecycle Edge-only": "App-user lifecycle is intentionally excluded from the generic browser sync" in staff,
    "masked 12-character user password": 'type="password" id="u_pin" minlength="12"' in staff,
    "12-character Edge validation": "Password must be at least 12 characters" in manage,
    "credential-key database constraint": "rodios_app_users_no_credentials_in_profile" in migration,
    "safe attachment URL gate": "function _safeAttachmentUrl(value, allowInline)" in staff,
    "geocoder text-only rendering": "mainEl.textContent=main" in staff and "subEl.textContent=city" in staff,
    "attachment preview opener isolation": "window.open(src,'_blank','noopener,noreferrer')" in staff,
    "single-quote HTML escaping": ".replace(/'/g,'&#39;')" in staff,
    "record IDs handled as data": "onclick=\"editOrder(this.dataset.wid)\"" in staff and "onclick=\"startEdit(this.dataset.iid)\"" in citizen,
    "masked administrator password modal": 'id="adminPassNew" minlength="12"' in staff and "submitAdminPassChange" in staff,
    "server-only attachment URL allowlist": "function _safeServerAttachmentUrl(value)" in staff and "sameProjectStorageUrl" in send_email,
    "patched Nodemailer release": 'npm:nodemailer@9.0.5' in send_email,
    "email header and external-content hardening": "cleanHeader(body?.subject" in send_email and "disableFileAccess:true,disableUrlAccess:true" in send_email,
    "email settings use canonical key/value schema": (
        '.from("rodios_settings").select("value").eq("key","main")' in send_email
        and "settingsRow?.value?.contractorEmail" in send_email
    ),
    "dependency audit pins match runtime": (
        audit_dependencies.get("nodemailer") == "9.0.5"
        and audit_dependencies.get("firebase") == "12.17.1"
        and audit_dependencies.get("@supabase/supabase-js") == "2.110.9"
        and audit_dependencies.get("chart.js") == "4.4.0"
        and audit_dependencies.get("leaflet") == "1.9.4"
        and audit_dependencies.get("jose") == "6.2.3"
        and audit_dependencies.get("pkijs") == "3.4.0"
        and "@supabase/supabase-js@2.110.9" in citizen_attachments
        and "jose@6.2.3" in citizen_attachments
        and "pkijs@3.4.0" in verify_pdf
        and "chart.js@4.4.0" in staff
        and "leaflet@1.9.4" in staff
    ),
    "safe e-signature destination": "function _safeESignUrl(value)" in staff and "openESignPortal()" in staff,
    "ACK frame and third-party script CSP denied": "frame-src 'none'" in ack and "https://www.gstatic.com" not in ack,
    "citizen production auth fails closed": "function isLocalCitizenTestMode()" in citizen and "Η ασφαλής υπηρεσία ταυτοποίησης δεν είναι διαθέσιμη" in citizen,
    "patched Firebase browser SDK": "firebasejs/12.17.1/firebase-auth.js" in citizen and "firebasejs/12.17.1/firebase-app-check.js" in citizen,
    "citizen attachment URL allowlist": "function safeCitizenAttachmentUrl(value)" in citizen,
    "citizen response allowlist": "function publicIssue(issue:any)" in bridge and ").map(publicIssue)" in bridge,
    "server-generated citizen reference": "citizenRef:newCitizenRef()" in bridge,
    "Firebase token accepted via header only": 'req.headers.get("x-firebase-id-token")||""' in bridge,
    "Greek mobile enforced end-to-end": "/^3069\\d{8}$/" in bridge and "/^3069\\d{8}$/" in citizen_attachments,
    "unsaved citizen upload cleanup": "async function cancelIssueModal()" in citizen and "callCitizenAttachmentsJson('remove'" in citizen,
    "cancelled in-flight upload cleanup": "Could not clean cancelled upload" in citizen,
    "citizen signed-URL hydration is chunked": "for(let i=0;i<paths.length;i+=50)" in citizen,
    "citizen attachment actions are rate limited": "consumeActionQuota(admin, identityHash, action)" in citizen_attachments,
    "citizen list pagination is bounded and explicit": "MAX_LIST_SCAN_ROWS=10000" in bridge and ".range(from,from+requested-1)" in bridge,
    "citizen classification server allowlist": "assertCitizenClassification(municipality,category,title)" in bridge,
    "citizen update required fields": "if(!citizenName||!municipality||!category||!title||!location||!description)throw new HttpError(400" in bridge,
    "legacy pathless attachments preserved safely": "mergeUpdatedAttachments(orig.attachments" in bridge and "cleanLegacyAttachmentUrl" in bridge,
    "referenced citizen attachments cannot be deleted": "assertAttachmentIsUnreferenced(admin, path)" in citizen_attachments,
    "existing attachment cleanup follows accepted update": "const cleanup=[...new Set(removedExistingPaths)]" in citizen,
    "fail-closed user deactivation": "deactivateError" in manage and "authDeleteError" in manage,
    "atomic optimistic browser sync": "sb.rpc('rodios_save_bundle'" in staff and "expectedUpdatedAt" in staff,
    "non-retryable HTTP 409 conflict code": (
        "errcode = 'PT409'" in atomic_sync
        and "errcode='PT409'" in acceptance_sync
        and "pg_get_functiondef" in conflict_correction
        and "'PT409'" in conflict_correction
        and "RODIOS_SYNC_CONFLICT" in staff
    ),
    "related deletes use one atomic bundle": "async function _v9DeleteBundle(tableIds)" in staff and "rodios_payments:payIds" in staff,
    "exact server versions retained after save": "_v9RememberBaselineFromCurrent(committed.versions||{})" in staff,
    "direct operational writes revoked": "revoke insert, update on table" in atomic_sync and "has_any_column_privilege" in atomic_sync,
    "legacy non-versioned delete revoked": "revoke execute on function public.rodios_soft_delete(text,text[]) from authenticated" in atomic_sync,
    "Realtime publication is migration-controlled": "alter publication supabase_realtime add table" in atomic_sync,
}

forbidden = {
    "direct browser app-user upsert": "_v9UpsertChunks('rodios_app_users'" in staff,
    "legacy password merge": "password: base.password" in staff,
    "unmasked profile password field": 'type="text" id="u_pin"' in staff,
    "unsafe geocoder innerHTML": "row.innerHTML='<span class=\"gm\">'" in staff,
    "attachment document.write preview": "win.document.write('<html><body style=\"margin:0;background:#000" in staff,
    "built-in profile PIN": "pin:''" in staff,
    "plaintext administrator password prompt": "prompt('Νέος κωδικός Administrator" in staff,
    "citizen public Firebase bypass": "if(!window._fbReady){ loginWithPhone(phone); return; }" in citizen,
    "pre-v12 Firebase pin": "firebasejs/10." in citizen or "firebasejs/11." in citizen,
    "raw citizen update response": "return json(req,{ok:true,issue:updated})" in bridge,
    "Firebase token duplicated in JSON body": "Object.assign({ action, idToken }" in citizen,
    "citizen ID interpolated into handler": "onclick=\"startEdit(\\'" in citizen,
    "silent 500-row citizen list truncation": '.limit(500)' in bridge,
    "silent 1000-row legacy list truncation": '.limit(1000)' in bridge,
    "vulnerable Nodemailer 6.x pin": 'npm:nodemailer@6.' in send_email,
    "legacy email settings id/data lookup": '.from("rodios_settings").select("data").eq("id","main")' in send_email,
    "legacy direct operational upsert helper": "async function _v9UpsertChunks" in staff,
    "non-atomic preflight conflict window": "function _v9AssertNoConflicts" in staff or "+ 1000" in staff,
    "legacy browser soft-delete RPC": "sb.rpc('rodios_soft_delete'" in staff,
    "retryable SQLSTATE used for application conflict": (
        "errcode = '40001'" in atomic_sync or "errcode='40001'" in acceptance_sync
    ),
}

failures = [name for name, ok in required.items() if not ok]
failures += [name for name, present in forbidden.items() if present]

for name, ok in required.items():
    print(("PASS" if ok else "FAIL"), name)
for name, present in forbidden.items():
    print(("FAIL" if present else "PASS"), f"forbidden: {name}")

if failures:
    print("SECURITY_INVARIANTS_FAIL: " + ", ".join(failures), file=sys.stderr)
    raise SystemExit(1)

print("SECURITY_INVARIANTS_PASS")
