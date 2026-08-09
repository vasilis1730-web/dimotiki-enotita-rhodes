# RODIOS — Production Hardening Staging Workflow

Status: STAGING ONLY — do not merge to `main` until all gates pass.

Integration trigger: 2026-08-10 00:10 EEST — GitHub ↔ Supabase connection confirmed by user; this staging-only commit is intended to trigger/retrigger the Supabase preview-branch integration for Draft PR #2.

## Isolation model

- Git branch: `staging-production-hardening`
- Production Git branch: `main` (must remain untouched during validation)
- Supabase: use an isolated persistent/preview branch, not the production database.
- Production citizen data must not be copied into the staging branch. Use `supabase/seeds/staging_seed.sql`.

## Supabase staging creation

1. In the production Supabase project, enable Dashboard Branching if required.
2. Create a persistent/preview branch named `staging-production-hardening` (or `staging`).
3. Switch the Dashboard branch selector to the new branch and verify that it has a different Project URL/API key from production.
4. Do not paste production service-role keys into GitHub or the browser application.

Supabase branches are isolated environments and, by default, do not copy production data.

## Database setup order

1. On the STAGING Supabase branch run:
   `supabase/migrations/20260809232000_authz_sequences_integrity.sql`
2. In STAGING Authentication > Users create and auto-confirm three temporary accounts:
   - `rodios-admin-staging@rhodes.gr`
   - `rodios-manager-staging@rhodes.gr`
   - `rodios-user-staging@rhodes.gr`
3. Give each a temporary staging-only password.
4. Run:
   `supabase/seeds/staging_seed.sql`
5. Verify the seed output shows three application profiles with non-null `auth_user_id` values.

## Gate A — authorization tests

Expected results:

| Test | Admin | Manager | User | Auth-only orphan |
|---|---:|---:|---:|---:|
| Read operational data | PASS | PASS | PASS | DENY |
| Insert/update issue | PASS | PASS | PASS | DENY |
| Delete issue | PASS | DENY | DENY | DENY |
| Read settings | PASS | PASS | PASS | DENY |
| Change settings | PASS | DENY | DENY | DENY |
| Manage app users | PASS | DENY | DENY | DENY |
| Call `rodios_next_sequence` | PASS | PASS | PASS | DENY |
| Call sequence as anon | DENY | — | — | — |

Do not proceed to Storage hardening until Gate A passes completely.

## Gate B — atomic numbering / relational integrity

1. Create two issues nearly simultaneously from two authenticated sessions.
2. Numbers must be unique and consecutive.
3. Try a direct duplicate canonical `issueNum`; database must reject it.
4. Try invalid `rodios_next_sequence('other', 2026)`; RPC must reject it.
5. Try the sequence RPC without an active application profile; it must reject it.
6. FK tests must reject a work order referencing a nonexistent issue and a payment referencing a nonexistent work order.

## Storage hardening prerequisite

Current citizen UI uploads directly to `storage.attachments` with the anon client. Therefore the existing `Anon upload attachments` policy cannot simply be removed before the citizen upload path is moved behind the authenticated `citizen-bridge` Edge Function (Firebase ID token verification + service-side Storage upload).

The Storage migration will only be added after that bridge path is audited/implemented. Target state:

- `attachments` bucket PRIVATE.
- no anonymous direct Storage read.
- no anonymous direct Storage upload after bridge migration.
- staff access restricted to active application users.
- stored DB values use bucket/path; UI obtains short-lived signed URLs.
- legacy 565 production objects remain resolvable after migration.

## Remaining gates

- Gate C: citizen attachment upload through secure bridge + private bucket.
- Gate D: staff attachment retry/durable upload state; no silent Base64 loss.
- Gate E: digital signatures fail closed unless server cryptographic verification explicitly succeeds.
- Gate F: Settings admin-only, production Supabase config hard-locked, logout cache purge.
- Gate G: Edge Function source/version-control/security review, including ACK.
- Gate H: end-to-end regression, concurrency, offline/network-failure, and rollback tests.

## Production merge rule

No migration or frontend change reaches `main` / production Supabase until every mandatory Gate passes on staging and a final read-only production preflight reports no P0 blocker.
