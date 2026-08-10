# RODIOS — Production Hardening / Pre-production Record

**Status: STAGING ONLY — DO NOT MERGE TO `main`.**

Last updated: 2026-08-10.

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
- Browser test-only branch: `staging-browser-e2e` — **never merge to `main`**.
- Production branch: `main`.

The browser test-only branch may contain localhost-only manifests, test scripts and workflow files that are not release artifacts.

## 3. Current gate status

| Gate | Scope | Status |
|---|---|---|
| A | Backend RLS / active-user authorization | ✅ PASS — clean Supabase Preview |
| B | Atomic numbering / UNIQUE / FK integrity | ✅ PASS — clean Supabase Preview |
| C | Private attachments / Firebase Auth + App Check / quotas | ✅ Backend PASS; real authenticated upload E2E pending |
| D | Durable upload / Retry / no silent Base64 loss | ✅ Client fail-closed PASS; real interrupted-upload E2E pending |
| E | Digital signature authorization | ✅ Client positive/negative browser paths PASS; cryptographic backend deployed in Preview; real municipal signed/tampered PDF E2E pending |
| F | Settings admin-only / locked config / logout purge | ✅ PASS, including full Chromium `doLogout()` |
| G | Edge Functions + public ACK backend | ✅ PASS — clean Preview and ACK replay/expiry assertions |
| H.1 | Desktop shell / roles / cache / manifests | ✅ Chromium PASS |
| H.2 | Mobile + offline/reconnect | ✅ Chromium PASS |
| H.3 | Fail-closed functional paths | ✅ Chromium PASS |
| H.4 | Positive PDF client path + full logout | ✅ Chromium PASS |
| H.5 | Real authenticated integration / concurrency / rollback | ⏳ PENDING |

## 4. Clean Supabase Preview result

Latest complete isolated rebuild used Preview project `dtvmwhiujwmxszbhraup` and completed:

- Database ✅
- Services ✅
- APIs ✅
- Configurations ✅
- Migrations ✅
- Seeding ✅
- Edge Functions ✅
- Deno Edge Function CI ✅

The clean rebuild validated active-profile RLS, role assertions, sequences, canonical-number uniqueness, foreign keys, private Storage foundations, quotas, ACK expiry/replay behavior, server timestamps, audited admin-only soft deletion, precise upsert permissions and all seven version-controlled Edge Functions.

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
- baseline CSP on citizen/staff/ACK pages;
- explicit Firebase auth-helper CSP compatibility on citizen page;
- separate citizen/staff PWA manifests;
- service-worker API/third-party non-caching behavior;
- CSV spreadsheet-formula neutralization without changing stored values;
- external AI PDF parser server-side **OFF by default** unless `RODIOS_AI_PARSER_ENABLED=true`;
- permanent Edge Function `deno check` CI;
- permanent inline JavaScript syntax CI.

## 11. GitHub-only Chromium Gate H results

The test-only branch `staging-browser-e2e` runs Playwright/Chromium against an ephemeral `127.0.0.1` server. A network guard fails the test if any request targets production Supabase project `nzrdcgmrsfdmocyhfrod`.

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

1. Real citizen OTP + Firebase App Check against an isolated backend.
2. Real citizen submit/list/update authorization.
3. Exact legacy-phone ownership compatibility on representative migrated data.
4. Real private attachment upload/download and signed-URL reload.
5. Real interrupted upload / Retry / reload durability against Storage.
6. Real staff login sessions with Admin / Manager / User and backend writes.
7. Work-order creation + real email delivery + real ACK link lifecycle.
8. Known-good municipal signed PDF, tampered PDF, marker-only fake and verifier-unavailable tests.
9. Required certificate/eIDAS trust policy decision.
10. Two authenticated staff sessions for realtime/concurrency behavior.
11. Legacy production attachment compatibility review.
12. Production rollback rehearsal.
13. Final read-only production preflight immediately before release.

## 13. Production merge rule

**No merge to `main` and no production Supabase migration/function/Storage change until:**

- remaining real-integration Gate H checks pass;
- real PDF/trust-policy validation is completed;
- existing attachment compatibility is established;
- any external AI processing that remains enabled has municipal legal/privacy/data-processing approval;
- rollback is rehearsed;
- final production read-only preflight reports no P0 blocker.
