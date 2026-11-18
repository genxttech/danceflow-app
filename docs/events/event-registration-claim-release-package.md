# Release package: PROD migrations for `claim_my_event_registrations()` (PR #604)

Status: **DOCS ONLY. Nothing here was applied, rehearsed or written on any hosted database.** 2026-11-17.
Scope: the two migrations merged by PR #604 (main `4a6a24914f2e915545b90e1a05831acfd05a6796`), their rollbacks, and the order
SQL -> app -> backport. Read-only checks were run on PROD (`hvsujyfbftfffxpfmlpb`) and DEV (`epdrtzcydvnoidwrepqz`) through
`danceflow-ops/sb.sh prod-read` / `dev-read` (read-only transaction, no writes).

Legend: **[V]** verified (command or code read this session), **[A]** assumed / not provable without a write.

**READ SECTION 13 (FINAL, main b0d51695) FIRST, then 12. Earlier note (2026-11-17): owner decision 1 added a third migration that excludes studio-sold rows; it supersedes the two-artifact apply plan below.**

Two separate owner gates are required (section 11; wording in 12.5): **product approval** of the behaviour, and **PROD SQL authorization** of the exact files.

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

---------------------------------------------------------------------------------------------------------------------

## 12. UPDATE 2026-11-17 -- owner decision 1: studio-sold rows are excluded (THREE artifacts). Where this section conflicts with sections 1, 4-7, 10 and 11, **this section wins**.

PR #627 (head `bf0e22cadf96f9c56cb9ebdcb79243b85363a0a2`, migration block after 20270221, Git-only) replaces the function with a **fail-closed allowlist**
`registration_source in ('public_event_page')`. [V] The CHECK `event_registrations_source_check` allows exactly five values on PROD and DEV
(`public_event_page, admin, import, organizer_portal, other`); column default `'public_event_page'`, NOT NULL.

| Source | Written by | Claimable | Reason |
|---|---|---|---|
| `public_event_page` | public cart checkout, Student app checkout, competition registration RPCs (these already set `user_id`) | **yes** | buyer-originated |
| `admin` | studio sell-tickets (`sell-tickets/actions.ts:596`) | no | owner rule: studio-sold, carries internal notes and a client link |
| `import` | no writer found in the repo [V code]; staff bulk import | no | studio-originated |
| `organizer_portal` | no writer found in the repo [V code] | no | **ambiguous, flagged to the owner** (organizer-created) |
| `other` | no writer found in the repo [V code] | no | **ambiguous, flagged to the owner** |
| NULL / any future value | -- | no | fail closed (proved in the suite by relaxing the constraints on a disposable stack) |

PROD today [V]: 26 rows `public_event_page` (claimable), 11 `admin` (not claimable); `source` (free-text, not used for the decision) also has 1 `public_registration`. No admin row has a `user_id`.

### 12.1 Artifacts (sha256 from git objects at PR #627 head `bf0e22ca`; **recompute at the merge commit on main before any apply**)

| Order | File (under `src/lib/supabase/migrations/`) | sha256 |
|---|---|---|
| 1 | `20270221090000_event_registration_claim_function.sql` (604 function, unrestricted) | `3c873d6f3840ca5da2cecaab524f33af3537f42643e1fc0cc5f937c55e4d08ec` |
| 2 | `20270222090000_event_registration_claim_buyer_sources_only.sql` (exclusion; create or replace) | `cd38c08e107894a7ab1d2e7977cf3a20f823bed6493ed4457a62eacb8ad49487` |
| 3 | `20270221091000_event_registrations_unclaimed_email_index_concurrent.sql` (standalone) | `20896098d897fd55fb60a3236bad817bb582cfb2809a44f5c4a32be415d03089` |
| rb of 2 | `rollback/20270222090000_event_registration_claim_buyer_sources_only_rollback.sql` (restores the 604 body) | `a9c5c04f6da292367730a5c6e926152f0a08101de063578053d3fb7afc9241c3` |
| rb of 1 | `rollback/20270221090000_event_registration_claim_function_rollback.sql` | `1bbe5338b32f22e0ea15202e7d629057747b92be4688ffaa313b90fcd4e032c3` |
| rb of 3 | `rollback/20270221091000_event_registrations_unclaimed_email_index_concurrent_rollback.sql` | `9ec58f3c4b838ef3adfbd863d257d805a77b2888ca7b46036327fc482f9650e3` |
| test | `sql-tests/test_T_claim_buyer_sources_only.sql` (37 checks, final definition) | `09379496a11a4cb153b2948b7668f3d2094446573904c7ae042da74cfd5c2a63` |

### 12.2 Decision: apply all three in git order, not only the final definition
Apply **function -> exclusion -> index**, back to back in one session, **before any app deploy**. Reason: the migration history on PROD must equal the git history (append-only; the 604 file is the
migration of record and skipping it would desync later tooling and rollbacks), the function migration is catalog-only, and there is **no caller** in the seconds between steps 1 and 2 (live
`release/website-embeds` has no call [V]; the main app with the call is not deployed until SQL is complete), so an unrestricted window has no way to be used. Applying only the final definition
was rejected: it needs a hand-edited, never-reviewed file or leaves history inconsistent. (Alternative the owner may choose instead: re-issue the 604 function file with the allowlist folded in,
before its first hosted apply; that needs a new PR and sha and was not done to keep the merged 604 files immutable.) The exclusion step is **mandatory**: if it fails or is skipped, stop; do not
apply the index or deploy any app.

### 12.3 Procedure deltas
- Preflight (`preflight.sql`) is unchanged except it should also be read for `unclaimed_counts.unclaimed_admin_sold` (PROD 11) as the number of rows the exclusion keeps out of reach.
- After step 1 and step 2 run `postflight.sql`: besides the earlier checks it now returns `function.has_source_allowlist` -- must be `true` after step 2 (and `false` only transiently after step 1) --
  and `source_distribution` (counts by `registration_source`, owned vs unowned). Gate: `has_source_allowlist=true`, `owned` unchanged from the preflight (0 on PROD), `max_updated_at` unchanged.
- `smoke_after_apply.sql` is unchanged (no-uid call returns 0). A read-only way to prove the filter without a write: `has_source_allowlist=true` plus `pg_get_functiondef` text contains `registration_source in ('public_event_page')`.
- Rollback order: **index -> exclusion -> function**. Rolling back the exclusion alone makes studio-sold rows claimable again (the exposure the owner excluded); do that only together with
  dropping the function or when the owner explicitly wants it. Claimed `user_id` values stay on any rollback (section 7 reasoning).
- Verified on a disposable stack: new suite 37/37; exclusion rolled back then the original 604 suite 34/34 again; re-applied then 37/37 again; index valid.

### 12.4 Exposure scan (owner request) -- findings
1. **A studio-sold row stays `user_id IS NULL`, so `event_registrations_self_select` (`user_id = auth.uid()`) and the attendee self-select (derived from it) can never match it** [V suite + policy text on PROD].
2. **Write paths that set `user_id` on `event_registrations`** [V code + migrations scan]: (a) Student app checkout insert (`user_id: user.id`, `public_event_page`); (b) competition registration RPCs (`p_actor_user_id`, source `public_event_page`);
   (c) the claim function; (d) account deletion sets it NULL. The studio paths (`sell-tickets/actions.ts` insert, settlement `UPDATE ... SET client_id`, webhook/payment updates, registrations/actions.ts updates) never assign `user_id`. A linked client account does **not** copy `user_id` onto its admin-sold rows (checked: `admin_rows_with_user_id = 0` on PROD and DEV).
3. **Policies a dancer can reach** [V on PROD]: `event_registrations_self_select` (public role, `user_id = auth.uid()`); attendees `event_registration_attendees_self_select` (via the registration) and `event_registration_attendees_self_insert` (insert allowed to authenticated; WITH CHECK not shown here -- open item to confirm in the column-restricted-read slice). `event_orders` is readable only by studio members (no dancer policy), so purchaser/order data is not exposed.
4. **Studio-only columns on rows a dancer can own today** [V PROD column list + code]: `event_registrations` row-level select returns ALL columns: `client_id`, `organizer_contact_id`, `stripe_checkout_session_id`, `stripe_payment_intent_id`, `terminal_hold_until`, `portal_user_id`, `source`, and `notes`.
   For an **app-bought** row the writers set `client_id = null`, `notes = buyerNotes` (buyer's own text), so those two carry nothing studio-internal. **But settlement later sets `client_id` on public-cart rows** (`UPDATE ... SET client_id` in the PAY-WH-1 settlement/G-02 lead capture): on PROD **15 of 26 `public_event_page` rows have a `client_id`** (a studio CRM record id) and 0 have notes. The attendee table exposes `checked_in_by` (staff user id), `ticket_token`, `ticket_code`. So **yes: an allowlisted, owned row can expose a studio CRM id, Stripe ids on the studio's connected account, an organizer contact id and a staff user id via a direct PostgREST query** (same as Student-app tickets today). The shipped apps select explicit safe columns and do not request these. No studio-internal free text (`notes`) is exposed for allowlisted rows (0 non-admin rows have notes on PROD [V]); staff can edit `notes` later, which is [A].
5. Conclusion: the exclusion removes the **studio-internal notes** exposure; the **column** exposure (CRM id, Stripe/staff ids) remains for allowlisted rows and for app-bought rows that already exist today, and is the scope of the column-restricted read (issue #628).

### 12.5 Owner gate wording (replaces 11b)
"I authorize applying to PROD, in this order and in one session before any app deploy, exactly these files at the merge commit of PR #627 (shas recomputed and attached by engineering): (1) `20270221090000_event_registration_claim_function.sql` `3c873d6f...d08ec`; (2) `20270222090000_event_registration_claim_buyer_sources_only.sql` `cd38c08e...9487`; (3) `20270221091000_event_registrations_unclaimed_email_index_concurrent.sql` `20896098...3089` (standalone); with the read-only pre/postflight; and I pre-authorize their rollbacks in the order index, exclusion, function only if a postflight check fails. I also confirm that `organizer_portal` and `other` registrations are NOT claimable. No data change; no app deploy included."

---------------------------------------------------------------------------------------------------------------------

## 13. FINAL 2026-11-18 -- package finalized at main `b0d516956fbc664c626188c73e96f84fb32497ee` (PRs #627 and #630 merged). Where this section conflicts with earlier ones, **this section wins**.

Docs only. Nothing applied. Every hash below was computed from git objects at `b0d51695` (not a working tree) and equals the value in 12.1 (the files did not change in the merge).

### 13.1 Final artifacts and exact order (files under `src/lib/supabase/migrations/`)

| Step | Apply file | sha256 | Rollback file (under `rollback/`) | rollback sha256 |
|---|---|---|---|---|
| 1 (transaction) | `20270221090000_event_registration_claim_function.sql` | `3c873d6f3840ca5da2cecaab524f33af3537f42643e1fc0cc5f937c55e4d08ec` | `20270221090000_event_registration_claim_function_rollback.sql` | `1bbe5338b32f22e0ea15202e7d629057747b92be4688ffaa313b90fcd4e032c3` |
| 2 (transaction) | `20270222090000_event_registration_claim_buyer_sources_only.sql` | `cd38c08e107894a7ab1d2e7977cf3a20f823bed6493ed4457a62eacb8ad49487` | `20270222090000_event_registration_claim_buyer_sources_only_rollback.sql` | `a9c5c04f6da292367730a5c6e926152f0a08101de063578053d3fb7afc9241c3` |
| 3 (standalone, CONCURRENTLY) | `20270221091000_event_registrations_unclaimed_email_index_concurrent.sql` | `20896098d897fd55fb60a3236bad817bb582cfb2809a44f5c4a32be415d03089` | `20270221091000_event_registrations_unclaimed_email_index_concurrent_rollback.sql` | `9ec58f3c4b838ef3adfbd863d257d805a77b2888ca7b46036327fc482f9650e3` |

Reference (not applied): `sql-tests/test_T_claim_my_event_registrations.sql` `6c54cc6ea958953416e559e9033fdad35da7905bfac02990de53ba6ea8d64404` (34 checks, step-1 definition);
`sql-tests/test_T_claim_buyer_sources_only.sql` `09379496a11a4cb153b2948b7668f3d2094446573904c7ae042da74cfd5c2a63` (37 checks, final definition).

**Apply order:** 1 -> postflight -> 2 -> postflight -> 3 -> postflight -> smoke, one session, before any app deploy. If step 2 fails or is skipped, stop (never apply 3, never deploy an app).
**Rollback order (only if a postflight check fails):** index (3) -> exclusion (2) -> function (1). Rolling back 2 alone re-opens studio-sold rows to claiming; do that only together with step 1's rollback.
Apply command shape: `bash C:/Users/mcurt/danceflow-ops/sb.sh prod-apply <file copied from git at b0d51695> <full sha256>` from a scratch directory.

### 13.2 Fresh read-only preflight (sb.sh; `preflight.sql` now also reports `source_distribution`, `source_check`, `of_which_allowlisted`)

| Check | PROD (`hvsujyfbftfffxpfmlpb`), 2026-11-18T00:11:09Z | DEV (`epdrtzcydvnoidwrepqz`), 2026-11-18T00:11:12Z |
|---|---|---|
| claim function present | **absent** | **absent** |
| unclaimed-email index present | **absent** | **absent** |
| exclusion (allowlist) present | absent (function absent) | absent (function absent) |
| prerequisites (`my_verified_email`, `record_email_proof_web`, `complete_email_binding`, `email_binding_status`, `verified_email_identities`, `auth_email_change_markers`, `auth.sessions`) | all present | all present |
| `my_verified_email` | security definer, owner postgres, `search_path=""`, authenticated exec yes, anon no | same |
| invalid indexes on `event_registrations` | 0 | 0 |
| `event_registrations_source_check` | exactly `public_event_page, admin, import, organizer_portal, other` | same |
| registrations total / unclaimed / **owned** | 37 / 37 / **0** | 35 / 21 / 14 (all `public_event_page`, app-bought) |
| by `registration_source` (total, owned) | `admin` 11 (0), `public_event_page` 26 (0) | `admin` 2 (0), `public_event_page` 33 (14) |
| unclaimed order-backed / distinct emails | 26 / 24 | 19 / 9 |
| table size | 312 kB | 376 kB |
| bound identities | 3 | 0 |
| rows matching a bound identity now | **0** (0 allowlisted, 0 admin) | 0 |
| rows whose email equals any existing account email (info only; a claim needs a bound proof) | 10 rows / 5 accounts | 11 rows / 2 accounts |
| `event_registrations` triggers (all enabled) | `set_event_registrations_updated_at`, `trg_set_updated_at_event_registrations`, `sync_competition_entries_from_registration`, `trg_enforce_event_ticket_capacity_holds`, `trg_event_registrations_stripe_identity_guard`, `trg_paywh1_guard_order_registration_writes` | same |
| `self_select` policy | `(user_id = auth.uid())` | same |

Meaning: applying the three files changes **no row** on PROD (nothing calls the function until an app does), and the first claim happens only after a bound user signs in on a build that calls it.
The apply gate stays: `owned = 0` and `max_updated_at` unchanged after each step.

### 13.3 Version collisions and PROD history [V]
- At `b0d51695`: every migration version under `src/lib/supabase/migrations/` listed and `uniq -d` over the 14-digit prefixes -> **no duplicates**. G-02 is now `20270219100000` (PR #630, not applied anywhere).
- 20270219090000 is Twilio's `twilio_price_request_sweep` only: `tw4_price_sweep_expired()` exists on PROD (applied 2026-11-17T08:49:16Z per `ops.log`, sha `13d9d569...faed`). PROD has **no** `supabase_migrations` schema (applies are logged in `ops.log`, not in a history table); G-02's column, constraint and flag logic are absent on both hosts.

### 13.4 Owner decisions (one remaining)
Product approval was given (Option A; decision 1: studio-sold excluded). The one remaining decision is the **PROD SQL authorization** in 13.6 (exact files and hashes), including the fallback in 13.5. It also records that `organizer_portal` and `other` are **not claimable** (the allowlist is `public_event_page` only; NULL and any future value are not claimable either).
Not required for this authorization, tracked elsewhere: column-restricted read (issue #628), backport to `release/website-embeds`, app deploy (separate release step).

### 13.5 CREATE INDEX CONCURRENTLY fallback [A]
Whether `supabase db query -f` runs the standalone file inside an implicit transaction is unproven. If step 3 fails with SQLSTATE `25001`, **nothing is created** and steps 1-2 stay valid (the index is performance-only; the table is ~312 kB). Wording to include in the authorization:
"If step 3 fails with 25001, I authorize engineering to prepare (not apply) a new plain `create index if not exists` file for `public.event_registrations_unclaimed_email_idx` through a PR, and I will authorize its sha256 separately."
Engineering does not improvise a different statement on PROD.

### 13.6 Ready-to-paste owner authorization (PROD SQL)
"I authorize applying to PROD (`hvsujyfbftfffxpfmlpb`), in this order, in one session, **before any app deploy**, exactly these files taken from main `b0d516956fbc664c626188c73e96f84fb32497ee`:
(1) `20270221090000_event_registration_claim_function.sql` sha256 `3c873d6f3840ca5da2cecaab524f33af3537f42643e1fc0cc5f937c55e4d08ec`;
(2) `20270222090000_event_registration_claim_buyer_sources_only.sql` sha256 `cd38c08e107894a7ab1d2e7977cf3a20f823bed6493ed4457a62eacb8ad49487`;
(3) `20270221091000_event_registrations_unclaimed_email_index_concurrent.sql` sha256 `20896098d897fd55fb60a3236bad817bb582cfb2809a44f5c4a32be415d03089` (standalone).
Engineering runs the read-only `preflight.sql` before, and `postflight.sql` after each step; it stops without applying the next step if `owned` changes, `has_source_allowlist` is not true after step 2, or the index is invalid.
I pre-authorize these rollbacks, in the order index, exclusion, function, only if a postflight check fails: (3) `20270221091000_..._rollback.sql` sha256 `9ec58f3c4b838ef3adfbd863d257d805a77b2888ca7b46036327fc482f9650e3`; (2) `20270222090000_..._rollback.sql` sha256 `a9c5c04f6da292367730a5c6e926152f0a08101de063578053d3fb7afc9241c3`; (1) `20270221090000_..._rollback.sql` sha256 `1bbe5338b32f22e0ea15202e7d629057747b92be4688ffaa313b90fcd4e032c3`.
I confirm `organizer_portal` and `other` registrations are NOT claimable. If step 3 fails with 25001, the fallback in section 13.5 applies. No data change; no app deploy included."

### 13.7 Post-apply verification plan (disposable stack only; no PROD writes)
1. PROD read-only: `postflight.sql` -> function present, `has_source_allowlist=true`, grants as in section 6, index valid, `owned = 0`, `max_updated_at` unchanged; `smoke_after_apply.sql` -> 0 / null uid.
2. Student device/HTTP claim check on a **disposable iso-qa stack** (the Student session's `--claim` / `--api-check` harness, one stack at a time, android-release rules): a bound user with a matching `public_event_page` registration sees it in the wallet and `/account`, a second call returns 0; an `admin` row with the same email stays unclaimed; an anon call is denied; a call without a JWT errors.
3. After the app deploy, the first natural claim is visible only as `owned > 0` in a read-only postflight, and the same user sees the ticket. Engineering writes nothing to PROD.
