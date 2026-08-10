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
4. `supabase/seed.sql`

The canonical seed creates synthetic Auth identities without passwords and executes authorization/integrity assertions automatically. Production citizen data is not copied into Preview.

## Gate status

| Gate | Scope | Status |
|---|---|---|
| A | Backend RLS / active-user authorization | ✅ PASS in Supabase Preview |
| B | Atomic numbering / UNIQUE / FK integrity | ✅ PASS in Supabase Preview |
| C | Citizen attachments through authenticated Edge Function + private bucket | ✅ DEPLOYABLE / Preview PASS; browser E2E still required |
| D | Durable upload state / retry / no silent Base64 loss | ✅ Static hardening complete; browser network-failure E2E pending |
| E | Digital signatures fail closed | ✅ Static hardening complete; real verifier E2E pending |
| F | Settings admin-only / locked Supabase config / logout cache purge | ✅ Static hardening complete |
| G | Edge Function + public ACK security review | 🟡 IN PROGRESS — client hardened; deployed legacy function source still missing from Git |
| H | Full regression / concurrency / offline / rollback | ⏳ NOT STARTED |

Latest verified Supabase Preview run after Gates A–F reported:

- Database ✅
- Services ✅
- APIs ✅
- Configurations ✅
- Migrations ✅
- Seeding ✅
- Edge Functions ✅

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
- citizen uploads go through `citizen-attachments` using a cryptographically verified Firebase ID token;
- citizen object paths are restricted to the verified phone identity;
- staff uses private Storage paths and short-lived signed URLs;
- direct `getPublicUrl()` attachment flow removed from staging clients.

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

Version-controlled today:

- `supabase/functions/citizen-attachments/index.ts`

Referenced by the application but **not yet version-controlled in this repository**:

- `citizen-bridge`
- `manage-app-user`
- `send-order-email`
- `verify-pdf-signatures`
- `parse-municipal-pdf`
- `resolve-maps-link`

These deployed sources must be exported/reviewed before production release. They must be checked for authentication, authorization, CORS, input/file-size validation, rate limiting/abuse controls, SSRF where outbound URLs are fetched, service-role scope, secret/error leakage and fail-closed behavior.

Public ACK flow:

- `ack.html` intentionally calls `complete_work_order_ack(p_token)` anonymously;
- anonymous EXECUTE must **not** be revoked blindly;
- public page now uses `no-referrer`, scrubs the token from the visible URL/history and does not expose raw RPC errors;
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
