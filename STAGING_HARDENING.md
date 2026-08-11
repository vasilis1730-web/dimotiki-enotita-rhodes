# RODIOS — Production Hardening / Pre-production Record

**Status: STAGING ONLY — DO NOT MERGE TO `main`.**

Last updated: 2026-08-11.

## 1. Final architecture

The release architecture is intentionally simple:

- **GitHub Pages is the only public/frontend hosting target.**
- Supabase provides database, Storage and Edge Functions.
- Firebase provides citizen Phone Auth / OTP and App Check.
- Cloudflare is **not** part of the release or staging architecture.
- Browser validation that does not require a live backend runs in GitHub Actions against an ephemeral `127.0.0.1` server.

Production `main`, official GitHub Pages and production Supabase remain unchanged until final approval.

## 2. Branches

- Working hardening branch: `staging-production-hardening` — Draft PR #2.
- Supabase Preview trigger branch: `staging-supabase-gates-ab` — PR #5.
- Completed disposable real-integration branch: `staging-real-integration` — closed Draft PR #6; branch and evidence retained.
- Completed disposable rollback branch: `staging-rollback-rehearsal` — closed Draft PR #7; branch and evidence retained.
- Historical browser test-only branch: `staging-browser-e2e` — **never merge to `main`**; its four production-network-guarded suites are now included in the local hardening batch.
- Production branch: `main`.

The browser test-only branch may contain localhost-only manifests, test scripts and workflow files that are not release artifacts.
The additional hardening batch described below is restricted to the `staging-production-hardening` branch and Draft PR #2. It has not been applied to production Supabase or `main`.

## 3. Current gate status

| Gate | Scope | Status |
|---|---|---|
| A | Backend RLS / active-user authorization | ✅ PASS — clean Supabase Preview |
| B | Atomic numbering / UNIQUE / FK integrity | ✅ PASS — clean Supabase Preview |
| C | Private attachments / Firebase Auth + App Check / quotas | ✅ Staff/private Storage PASS; positive citizen E2E blocked by missing Firebase CI secrets |
| D | Durable upload / Retry / no silent Base64 loss | ✅ PASS — client fail-closed plus real interrupted-upload / Retry / fresh-session reload |
| E | Digital signature authorization | ✅ Client positive/negative browser paths PASS; cryptographic backend deployed in Preview; real municipal signed/tampered PDF E2E pending |
| F | Settings admin-only / locked config / logout purge | ✅ PASS, including full Chromium `doLogout()` |
| G | Edge Functions + public ACK backend | ✅ PASS — clean Preview and ACK replay/expiry assertions |
| H.1 | Desktop shell / roles / cache / manifests | ✅ Chromium PASS |
| H.2 | Mobile + offline/reconnect | ✅ Chromium PASS |
| H.3 | Fail-closed functional paths | ✅ Chromium PASS |
| H.4 | Positive PDF client path + full logout | ✅ Chromium PASS |
| H.5 | Real-network authenticated backend security matrix | ✅ PASS — run `31462153851`, attempt 2, job `93688379070`, 23/23 |
| H.6 | Real citizen OTP/upload, email and signed-PDF artifact E2E | ⏳ PARTIAL/BLOCKED — Firebase secrets, authorized email side effect and municipal PDFs required |
| H.7 | Two-session concurrency and rollback rehearsal | ✅ PASS — atomic conflict/Realtime/rollback matrix plus disposable rollback Preview |

## 4. Clean Supabase Preview result

Latest complete isolated rebuild used Preview project `enymhfhequixpquhiecg` and completed:

- Database ✅
- Services ✅
- APIs ✅
- Configurations ✅
- Migrations ✅
- Seeding ✅
- Edge Functions ✅
- Deno Edge Function CI ✅

The clean rebuild validated active-profile RLS, role assertions, sequences, canonical-number uniqueness, foreign keys, private Storage foundations, quotas, ACK expiry/replay behavior, server timestamps, audited admin-only soft deletion, precise upsert permissions and all seven version-controlled Edge Functions.

The expanded real-network Gate H matrix passed **23/23** assertions: 13 real Auth/RLS/Storage/Edge/ACK/concurrency/rollback/interrupted-upload checks and 10 citizen negative-security HTTP checks. The latest complete result is run `31462153851`, attempt 2, job `93688379070`.

The real interrupted-upload test aborted an 8,388,608-byte streaming upload after 6,488,064 bytes had been produced, verified that no readable partial object remained, retried 1,048,576 bytes at the same path, signed in through a fresh authenticated session and downloaded byte-identical content with SHA-256 `4331f6fd59299bea143d32f6cd62fad04cda8571f354179a88e380835fcf94e2`.

Attempt 1 of the same run passed the interrupted-upload test but one Realtime subscriber did not receive the concurrency event inside the 10-second observation window. The unchanged attempt-2 rerun received one event in each session and completed the concurrency check in 1,118 ms. This is retained as a transient Realtime monitoring signal rather than concealed by the green rerun.

The concurrency test proved exactly one winner from two authenticated sessions, immediate stale-write rejection as `PT409`, one Realtime event in each session and preservation of the winner. The multi-row stale bundle proved full transaction rollback.

## 5. Backend authorization contract

Backend authorization is based on the authenticated Supabase UUID mapped to an active `rodios_app_users.auth_user_id`. Browser role labels are not a security boundary.

| Capability | Admin | Manager | User | Auth-only orphan |
|---|---:|---:|---:|---:|
| Read permitted operational data | PASS | PASS | PASS | DENY |
| Insert/update permitted operational data | PASS | PASS | PASS | DENY |
| Soft-delete operational data | PASS | DENY | DENY | DENY |
| Settings | PASS | DENY | DENY | DENY |
| Manage app users | PASS | DENY | DENY | DENY |
| `rodios_next_sequence` | PASS | PASS | PASS | DENY |
| Sequence RPC as anon | DENY | — | — | — |

## 6. Storage / attachment contract

Staging target state:

- `attachments` bucket private;
- citizen uploads through `citizen-attachments` only;
- Firebase Phone Auth ID token + Firebase App Check required;
- server-side namespace, MIME/extension/signature validation and upload quotas;
- staff stores paths and hydrates short-lived signed URLs;
- failed or unresolved upload state blocks final save/send;
- failed issue attachment exposes Retry;
- no direct `getPublicUrl()` attachment flow;
- no silent durable fallback to Base64.
- citizen attachment metadata returned to the browser is allowlisted and signed URLs are accepted only from the same Supabase project and `attachments` bucket;
- cancelled or abandoned in-flight uploads are cleaned when possible;
- deletion is rejected while an attachment path remains referenced by a non-deleted issue;
- legacy pathless URL attachments are preserved on citizen edits only when the stored URL is a same-project Storage attachment URL;
- citizen signed-URL and removal actions are rate-limited.

**Production compatibility blocker:** the existing 565 production attachment objects must be checked before changing production bucket visibility.

## 7. Digital signature contract

The production export revealed that the old `verify-pdf-signatures` implementation merely counted `/ByteRange` markers and could return `verified:true` without cryptographically verifying the PDF.

Staging replacement now:

- requires authenticated active staff;
- validates PDF/base64/size/byte ranges;
- parses CMS `SignedData` from `/Contents`;
- cryptographically verifies detached signed bytes;
- requires every detected signature to verify;
- requires final signed revision coverage through the final file byte;
- treats local marker/signature-count checks as informational only;
- accepts client completion only when server result is explicitly `verified === true`;
- rejects missing verifier response, `verified:false`, local markers and previous admin override paths.

Chromium tests now prove both client directions:

- missing/false server verification → acceptance blocked;
- explicit `verified:true` + required signature count → status `Παραλήφθηκε`, `completionDate`, `_protocolReady` and exactly one auto-created payment.

**Trust-policy limitation:** current verifier proves cryptographic integrity and signed-byte coverage but does not yet claim qualified/eIDAS trust-chain validation. A real known-good municipal PDF and tampered variants remain mandatory before production release.

## 8. Edge Functions / ACK hardening

All six production exports plus `citizen-attachments` are version-controlled and hardened:

- `citizen-bridge`
- `citizen-attachments`
- `manage-app-user`
- `send-order-email`
- `resolve-maps-link`
- `parse-municipal-pdf`
- `verify-pdf-signatures`

Shared staff functions validate the bearer token via Supabase Auth and require an active app profile. Admin-only operations are enforced server-side.

ACK backend now includes:

- expiry;
- atomic one-time consumption;
- replay rejection;
- expired-token rejection;
- restricted direct table access;
- fixed/qualified `SECURITY DEFINER` behavior;
- generic public errors.

Behavioral SQL assertions executed real ACK RPC calls in Preview and passed first-use / replay / expiry cases.

### Important Gate H defect found and fixed

Browser testing found that `prepareContractorEmailPayload()` previously generated the contractor ACK token/row **before** media durability validation. Therefore an email that was later cancelled because media upload failed could still create an ACK side effect.

The real hardening branch now executes:

1. refresh/prepare media;
2. `ensureOrderMediaUploaded()`;
3. reject any unresolved media;
4. **only then** create the ACK link/token;
5. continue email payload generation.

The rerun passed with zero production-directed requests.

## 9. Browser/session contract

- Settings UI is Administrator-only.
- Managers/users cannot open Settings even through direct client function invocation.
- runtime Supabase URL/key browser overrides are removed and ignored.
- `doLogout()` calls Supabase `auth.signOut()`, purges operational localStorage/IndexedDB/in-memory state, clears legacy overrides and returns the UI to login.

Chromium full-logout test passed.

## 10. Release hardening controls

Implemented on staging:

- audited admin-only soft delete instead of physical client DELETE;
- server-controlled timestamps;
- immutable row IDs with precise upsert column permissions;
- privacy notice aligned to Municipality of Rhodes as controller and municipal DPO contact;
- Supabase browser SDK pinned to `2.110.9`;
- Nodemailer upgraded from vulnerable `6.9.16` to patched `9.0.5` after a production-dependency audit;
- Firebase browser SDK upgraded from affected `10.8.0` to current stable `12.17.1`; the used modular Auth/App Check APIs are unchanged, but the v12 ES2020 baseline requires a staging browser-runtime rerun;
- baseline CSP on citizen/staff/ACK pages;
- reduced ACK CSP and explicit geocoder CSP origins for the citizen/staff pages;
- stored-content DOM/XSS hardening, including single-quote escaping, data-attribute record IDs, validated map coordinates, safe external-link handling and allowlisted attachment/e-signature destinations;
- citizen responses reduced to an explicit public field allowlist rather than returning internal issue JSON;
- citizen Firebase ID tokens accepted only by header, with production fail-closed behavior if Firebase/App Check is unavailable;
- exact verified Greek-mobile enforcement and server-side allowlists for municipality/category/title;
- server-generated high-entropy citizen references and ownership validation for modification references;
- identical server-side required-field validation for both new citizen submissions and in-place citizen updates;
- bounded, explicit pagination for current and legacy citizen issue retrieval instead of silent 500/1000-row truncation;
- removal of legacy `password`/`pin`/`pwd`/`passwordHash` profile keys, plus a database constraint preventing their return;
- Administrator-managed user passwords masked in the UI and enforced at 12–128 characters;
- browser app-user writes removed; lifecycle changes go through the authorized Edge Function;
- fail-closed app-user deactivation and cleanup of recreated orphan Auth accounts on database failure;
- explicit Firebase auth-helper CSP compatibility on citizen page;
- separate citizen/staff PWA manifests;
- relative manifest identity/start/scope URLs that resolve identically on production GitHub Pages while remaining isolated in localhost and Preview builds;
- service-worker API/third-party non-caching behavior;
- CSV spreadsheet-formula neutralization without changing stored values;
- external AI PDF parser server-side **OFF by default** unless `RODIOS_AI_PARSER_ENABLED=true`;
- permanent Edge Function `deno check` CI;
- permanent inline JavaScript syntax CI;
- permanent source-level security-invariant CI for the release boundaries above;
- permanent browser/Edge parity check for citizen municipalities, categories and titles;
- permanent moderate-or-higher dependency-audit CI covering browser CDN and Deno npm release packages;
- non-retryable application conflict responses: optimistic synchronization and stale verified-PDF conflicts use PostgREST `PT409` instead of retryable PostgreSQL serialization code `40001`.

## 11. Chromium Gate H results

The test-only branch `staging-browser-e2e` and the ported hardening workflow run Playwright/Chromium against an ephemeral `127.0.0.1` server. A network guard fails the test if any request targets production Supabase project `nzrdcgmrsfdmocyhfrod`.

The complete ported suite was rerun locally and in GitHub Actions after the Firebase 12 upgrade. It passed Firebase Auth, Phone Auth and App Check browser initialization, desktop/staff/ACK shells, both relative PWA manifests, mobile/offline paths, fail-closed attachment/email/PDF paths, the authoritative PDF transaction success path and full logout purge. No production Supabase request was made.

Latest complete Chromium suite reported:

```text
PASS /index.html
PASS staff role/UI/cache invariants
PASS /aftepistasia.html
PASS /ack.html
PASS manifest.json
PASS manifest-staff.json
BROWSER_SMOKE_PASS

PASS mobile /index.html
PASS mobile /aftepistasia.html
PASS offline/reconnect /index.html
PASS offline/reconnect /aftepistasia.html
MOBILE_OFFLINE_SMOKE_PASS

PASS issue attachment fail-closed + Retry contract
PASS order media save/email fail-closed contract
PASS non-admin manage-user client guard
PASS PDF client fail-closed contract
PASS CSV formula neutralization
FAILURE_PATH_SMOKE_PASS

PASS PDF verified:true positive client acceptance path
PASS full doLogout signOut + purge + login return
POSITIVE_LOGOUT_SMOKE_PASS
```

No production Supabase request was made in the successful suite.

### Browser defect found and fixed

The first Chromium run exposed a real JavaScript syntax regression in Gate E: a literal newline had been inserted inside a quoted `alert()` string. The bug was repaired in the real hardening branch. A permanent inline-JavaScript syntax workflow now checks every inline script in the three public HTML entry points with `node --check`.

## 12. Remaining mandatory Gate H work

The following must **not** be represented as validated by mocks or localhost shell tests:

1. Real citizen OTP + Firebase App Check against an isolated backend. The guarded workflow is ready but `RODIOS_FIREBASE_TEST_PHONE`, `RODIOS_FIREBASE_TEST_CODE` and `RODIOS_FIREBASE_APPCHECK_DEBUG_TOKEN` are not configured.
2. Real citizen submit/list/update authorization, legacy-phone claim/isolation and citizen attachment upload/sign/download/remove. These run in the same positive Firebase workflow after the three secrets are configured.
3. Work-order creation + real email delivery + real ACK link lifecycle; no external email is sent without explicit authorization.
4. Known-good municipal signed PDF, tampered PDF, marker-only fake and verifier-unavailable tests.
5. Required certificate/eIDAS trust policy decision.
6. Legacy production attachment metadata compatibility review, including the existing 565 objects and any pathless records.
7. Final read-only production preflight immediately before release, including counts and credential-key presence checks without exposing values or PII. This requires separate explicit approval before any production read.
8. Restrict the public Geoapify browser key by allowed origin and quota in the provider dashboard.

Completed since the previous record: two-session concurrency/Realtime, atomic multi-row rollback, full rollback rehearsal, real interrupted-upload / Retry / fresh-session reload durability, PR #5 Draft protection and the published GitHub Actions Chromium/Firebase 12 runtime rerun.

Residual technical risk: the legacy single-file frontend still requires CSP `'unsafe-inline'`. Removing it safely requires a separate HTML/JavaScript extraction and event-handler refactor, not a last-minute release patch.

## 13. Production merge rule

**No merge to `main` and no production Supabase migration/function/Storage change until:**

- remaining real-integration Gate H checks pass;
- real PDF/trust-policy validation is completed;
- existing attachment compatibility is established;
- any external AI processing that remains enabled has municipal legal/privacy/data-processing approval;
- final production read-only preflight reports no P0 blocker.
