# Release package: PROD migrations for `claim_my_event_registrations()` (PR #604)

Status: **DOCS ONLY. Nothing here was applied, rehearsed or written on any hosted database.** 2026-11-17.
Scope: the two migrations merged by PR #604 (main `4a6a24914f2e915545b90e1a05831acfd05a6796`), their rollbacks, and the order
SQL -> app -> backport. Read-only checks were run on PROD (`hvsujyfbftfffxpfmlpb`) and DEV (`epdrtzcydvnoidwrepqz`) through
`danceflow-ops/sb.sh prod-read` / `dev-read` (read-only transaction, no writes).

Legend: **[V]** verified (command or code read this session), **[A]** assumed / not provable without a write.

Two separate owner gates are required (section 11): **product approval** of the behaviour, and **PROD SQL authorization** of the exact files.

---------------------------------------------------------------------------------------------------------------------

## 1. Artifacts (sha256 computed from git objects at `4a6a24914`, not the working tree) [V]

| File (under `src/lib/supabase/migrations/`) | sha256 |
|---|---|
| `20270221090000_event_registration_claim_function.sql` | `3c873d6f3840ca5da2cecaab524f33af3537f42643e1fc0cc5f937c55e4d08ec` |
| `rollback/20270221090000_event_registration_claim_function_rollback.sql` | `1bbe5338b32f22e0ea15202e7d629057747b92be4688ffaa313b90fcd4e032c3` |
| `20270221091000_event_registrations_unclaimed_email_index_concurrent.sql` | `20896098d897fd55fb60a3236bad817bb582cfb2809a44f5c4a32be415d03089` |
| `rollback/20270221091000_event_registrations_unclaimed_email_index_concurrent_rollback.sql` | `9ec58f3c4b838ef3adfbd863d257d805a77b2888ca7b46036327fc482f9650e3` |
| `sql-tests/test_T_claim_my_event_registrations.sql` (not applied to PROD) | `6c54cc6ea958953416e559e9033fdad35da7905bfac02990de53ba6ea8d64404` |

The two apply files contain no CR characters (checked; `sb.sh` refuses CR). Re-compute before any apply:
`git show <main-sha>:src/lib/supabase/migrations/<file> | sha256sum`.

What they do: (1) `public.claim_my_event_registrations()` -- SECURITY DEFINER, no parameters, `search_path=''`, owner postgres, returns integer;
email only from `my_verified_email()`; updates only `event_registrations.user_id` where it is null and the normalised `attendee_email`
equals the verified email; execute granted to `authenticated` only. (2) Partial index
`event_registrations_unclaimed_email_idx on (lower(btrim(attendee_email))) where user_id is null and attendee_email is not null`.
Verified on disposable stacks: SQL suite PASS 34/34 at head `374dc5fd` (apply, rollback, re-apply) -- see PR #604 comments.

## 2. Prerequisites and dependencies, checked read-only

Ran `preflight.sql` (this directory) on PROD and DEV.

| Dependency | PROD | DEV |
|---|---|---|
| `public.my_verified_email()` exists, SECURITY DEFINER, owner postgres, `search_path=""`, execute `authenticated` yes / `anon` no | **[V]** yes | **[V]** yes |
| `record_email_proof_web()`, `complete_email_binding(uuid,uuid)`, `email_binding_status()`, tables `verified_email_identities`, `auth_email_change_markers`, `auth.sessions` | **[V]** all present | **[V]** all present |
| `event_registrations.user_id uuid NULL`, `attendee_email text NOT NULL`, `updated_at`, `order_id`, `registration_source`, `notes`, `client_id` | **[V]** present | **[V]** present |
| RLS: `event_registrations_self_select` = `(user_id = auth.uid())`, role public; staff/organizer policies unchanged; **no owner UPDATE policy** | **[V]** | **[V]** |
| Claim function absent / index absent / invalid indexes on the table | **[V]** absent / absent / 0 | **[V]** absent / absent / 0 |
| Table owner / size | **[V]** postgres, about 37 rows, 312 kB | **[V]** postgres, 35 rows, 376 kB |
| 1C-B enforcement (20261009090000) | **[A]** not needed by the claim (only `my_verified_email()` from 1C-A is called); the local stack used for tests did not have it either | -- |

Triggers on `event_registrations` (same on PROD and DEV) **[V]**: `set_event_registrations_updated_at`, `trg_set_updated_at_event_registrations`,
`sync_competition_entries_from_registration`, `trg_enforce_event_ticket_capacity_holds`, `trg_event_registrations_stripe_identity_guard`,
`trg_paywh1_guard_order_registration_writes`. Effect of the claim UPDATE (`set user_id` only), read from the migration sources **[V]**:
- `sync_competition_entries_from_registration` is `AFTER UPDATE OF status, payment_status` -> **does not fire** (the claim does not name those columns).
- `trg_enforce_event_ticket_capacity_holds` is `BEFORE UPDATE OF ticket_type_id, quantity, status, payment_status, order_id, terminal_hold_until` -> **does not fire**.
- `trg_event_registrations_stripe_identity_guard` and `trg_paywh1_guard_order_registration_writes` fire, but both let `current_user` other than `anon`/`authenticated` through (the definer runs as postgres) -> **pass**; the stripe guard also only compares Stripe columns, which are unchanged.
- The two `updated_at` triggers **fire** -> a claimed row gets a new `updated_at`. **This differs from my earlier test note** ("updated_at not touched"): the local suite
  runs in one transaction where `now()` is constant, so a trigger would not show. On PROD expect `updated_at = now()` on each claimed row. No functional impact found
  (ordering by `updated_at` is the only visible effect); it is the only column besides `user_id` that changes.

Current data on PROD **[V]** (counts only): 37 registrations, **0 owned (`user_id` set)**, 37 unclaimed, all with an email (24 distinct), 26 order-backed, 11 admin/studio-sold.
Bound verified identities: **3**; registrations that match a bound identity today: **0**; registrations whose email equals some existing account email
(proof not implied): **10 rows / 5 accounts**. DEV: 35 registrations, 14 owned, 21 unclaimed, 0 bound identities, 11 rows match an account email (2 accounts).
So the first real claims on PROD will only happen when one of those accounts completes email binding, then signs in to the apps with the call shipped.

## 3. Is SQL-only inert on the live branch? [V]

Live = `release/website-embeds` `447d9b854`. `git grep claim_my_event_registrations origin/release/website-embeds` -> **no matches**; its `src/app/account/page.tsx`
has no call. Nothing calls the function until an app that contains the call is deployed, so applying the function and index to the shared PROD database is inert for
live users: no existing statement references them, the index only adds a small write cost on inserts (rows with `user_id` null) and is used by no current query. The function
is not exposed to anon. **[A]** PostgREST schema cache reload (Supabase does this on DDL) -- harmless; the function simply becomes callable by authenticated users.

## 4. Release order

1. Product approval gate (section 11a).
2. PROD SQL gate (section 11b) -> run preflight -> apply function (transaction) -> run postflight -> apply index (standalone) -> postflight again -> smoke.
3. Deploy an app that contains the call (web `/account` on main; Student wallet when #603 merges). The apps fail closed (0) if the function were missing, so order is
   safe both ways, but SQL first is the rule.
4. Backport to `release/website-embeds`: the web wrapper `src/lib/events/claimMyEventRegistrations.ts` + the `/account` call + its test (3 files). Live is
   not changed by the SQL alone.

## 5. Preflight (read-only) -- `preflight.sql`

`bash C:/Users/mcurt/danceflow-ops/sb.sh prod-read docs/events/event-registration-claim-release/preflight.sql` returns one JSON row. **Proceed only if**:
`prereq_objects` all true; `my_verified_email_definition` = security definer, owner postgres, authenticated true, anon false; `claim_objects.function_exists=false`,
`index_exists=false`, `invalid_indexes_on_table=0`; `event_registrations_columns` as in section 2; `self_select_qual = (user_id = auth.uid())`;
trigger set unchanged from section 2. Record `unclaimed_counts` for the postflight comparison.

## 6. Apply procedure (needs the PROD SQL authorization in 11b)

Run from a scratch working directory that holds the two files copied from git at `4a6a24914` (never from a working tree).

1. Function (own transaction, in the file): `bash C:/Users/mcurt/danceflow-ops/sb.sh prod-apply <file> 3c873d6f3840ca5da2cecaab524f33af3537f42643e1fc0cc5f937c55e4d08ec`.
   Lock: `CREATE OR REPLACE FUNCTION` / `ALTER FUNCTION ... OWNER` / `GRANT` touch catalog rows only; **no lock on `event_registrations`**. Expected < 1 s.
2. Postflight (`postflight.sql`): function row present, `security_definer=true`, `owner=postgres`, `config` contains `search_path=""`, `authenticated_exec=true`,
   `anon_exec=false`, `service_role_exec=false`, `public_grants=0`, `grantees=["authenticated","postgres"]`; `unclaimed_counts` identical to the preflight except `max_updated_at` (must not move).
3. Smoke (`smoke_after_apply.sql`, read-only): `returns_when_no_user = 0`, `auth_uid_is_null = true`.
4. Index (STANDALONE, never inside a transaction): `bash .../sb.sh prod-apply <file> 20896098d897fd55fb60a3236bad817bb582cfb2809a44f5c4a32be415d03089`.
   `CREATE INDEX CONCURRENTLY` takes SHARE UPDATE EXCLUSIVE: it **does not block reads or writes**; on about 37 rows it finishes in well under a second.
   **[A]** Whether `supabase db query -f` runs a multi-statement file inside an implicit transaction is not proven: no earlier CONCURRENTLY file was applied through `sb.sh`
   (checked `ops.log`). If the runner rejects the statement (SQLSTATE `25001`, "cannot run inside a transaction block"), **nothing is created** and the function keeps working
   (the index is performance-only). Do not improvise: ask the owner to authorize a plain `create index if not exists ...` with its own committed file and sha256
   (table is ~312 kB, so the brief write lock is negligible) -- this is a new artifact and needs a new PR.
5. Postflight again: `index.valid=true`, `index.ready=true`, definition contains `lower(btrim(attendee_email))` and `WHERE ((user_id IS NULL) AND (attendee_email IS NOT NULL))`, `invalid_indexes_on_table=0`.

Detecting and clearing an INVALID index (only if a CONCURRENTLY build is interrupted): postflight shows `index.valid=false` or `invalid_indexes_on_table>0`. Clear with the rollback file for the
index (`drop index concurrently if exists public.event_registrations_unclaimed_email_idx`), then re-apply the index file. Requires a fresh PROD authorization for that exact file+sha.

"No row changed": `unclaimed_counts.total_registrations`, `unclaimed`, `owned` equal the preflight; `max_updated_at` unchanged. The migrations contain no data statement.

## 7. Rollback (needs PROD SQL authorization too)

Order: **index first, then function** (the index serves only the function):
1. `rollback/20270221091000_..._rollback.sql` (`drop index concurrently if exists ...`, standalone) -- sha `9ec58f3c...50e3`.
2. `rollback/20270221090000_..._rollback.sql` (`drop function if exists public.claim_my_event_registrations()` in a transaction) -- sha `1bbe5338...32c3`.
Rolling back **does not clear `event_registrations.user_id` values already claimed**: those are the buyer's own tickets; clearing them would hide tickets from their owner again
and cannot be told apart later from the studio-set rows. If the owner ever wants claims reverted, that is a separate, row-selective data operation (identify by claim time using
`updated_at` after the release start, in a reviewed script), never part of the migration rollback. After the rollback the apps keep working (they treat a missing function as 0).
Verified locally: apply, rollback (index, function), re-apply, 34/34 again.

## 8. Smoke tests

Safe on PROD (read-only): preflight, postflight, `smoke_after_apply.sql`. A real claim needs a bound test user and a write on PROD, so it is **not possible without a write**; do not do it.
Post-app device/HTTP check (no PROD writes by us): on a build that contains the call, with a test account **already existing on DEV** whose email matches a registration
(DEV has 11 such rows / 2 accounts, but only after SQL is applied on DEV, which this package does not do): sign in, complete email binding, open Student wallet / web `/account` ->
the registration appears; second open -> unchanged. On PROD the first natural claim is visible in `postflight.sql` as `owned > 0` and the same user sees the ticket. HTTP check:
`POST /rest/v1/rpc/claim_my_event_registrations` with a user JWT returns an integer; with the anon key returns 401/permission denied; with no JWT returns an error (never data).
(Avoid calling it as anon against local stacks: the known supautils segfault on `permission denied for function`, see `docs/twilio/TW-4F_Isolated_QA.md`.)

## 9. Timing and locks (summary) [V from the objects / A for the runner]
Function migration: catalog-only, < 1 s, no table lock. Index: CONCURRENTLY, no write block, < 1 s at this size. Claim call at runtime: one indexed UPDATE per user per app open (index
makes the by-email predicate cheap), holding row locks only on that user's own rows.

## 10. Known behaviours to accept
- A claimed row gets a new `updated_at` (section 2).
- A shared or family mailbox claims every ticket sent to it (inherent to email identity).
- A claimed studio-sold row exposes all its columns to the owner on a direct query (row-level `self_select`), including studio-internal `notes` and `client_id`. The shipped apps select explicit
  non-sensitive columns. A column-restricted read is proposed in `docs/events/event-registration-dancer-column-restricted-read-proposal.md`. On PROD today 11 of 37 unclaimed rows are admin/studio-sold.
- Gift tickets: the registration holder email claims; the order purchaser does not.

## 11. Owner gate wording (two separate decisions)

**11a. Product approval (no SQL):** "I approve Option A as implemented in PR #604: a signed-in user with a verified, bound email gets the existing event registrations
that carry that same email linked to their account (all statuses, buyer email only; gift tickets are claimed by the holder email, not the purchaser). I understand claimed
studio-sold rows can expose studio notes on a direct query until a column-restricted read ships [or: I want the interim filter first]."

**11b. PROD SQL authorization (exact files):** "I authorize applying to PROD, in this order, exactly these files at main `4a6a24914`:
`20270221090000_event_registration_claim_function.sql` sha256 `3c873d6f...d08ec` (transaction) and then `20270221091000_event_registrations_unclaimed_email_index_concurrent.sql`
sha256 `20896098...3089` (standalone, CONCURRENTLY), with the read-only preflight/postflight above; and I pre-authorize their rollbacks (shas in section 7) in this order, only if a postflight
check fails. No data change, no app deploy included." (Deploying an app with the call is a separate release step.)
