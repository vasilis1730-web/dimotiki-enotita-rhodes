# RODIOS — Production Hardening Staging Workflow

**Status: STAGING ONLY — DO NOT MERGE TO `main`.**

Last updated: 2026-08-10.

## Isolation model

- Working branch: `staging-production-hardening` — Draft PR #2.
- Supabase Preview trigger branch: `staging-supabase-gates-ab` — PR #5.
- Production Git branch: `main` — must remain untouched during validation.
- Production Supabase project must remain untouched until final production preflight and explicit release approval.
- Supabase Preview project is isolated and uses synthetic seed data only.

The Preview branch is fast-forwarded from the working branch after guarded changes are verified. Never force-update either staging branch.

## Current database bootstrap

Preview initialization is version-controlled under:

1. `supabase/migrations/20260809230000_core_schema_bootstrap.sql`
2. `supabase/migrations/20260809232000_authz_sequences_integrity.sql`
3. `supabase/migrations/20260810003000_private_attachments_storage.sql`
4. `supabase/migrations/20260810050000_citizen_upload_quota.sql`
5. `supabase/seed.sql`

The canonical seed creates synthetic Auth identities without passwords and executes authorization/integrity assertions automatically. Production citizen data is not copied into Preview.

## Gate status

| Gate | Scope | Status |
|---|---|---|
| A | Backend RLS / active-user authorization | ✅ PASS in Supabase Preview |
| B | Atomic numbering / UNIQUE / FK integrity | ✅ PASS in Supabase Preview |
| C | Private citizen/staff attachments | ✅ DEPLOYABLE / Preview PASS; browser E2E still required |
| D | Durable upload state / retry / no silent Base64 loss | ✅ Static hardening complete; browser network-failure E2E pending |
| E | Digital signatures fail closed | ✅ Static hardening complete; real verifier E2E pending |
| F | Settings admin-only / locked Supabase config / logout cache purge | ✅ Static hardening complete |
| G | Edge Functions + public ACK security review | 🟡 PARTIAL PASS — `citizen-attachments` hardened + Preview PASS; legacy function source and ACK server audit still blockers |
| H | Full regression / concurrency / offline / rollback | ⏳ NOT STARTED |

Latest verified Supabase Preview run after the Gate G `citizen-attachments` hardening reported:

- Database ✅
- Services ✅
- APIs ✅
- Configurations ✅
- Migrations ✅
- Seeding ✅
- Edge Functions ✅

A permanent GitHub Action, `.github/workflows/edge-function-check.yml`, also runs `deno check` and dependency analysis for version-controlled Edge Functions before deployment.

## Gate A — authorization contract

Target backend authorization is based on the authenticated Supabase user UUID and an active `rodios_app_users` profile. Frontend role labels are not a security boundary.

| Test | Admin | Manager | User | Auth-only orphan |
|---|---:|---:|---:|---:|
| Read permitted operational data | PASS | PASS | PASS | DENY |
| Insert/update permitted operational data | PASS | PASS | PASS | DENY |
| Delete operational data | PASS | DENY | DENY | DENY |
| Read/change Settings | PASS | DENY | DENY | DENY |
| Manage app users | PASS | DENY | DENY | DENY |
| Call `rodios_next_sequence` | PASS | PASS | PASS | DENY |
| Call sequence as anon | DENY | — | — | — |

## Gate B — numbering / relational integrity

Required invariants:

- canonical issue/order numbers are database-unique;
- the next 2026 issue number is seeded ahead of existing canonical production numbers before release;
- invalid sequence kinds/years are rejected;
- inactive/orphan Auth accounts cannot call the sequence RPC;
- work-order/payment FK foundations reject nonexistent parents.

## Gate C — private attachments

Target state implemented on staging:

- `attachments` bucket private;
- no anonymous direct Storage upload/read;
- citizen uploads go through `citizen-attachments`;
- citizen backend requires both a cryptographically verified Firebase phone-auth ID token and Firebase App Check token;
- App Check validation checks Firebase JWKS, issuer, audience and the authorized Web App ID;
- citizen object paths are restricted to the verified phone identity;
- server-side extension/MIME and file-signature checks reject mismatched or unsupported uploads;
- an atomic database quota limits a verified citizen identity to 20 uploads / 200 MiB per clock-hour bucket;
- internal Storage/server errors are logged server-side but not exposed to citizens;
- staff uses private Storage paths and short-lived signed URLs;
- direct `getPublicUrl()` attachment flow is removed from staging clients.

Production migration must include compatibility validation for the existing legacy attachment objects before bucket visibility is changed.

## Gate D — upload failure contract

- unresolved `uploading` / `upload_failed` media blocks final save/send;
- failed issue attachments expose Retry;
- email sending is cancelled if required media upload did not complete;
- the old silent "keep Base64 locally" path must never be treated as durable persistence.

## Gate E — digital signature contract

- acceptance requires explicit server-side cryptographic `verified === true`;
- local `/ByteRange` / signature-count detection is informational only;
- `valid`, `certificatesOk`, missing verifier response and admin override cannot authorize acceptance;
- verifier endpoint is build-locked to `/functions/v1/verify-pdf-signatures` on the same Supabase project;
- staff verifier requests use the authenticated employee access token, not the anon token as bearer identity.

## Gate F — browser/session contract

- Settings UI is Administrator-only;
- Supabase project URL/key are readonly build configuration;
- legacy `sb_url` / `sb_key` browser overrides are removed and ignored;
- logout signs out from Supabase and purges operational localStorage/IndexedDB/in-memory state.

## Gate G — Edge Functions / ACK

### Version-controlled and reviewed

- `supabase/functions/citizen-attachments/index.ts`
  - Firebase Auth ID token verification;
  - Firebase App Check verification;
  - private path ownership;
  - strict upload type/signature validation;
  - atomic server-side upload quota;
  - generic public errors / detailed server logs;
  - Supabase Preview deploy PASS;
  - Deno CI type/dependency check PASS.

`supabase/config.toml` intentionally declares **only functions whose source exists in this repository**. The earlier attempt to declare missing legacy functions caused the Preview deployer to fail during the Edge Function bundle phase. Keeping orphan function declarations out of the deployment config restored a fully green Preview run.

### Referenced by the application but not yet version-controlled

- `citizen-bridge`
- `manage-app-user`
- `send-order-email`
- `verify-pdf-signatures`
- `parse-municipal-pdf`
- `resolve-maps-link`

These deployed sources must be downloaded from the current Supabase project, committed to the staging branch and reviewed before production release. Required review areas: authentication, authorization, CORS, input/file-size validation, rate limiting/abuse controls, SSRF where outbound URLs are fetched, service-role scope, secret/error leakage and fail-closed behavior.

Current client hardening while those server sources remain unavailable:

- staff-only calls use the real Supabase Auth access token;
- signature verifier URL is fixed to the same Supabase project;
- `manageAppUser()` now has an additional Administrator-only client guard;
- this client guard is defense-in-depth only and **does not replace** mandatory server-side Administrator authorization.

### Public ACK flow

- `ack.html` intentionally calls `complete_work_order_ack(p_token)` anonymously;
- anonymous EXECUTE must **not** be revoked blindly;
- public page uses `no-referrer`, scrubs the token from the visible URL/history and does not expose raw RPC errors;
- server function must enforce cryptographically strong token matching, one-time use/replay protection, expiry, exact row scope and safe return data;
- run `supabase/audits/20260810_gate_g_ack_server_read_only.sql` against production and review the exported result before any ACK migration.

## Gate H — mandatory final validation

Before release, run at minimum:

1. Admin / Manager / User / orphan authorization matrix.
2. Concurrent issue numbering and duplicate rejection.
3. Citizen OTP submit/list/update and attachment upload on the isolated backend.
4. Staff attachment upload, signed-URL reload, retry after forced network failure and logout purge.
5. Work-order creation, email delivery and acknowledgment lifecycle.
6. Signed protocol with valid signatures, invalid signatures and verifier unavailable.
7. Realtime refresh / conflict behavior from two staff sessions.
8. Offline/reconnect, slow network and interrupted request tests.
9. Mobile + desktop browser smoke tests.
10. Rollback rehearsal from the exact release commit/migrations.

## Production merge rule

No frontend, migration, Storage or Edge Function change reaches `main` / production until:

- all mandatory Gates A–H pass on isolated staging;
- all deployed legacy Edge Function source is version-controlled and reviewed;
- ACK server audit has no unresolved P0 blocker;
- a final read-only production preflight reports no P0 blocker;
- production rollback steps are documented and tested.
