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
5. `supabase/migrations/20260810094500_edge_ack_hardening.sql`
6. `supabase/seed.sql`

The canonical seed creates synthetic Auth identities without passwords and executes authorization/integrity assertions automatically. Production citizen data is not copied into Preview.

## Gate status

| Gate | Scope | Status |
|---|---|---|
| A | Backend RLS / active-user authorization | ✅ PASS in Supabase Preview |
| B | Atomic numbering / UNIQUE / FK integrity | ✅ PASS in Supabase Preview |
| C | Private citizen/staff attachments | ✅ DEPLOYABLE / Preview PASS; browser E2E still required |
| D | Durable upload state / retry / no silent Base64 loss | ✅ Static hardening complete; browser network-failure E2E pending |
| E | Digital signatures fail closed | ✅ Client fail-closed complete; real CMS verifier now staged; known-good/tampered PDF E2E pending |
| F | Settings admin-only / locked Supabase config / logout cache purge | ✅ Static hardening complete |
| G | Edge Functions + public ACK security review | 🟡 REMEDIATION STAGED — all 6 production exports + ACK audit reviewed; final Supabase Preview deployment and E2E pending |
| H | Full regression / concurrency / offline / rollback | ⏳ NOT STARTED |

A permanent GitHub Action, `.github/workflows/edge-function-check.yml`, runs `deno check` and dependency analysis across all version-controlled Edge Functions. The full seven-function tree passed Deno CI before the final citizen-client-only App Check patch.

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

Production audit finding: the deployed `verify-pdf-signatures` function did **not** cryptographically verify the PDF. It counted `/ByteRange` markers and could return `verified: true` solely because at least one marker was present. This was a launch blocker.

Staging replacement:

- acceptance still requires explicit server-side `verified === true`;
- verifier authenticates an active staff profile and is rate-limited;
- PDF size/base64/header are validated;
- `/ByteRange` entries are parsed and validated against actual file bounds;
- CMS `SignedData` is extracted from `/Contents` and cryptographically verified against the detached bytes defined by the PDF byte ranges;
- every detected signature must verify cryptographically;
- the final signed revision must cover the final file byte, preventing acceptance of unsigned trailing modifications;
- local `/ByteRange` / signature-count detection remains informational only;
- `valid`, `certificatesOk`, missing verifier response and admin override cannot authorize acceptance;
- verifier endpoint remains build-locked to the same Supabase project.

**Trust limitation:** the staged verifier currently proves CMS signature integrity and signed-byte coverage, but does not yet assert a qualified/eIDAS trust chain (`trustedChainConfigured=false`). Known-good municipal signed PDFs, tampered PDFs and trust-policy requirements must be validated during Gate H before production approval.

## Gate F — browser/session contract

- Settings UI is Administrator-only;
- Supabase project URL/key are readonly build configuration;
- legacy `sb_url` / `sb_key` browser overrides are removed and ignored;
- logout signs out from Supabase and purges operational localStorage/IndexedDB/in-memory state.

## Gate G — production Edge Function + ACK audit

The six production Edge Function exports and the production ACK read-only CSV were reviewed on 2026-08-10. All six functions are now version-controlled in staging together with the already hardened `citizen-attachments`.

### Production findings and staged remediation

#### `citizen-bridge`

Production findings:
- service-role reads/writes with fuzzy phone ownership matching (`endsWith` style matching);
- client-supplied issue IDs combined with upsert semantics;
- no App Check requirement;
- no server quota and insufficient field/path allowlisting.

Staging remediation:
- Firebase phone-auth ID token + Firebase App Check cryptographic validation;
- citizen client sends both tokens to bridge and attachment endpoints;
- new issues receive server-generated UUID-based IDs;
- new records are bound to immutable Firebase UID (`citizenAuthUid`);
- legacy records use exact normalized phone compatibility only, never suffix matching;
- field lengths/system fields are server controlled;
- attachment paths must belong to the verified citizen phone namespace;
- per-action server quota.

#### `manage-app-user`

Production finding: Auth operations were not bound to the new top-level `auth_user_id`, so newly created profiles could become unusable under the hardened RLS model. Authorization also depended too heavily on gateway/client assumptions.

Staging remediation:
- real Supabase Auth token validation plus active-profile lookup;
- Administrator authorization enforced server-side;
- client-supplied Auth UUID ignored;
- top-level `auth_user_id` written consistently with the Auth user UUID;
- role/tier preserved;
- primary Administrator deletion blocked;
- rate limiting and generic public errors.

#### `send-order-email`

Production findings:
- optional authentication mode;
- JWT payload could be decoded without cryptographic validation in function code;
- arbitrary recipient and arbitrary HTTPS attachment fetching created mail-relay/SSRF risk;
- insufficient streamed size/timeout controls.

Staging remediation:
- gateway JWT required plus active staff/work-order authorization in handler;
- recipient must exactly match the configured contractor email from server-side settings;
- attachment URLs must be same-project Supabase Storage URLs for `attachments` or `protocols`;
- redirects rejected;
- streamed total attachment cap and timeouts;
- hourly quota and generic SMTP/server errors.

#### `resolve-maps-link`

Production finding: initial hostname validation was followed by automatic redirects, so a redirect could leave the trusted Google Maps host set.

Staging remediation:
- active staff authorization;
- explicit Google Maps host/path allowlist;
- manual redirect handling with validation at every hop;
- redirect limit, timeout and quota.

#### `parse-municipal-pdf`

Production finding: no active-application-profile authorization in the handler and weak request-size/media controls before external AI processing.

Staging remediation:
- active staff authorization;
- strict supported media list and decoded size cap;
- base64 validation, timeout, quota and output sanitization;
- generic provider errors.

**Governance blocker:** this workflow sends municipal document content that can contain citizen personal data to Anthropic. Production use requires explicit municipal privacy/data-processing/legal approval and an approved processor/data-transfer basis. Technical hardening alone does not authorize this processing.

#### `verify-pdf-signatures`

See Gate E. The marker-count implementation was replaced in staging by cryptographic CMS verification.

### Shared staff authorization

All staff functions use `supabase/functions/_shared/rodios-staff-auth.ts`:

- bearer token is validated through Supabase Auth;
- authenticated UUID must map to an active `rodios_app_users.auth_user_id`;
- optional Administrator/work-order permission checks are enforced server-side;
- CORS is restricted to the official application origin plus explicitly configured staging origins;
- generic client errors / detailed server logs;
- shared service-role-only hourly quota RPC.

### Production ACK audit findings

The production CSV confirmed:

- `work_order_acknowledgments` had RLS enabled but authenticated INSERT/SELECT/UPDATE policies were effectively unrestricted;
- `ack_token` was unique and generated from 24 cryptographically random bytes;
- public `complete_work_order_ack` was intentionally executable by `anon`;
- ACK tokens had no expiry;
- public completion did not provide an atomic one-time/replay-prevention condition;
- `SECURITY DEFINER` functions used a broad `public` search path.

Staging migration `20260810094500_edge_ack_hardening.sql`:

- adds `expires_at` and a 30-day default;
- backfills legacy rows conservatively;
- public completion is atomic and succeeds only for unacknowledged, unexpired tokens;
- invalid, expired or replayed tokens return failure without leaking row data;
- direct `anon` table access is revoked while anonymous RPC execute is intentionally retained;
- staff ACK table policies now require an active application user;
- `SECURITY DEFINER` functions use an empty fixed search path with qualified objects;
- service-role-only generic Edge rate-limit storage/RPC is introduced.

`ack.html` additionally uses `no-referrer`, removes the token from browser history after reading it and never displays raw database errors.

## Gate H — mandatory final validation

Before release, run at minimum:

1. Admin / Manager / User / orphan authorization matrix.
2. Concurrent issue numbering and duplicate rejection.
3. Citizen OTP + App Check list/submit/update and attachment upload on the isolated backend.
4. Legacy citizen issue ownership compatibility using exact phone matching.
5. Staff attachment upload, signed-URL reload, retry after forced network failure and logout purge.
6. Work-order creation, safe email delivery and acknowledgment lifecycle including replay/expiry tests.
7. Signed protocol with known-good real municipal signatures, tampered bytes, marker-only fake PDFs and verifier unavailable.
8. Realtime refresh / conflict behavior from two staff sessions.
9. Offline/reconnect, slow network and interrupted request tests.
10. Mobile + desktop browser smoke tests.
11. Rollback rehearsal from the exact release commit/migrations.

## Production merge rule

No frontend, migration, Storage or Edge Function change reaches `main` / production until:

- all mandatory Gates A–H pass on isolated staging;
- the full Gate G package deploys successfully in Supabase Preview;
- known-good/tampered PDF cryptographic tests pass and the required certificate trust policy is decided;
- privacy/data-processing approval exists for any external AI parsing feature that remains enabled;
- compatibility of existing production attachments is validated;
- a final read-only production preflight reports no P0 blocker;
- production rollback steps are documented and tested.
